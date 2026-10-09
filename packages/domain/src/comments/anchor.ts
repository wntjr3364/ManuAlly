// Comment anchors (spec 04 "Comment / Highlight"): a comment points at text in one block, recorded as
// block id, block-relative positions, the quote and a little text before and after it. Against a later
// revision the anchor is ATTACHED only when its place is certain:
//   * the block (same id) still holds the quote exactly once, or
//   * it holds it several times and exactly one of them has the recorded surroundings.
// Otherwise it is ORPHANED (text changed or deleted, block gone, or several equal candidates). It is
// never moved to another block or to merely similar text.
import type { parseDocument } from '@pw/editor-core';

type PMNode = ReturnType<typeof parseDocument>;
export const CONTEXT = 32; // characters of surroundings kept on each side
const ATOM = '￼';

export interface Anchor { block_id: string; from: number; to: number; quote: string; prefix: string; suffix: string }
export type Resolved =
  | { state: 'ATTACHED'; block_id: string; from: number; to: number; moved: boolean }
  | { state: 'ORPHANED'; reason: 'BLOCK_MISSING' | 'TEXT_CHANGED' | 'AMBIGUOUS' };

// the block's text with one placeholder per inline atom, so index i is position i
export function flatBlock(node: PMNode): string {
  let s = '';
  node.forEach((child) => { s += child.isText ? child.text! : ATOM; });
  return s;
}

function blockById(doc: PMNode, id: string): PMNode | null {
  let found: PMNode | null = null;
  doc.forEach((n) => { if (n.attrs.id === id) found = n; });
  return found;
}

export function makeAnchor(doc: PMNode, blockId: string, from: number, to: number): Anchor {
  const node = blockById(doc, blockId);
  if (!node) throw new Error('block not found');
  const flat = flatBlock(node);
  return { block_id: blockId, from, to, quote: flat.slice(from, to), prefix: flat.slice(Math.max(0, from - CONTEXT), from), suffix: flat.slice(to, to + CONTEXT) };
}

export function resolveAnchor(doc: PMNode, a: Anchor): Resolved {
  const node = blockById(doc, a.block_id);
  if (!node) return { state: 'ORPHANED', reason: 'BLOCK_MISSING' };
  const flat = flatBlock(node);
  const at: number[] = [];
  for (let i = flat.indexOf(a.quote); i >= 0; i = flat.indexOf(a.quote, i + 1)) at.push(i);
  if (at.length === 0) return { state: 'ORPHANED', reason: 'TEXT_CHANGED' };
  const len = a.quote.length;
  const inContext = at.filter((i) => flat.slice(Math.max(0, i - a.prefix.length), i) === a.prefix && flat.slice(i + len, i + len + a.suffix.length) === a.suffix);
  let i: number;
  if (inContext.length === 1) i = inContext[0]!;
  else if (inContext.length === 0 && at.length === 1) i = at[0]!; // only one such text left in the block
  else return { state: 'ORPHANED', reason: 'AMBIGUOUS' };
  return { state: 'ATTACHED', block_id: a.block_id, from: i, to: i + len, moved: i !== a.from };
}
