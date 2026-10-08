// PW-003 spike: selection handles and guarded replace_selection.
//
// Position contract (proposed for packages/editor-core):
// - from/to are ProseMirror positions relative to the start of a top-level textblock's content
//   (0 .. node.content.size). Text contributes its UTF-16 length, every inline atom exactly 1.
// - A position may not fall inside a surrogate pair or an extended grapheme cluster.
// - The block is addressed by its stable id only; a missing or duplicated id is refused.
// - expected_block_hash = sha256(canonical JSON of the block node); selected_slice_hash likewise
//   for the selected slice. Any change to the block before apply makes the proposal STALE.
import { createHash } from 'node:crypto';
import { Transform } from 'prosemirror-transform';

export class SelectionError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const ATOM_CHAR = '￼';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const blockHash = (node) => sha256(canonicalJson(node.toJSON()));
const sliceHash = (node, from, to) => sha256(canonicalJson(node.slice(from, to).content.toJSON() ?? []));

function findBlock(doc, blockId) {
  const hits = [];
  doc.forEach((node, offset) => { if (node.attrs.id === blockId) hits.push({ node, pos: offset }); });
  if (hits.length === 0) throw new SelectionError('BLOCK_NOT_FOUND', `no block with id ${blockId}`);
  if (hits.length > 1) throw new SelectionError('BLOCK_ID_DUPLICATE', `${hits.length} blocks share id ${blockId}`);
  return hits[0];
}

// Flattened text of a textblock where index i == ProseMirror content position i.
function flatten(node) {
  let flat = '';
  node.forEach((child) => { flat += child.isText ? child.text : ATOM_CHAR; });
  return flat;
}

export function blockText(doc, blockId) {
  return flatten(findBlock(doc, blockId).node).replaceAll(ATOM_CHAR, '');
}

function graphemeBoundaries(flat) {
  const set = new Set([flat.length]);
  for (const { index } of segmenter.segment(flat)) set.add(index);
  return set;
}

function checkPosition(flat, boundaries, p, label) {
  const hi = flat.charCodeAt(p - 1);
  const lo = flat.charCodeAt(p);
  if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) throw new SelectionError('SPLITS_SURROGATE_PAIR', `${label}=${p} splits a surrogate pair`);
  if (!boundaries.has(p)) throw new SelectionError('SPLITS_GRAPHEME', `${label}=${p} splits a grapheme cluster`);
}

function validateRange(node, from, to) {
  if (!node.isTextblock) throw new SelectionError('NOT_TEXTBLOCK', `block ${node.attrs.id} is a ${node.type.name}`);
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw new SelectionError('RANGE_OUT_OF_BOUNDS', 'positions must be integers');
  if (from > to) throw new SelectionError('RANGE_INVERTED', `from ${from} > to ${to}`);
  if (from < 0 || to > node.content.size) throw new SelectionError('RANGE_OUT_OF_BOUNDS', `range ${from}-${to} outside 0-${node.content.size}`);
  if (from === to) throw new SelectionError('EMPTY_SELECTION', 'empty selection');
  const flat = flatten(node);
  const boundaries = graphemeBoundaries(flat);
  checkPosition(flat, boundaries, from, 'from');
  checkPosition(flat, boundaries, to, 'to');
  return flat;
}

function atomsIn(node, from, to) {
  const atoms = [];
  node.nodesBetween(from, to, (child) => {
    if (child.type.name === 'citation') atoms.push({ type: 'citation', referenceId: child.attrs.referenceId });
    else if (!child.isText && child.isAtom && child.isInline) atoms.push({ type: child.type.name });
  });
  return atoms;
}

export function createSelectionHandle(doc, { blockId, from, to }) {
  const { node } = findBlock(doc, blockId);
  const flat = validateRange(node, from, to);
  return {
    block_id: blockId,
    expected_block_hash: blockHash(node),
    from,
    to,
    selected_slice_hash: sliceHash(node, from, to),
    quote: flat.slice(from, to).replaceAll(ATOM_CHAR, ''),
    atoms: atomsIn(node, from, to),
  };
}

const NUMBER_RE = /[-−]?\d+(?:[.,]\d+)*(?:[eE][-+]?\d+)?/g;
const numbersOf = (text) => (text.match(NUMBER_RE) || []).map((n) => n.replace('−', '-')).sort();
const sameMultiset = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

function buildReplacement(schema, replacement) {
  return replacement.map((item) => {
    if (item.type === 'text') {
      if (!item.text) throw new SelectionError('INVALID_REPLACEMENT', 'empty text node');
      return schema.text(item.text, (item.marks || []).map((m) => {
        if (!schema.marks[m]) throw new SelectionError('INVALID_REPLACEMENT', `unknown mark ${m}`);
        return schema.marks[m].create();
      }));
    }
    if (item.type === 'citation') return schema.nodes.citation.create({ referenceId: item.reference_id, locator: item.locator ?? null });
    throw new SelectionError('INVALID_REPLACEMENT', `unsupported replacement item ${item.type}`);
  });
}

const reject = (code, reason) => ({ status: 'REJECTED', code, reason });

// mode 'conservative' (default for AI proposals) protects citations, numbers and non-citation atoms.
// mode 'manual' is the user's own typing and only enforces the position/version contract.
export function applyReplaceSelection(doc, op, { mode = 'conservative' } = {}) {
  if (!op || op.type !== 'replace_selection') return reject('UNSUPPORTED_OPERATION', 'only replace_selection is allowed in the first slice');
  if (!op.block_id) return reject('BLOCK_ID_MISSING', 'operations must address a block id; text search is never used');
  let block;
  try {
    block = findBlock(doc, op.block_id);
  } catch (e) {
    return reject(e.code, e.message);
  }
  const { node, pos } = block;
  if (blockHash(node) !== op.expected_block_hash) return { status: 'STALE', code: 'BLOCK_CHANGED', reason: 'block changed since the selection was taken; regenerate from the latest text' };
  try {
    validateRange(node, op.from, op.to);
  } catch (e) {
    return reject(e.code, e.message);
  }
  if (op.selected_slice_hash && sliceHash(node, op.from, op.to) !== op.selected_slice_hash) return reject('SLICE_HASH_MISMATCH', 'selected content does not match the handle');

  let nodes;
  try {
    nodes = buildReplacement(doc.type.schema, op.replacement || []);
  } catch (e) {
    return reject(e.code, e.message);
  }

  if (mode === 'conservative') {
    const before = atomsIn(node, op.from, op.to);
    if (before.some((a) => a.type !== 'citation')) return reject('PROTECTED_ATOM', `selection contains ${before.filter((a) => a.type !== 'citation').map((a) => a.type).join(', ')}, which a text replacement cannot preserve`);
    const citeBefore = before.map((a) => a.referenceId);
    const citeAfter = nodes.filter((n) => n.type.name === 'citation').map((n) => n.attrs.referenceId);
    if (!sameMultiset(citeBefore, citeAfter)) return reject('CITATION_CHANGED', 'citations in the selection must be kept exactly');
    const numsBefore = numbersOf(node.textBetween(op.from, op.to, '', ''));
    const numsAfter = numbersOf(nodes.filter((n) => n.isText).map((n) => n.text).join(''));
    if (!sameMultiset(numsBefore, numsAfter)) return reject('NUMBERS_CHANGED', `numbers ${numsBefore.join(',')} became ${numsAfter.join(',')}`);
  }

  const start = pos + 1; // inside the block
  const tr = new Transform(doc);
  tr.replaceWith(start + op.from, start + op.to, nodes);
  tr.doc.check();
  return { status: 'APPLIED', doc: tr.doc, mapping: tr.mapping };
}
