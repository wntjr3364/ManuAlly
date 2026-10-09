// Position contract (RFC-005, from the PW-003 spike):
// - from/to are ProseMirror positions relative to the start of a top-level textblock's content
//   (0 .. node.content.size). Text contributes its UTF-16 length, every inline atom exactly 1.
// - A position may not fall inside a surrogate pair or an extended grapheme cluster.
// - A block is addressed by its stable id only; a missing or duplicated id is refused, and text
//   search is never used to find a place.
// - expected_block_hash = sha256(canonical JSON of block.toJSON()); selected_slice_hash covers the
//   block id, the range and the selected content.
import type { Node as PMNode } from 'prosemirror-model';
import { canonicalJson, sha256Hex } from './hash.ts';

export type SelectionErrorCode =
  | 'BLOCK_ID_INVALID' | 'BLOCK_NOT_FOUND' | 'BLOCK_ID_DUPLICATE' | 'NOT_TEXTBLOCK' | 'RANGE_OUT_OF_BOUNDS' | 'RANGE_INVERTED' | 'EMPTY_SELECTION'
  | 'SPLITS_SURROGATE_PAIR' | 'SPLITS_GRAPHEME';

export class SelectionError extends Error {
  readonly code: SelectionErrorCode;
  constructor(code: SelectionErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

// One placeholder character per inline atom, so index i of the flattened string is position i.
const ATOM_CHAR = '￼';
// Grapheme segmentation is locale-independent; a fixed locale keeps browser and server identical.
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function findBlock(doc: PMNode, blockId: string): { node: PMNode; pos: number } {
  if (typeof blockId !== 'string' || !UUID.test(blockId)) throw new SelectionError('BLOCK_ID_INVALID', 'blocks are addressed by their lowercase UUID');
  const hits: { node: PMNode; pos: number }[] = [];
  doc.forEach((node, offset) => { if (node.attrs.id === blockId) hits.push({ node, pos: offset }); });
  if (hits.length === 0) throw new SelectionError('BLOCK_NOT_FOUND', `no block with id ${blockId}`);
  if (hits.length > 1) throw new SelectionError('BLOCK_ID_DUPLICATE', `${hits.length} blocks share id ${blockId}`);
  return hits[0]!;
}

function flatten(node: PMNode): string {
  let flat = '';
  node.forEach((child) => { flat += child.isText ? child.text! : ATOM_CHAR; });
  return flat;
}

// All positions in a textblock where a selection may start or end. Inline atoms are hard
// boundaries; each run of text between atoms (across mark changes) is segmented on its own.
export function graphemeBoundaries(node: PMNode): number[] {
  const set = new Set<number>([0, node.content.size]);
  let pos = 0;
  let run = '';
  let runStart = 0;
  const flush = () => {
    for (const { index } of segmenter.segment(run)) set.add(runStart + index);
    run = '';
  };
  node.forEach((child) => {
    if (child.isText) {
      if (!run) runStart = pos;
      run += child.text!;
      pos += child.text!.length;
    } else {
      flush();
      set.add(pos);
      pos += 1;
      set.add(pos);
    }
  });
  flush();
  return [...set].sort((a, b) => a - b);
}

export function blockText(doc: PMNode, blockId: string): string {
  return flatten(findBlock(doc, blockId).node).replaceAll(ATOM_CHAR, '');
}

export function validateRange(node: PMNode, from: unknown, to: unknown): void {
  if (!node.isTextblock) throw new SelectionError('NOT_TEXTBLOCK', `block ${String(node.attrs.id)} is a ${node.type.name}`);
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw new SelectionError('RANGE_OUT_OF_BOUNDS', 'positions must be integers');
  const f = from as number;
  const t = to as number;
  if (f > t) throw new SelectionError('RANGE_INVERTED', `from ${f} > to ${t}`);
  if (f < 0 || t > node.content.size) throw new SelectionError('RANGE_OUT_OF_BOUNDS', `range ${f}-${t} outside 0-${node.content.size}`);
  if (f === t) throw new SelectionError('EMPTY_SELECTION', 'empty selection');
  const flat = flatten(node);
  const boundaries = new Set(graphemeBoundaries(node));
  for (const [p, label] of [[f, 'from'], [t, 'to']] as const) {
    const hi = flat.charCodeAt(p - 1);
    const lo = flat.charCodeAt(p);
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) throw new SelectionError('SPLITS_SURROGATE_PAIR', `${label}=${p} splits a surrogate pair`);
    if (!boundaries.has(p)) throw new SelectionError('SPLITS_GRAPHEME', `${label}=${p} splits a grapheme cluster`);
  }
}

export const blockHash = (node: PMNode) => sha256Hex(canonicalJson(node.toJSON()));
export const sliceHash = (node: PMNode, from: number, to: number) =>
  sha256Hex(canonicalJson({ block_id: node.attrs.id, from, to, content: node.slice(from, to).content.toJSON() ?? [] }));

export type SelectionAtom =
  | { type: 'citation'; referenceId: string; locator: string | null }
  | { type: 'math_inline'; latex: string }
  | { type: 'figure_ref'; targetId: string };

export function atomsIn(node: PMNode, from: number, to: number): SelectionAtom[] {
  const atoms: SelectionAtom[] = [];
  node.nodesBetween(from, to, (child) => {
    if (child.isText || !child.isAtom || !child.isInline) return;
    if (child.type.name === 'citation') atoms.push({ type: 'citation', referenceId: child.attrs.referenceId, locator: child.attrs.locator ?? null });
    else if (child.type.name === 'math_inline') atoms.push({ type: 'math_inline', latex: child.attrs.latex });
    else atoms.push({ type: 'figure_ref', targetId: child.attrs.targetId });
  });
  return atoms;
}

export interface SelectionSnapshot {
  block_id: string;
  expected_block_hash: string;
  from: number;
  to: number;
  selected_slice_hash: string;
  quote: string;
  atoms: SelectionAtom[];
}

// What the browser sends when the user selects text and what the server re-derives and stores as a
// selection handle (the server adds handle id and base revision). Both sides must agree exactly.
export async function snapshotSelection(doc: PMNode, sel: { blockId: string; from: unknown; to: unknown }): Promise<SelectionSnapshot> {
  const { node } = findBlock(doc, sel.blockId);
  validateRange(node, sel.from, sel.to);
  const from = sel.from as number;
  const to = sel.to as number;
  return {
    block_id: sel.blockId,
    expected_block_hash: await blockHash(node),
    from,
    to,
    selected_slice_hash: await sliceHash(node, from, to),
    quote: flatten(node).slice(from, to).replaceAll(ATOM_CHAR, ''),
    atoms: atomsIn(node, from, to),
  };
}
