// PW-003 spike: selection handles and guarded replace_selection.
//
// Position contract (proposed for packages/editor-core):
// - from/to are ProseMirror positions relative to the start of a top-level textblock's content
//   (0 .. node.content.size). Text contributes its UTF-16 length, every inline atom exactly 1.
// - A position may not fall inside a surrogate pair or an extended grapheme cluster.
// - The block is addressed by its stable id only; a missing or duplicated id is refused.
// - expected_block_hash = sha256(canonical JSON of the block node); selected_slice_hash likewise
//   for the selected slice together with its block id and range. Any change to the block before
//   apply makes the proposal STALE.
// - AI proposals never carry their own range: they reference a server-stored selection handle,
//   are applied at most once (proposal id), and always go through the conservative guard.
import { createHash, randomUUID } from 'node:crypto';
import { Fragment } from 'prosemirror-model';
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
const sliceHash = (node, from, to) => sha256(canonicalJson({ block_id: node.attrs.id, from, to, content: node.slice(from, to).content.toJSON() ?? [] }));

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
    if (child.type.name === 'citation') atoms.push({ type: 'citation', referenceId: child.attrs.referenceId, locator: child.attrs.locator });
    else if (!child.isText && child.isAtom && child.isInline) atoms.push({ type: child.type.name });
  });
  return atoms;
}

function atomNodesIn(node, from, to) {
  const out = [];
  node.nodesBetween(from, to, (child) => { if (!child.isText && child.isAtom && child.isInline) out.push(child); });
  return out;
}

export function createSelectionHandle(doc, { blockId, from, to }) {
  const { node } = findBlock(doc, blockId);
  const flat = validateRange(node, from, to);
  return {
    handle_id: randomUUID(),
    block_id: blockId,
    expected_block_hash: blockHash(node),
    from,
    to,
    selected_slice_hash: sliceHash(node, from, to),
    quote: flat.slice(from, to).replaceAll(ATOM_CHAR, ''),
    atoms: atomsIn(node, from, to),
  };
}

// ---------- conservative guard ----------
// Facts that a grammar/concision edit must not change. Heuristic, English-oriented; the
// FactRecord-based scientific gate (PW-043) is the authoritative check.
const UNIT = String.raw`%|[µμ]M|mM|nM|pM|M|mg|[µμ]g|ng|g|kg|mL|[µμ]L|L|°C|h|min|s|bp|kb|Mb|fold|×`;
const QUANTITY_RE = new RegExp(String.raw`(?:([<>≤≥=])\s*)?([-−]?\d+(?:[.,]\d+)*)(?:\s*-?\s*(${UNIT})(?![A-Za-z]))?`, 'g');
const NEGATION_RE = /\b(not|no|never|neither|nor|none|without|cannot|absence|absent|lack(?:ed|s|ing)?)\b|n't\b/gi;
const DIRECTION_RE = /\b(increase[sd]?|increasing|higher|greater|elevated|up-?regulated|enhanced|decrease[sd]?|decreasing|lower|reduced|down-?regulated|diminished|positive(?:ly)?|negative(?:ly)?)\b/gi;
const directionSign = (w) => (/^(increas|higher|greater|elevated|up|enhanced|positive)/i.test(w) ? '+' : '-');

// Inline items as {kind:'text', text, marks} | {kind:'atom', node}, in document order.
function itemsOf(nodes) {
  return nodes.map((n) => (n.isText ? { kind: 'text', text: n.text, marks: n.marks.map((m) => m.type.name).sort() } : { kind: 'atom', node: n }));
}

function facts(items) {
  const quantities = [];
  const marked = [];
  const citations = [];
  const otherAtoms = [];
  let prose = '';
  for (const it of items) {
    if (it.kind === 'text') {
      // quantities are tokenised per run so that 10 + superscript 5 differs from plain 105
      for (const m of it.text.matchAll(QUANTITY_RE)) quantities.push(`${m[1] || ''}${m[2].replace('−', '-')}${m[3] ? ' ' + m[3].replace('μ', 'µ') : ''}`);
      if (it.marks.length) marked.push(`${it.marks.join('+')}:${it.text}`);
      prose += it.text;
    } else if (it.node.type.name === 'citation') {
      const words = prose.match(/[\p{L}\p{N}]+(?=[^\p{L}\p{N}]*$)/u);
      citations.push({ id: it.node.attrs.referenceId, locator: it.node.attrs.locator ?? null, anchor: words ? words[0].toLowerCase() : '' });
      prose += ' ';
    } else {
      otherAtoms.push(canonicalJson(it.node.toJSON()));
      prose += ' ';
    }
  }
  const negations = [...prose.matchAll(NEGATION_RE)].map((m) => (m[1] || 'not').toLowerCase().replace(/^lack.*/, 'lack'));
  const directions = [...prose.matchAll(DIRECTION_RE)].map((m) => directionSign(m[1]));
  return { quantities, marked, citations, otherAtoms, negations, directions };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function conservativeGuard(beforeNodes, afterNodes) {
  const b = facts(itemsOf(beforeNodes));
  const a = facts(itemsOf(afterNodes));
  if (!same(b.otherAtoms, a.otherAtoms)) return reject('PROTECTED_ATOM', 'math/figure atoms must be preserved in order (use preserve_atom)');
  if (!same(b.citations.map((c) => [c.id, c.locator]), a.citations.map((c) => [c.id, c.locator]))) return reject('CITATION_CHANGED', 'citations and locators must be kept exactly, in order');
  if (!same(b.citations.map((c) => c.anchor), a.citations.map((c) => c.anchor))) return reject('CITATION_MOVED', 'each citation must stay after the same word');
  if (!same(b.marked, a.marked)) return reject('MARKS_CHANGED', `formatted runs changed: ${b.marked.join(' | ')} → ${a.marked.join(' | ')}`);
  if (!same(b.quantities, a.quantities)) return reject('NUMBERS_CHANGED', `quantities ${b.quantities.join(', ')} became ${a.quantities.join(', ')}`);
  if (!same(b.negations, a.negations)) return reject('NEGATION_CHANGED', `negations ${b.negations.join(',') || '∅'} became ${a.negations.join(',') || '∅'}`);
  if (!same(b.directions, a.directions)) return reject('DIRECTION_CHANGED', `direction words ${b.directions.join('') || '∅'} became ${a.directions.join('') || '∅'}`);
  return null;
}

function buildReplacement(schema, replacement, selectionAtoms) {
  const nodes = replacement.map((item) => {
    if (item.type === 'text') {
      if (!item.text) throw new SelectionError('INVALID_REPLACEMENT', 'empty text node');
      return schema.text(item.text, (item.marks || []).map((m) => {
        if (!schema.marks[m]) throw new SelectionError('INVALID_REPLACEMENT', `unknown mark ${m}`);
        return schema.marks[m].create();
      }));
    }
    if (item.type === 'citation') return schema.nodes.citation.create({ referenceId: item.reference_id, locator: item.locator ?? null });
    if (item.type === 'preserve_atom') {
      const atom = selectionAtoms[item.atom_index];
      if (!atom) throw new SelectionError('INVALID_REPLACEMENT', `no atom ${item.atom_index} in the selection`);
      return atom;
    }
    throw new SelectionError('INVALID_REPLACEMENT', `unsupported replacement item ${item.type}`);
  });
  // normalise like ProseMirror does (adjacent text runs with equal marks are joined)
  const fragment = Fragment.fromArray(nodes);
  const out = [];
  fragment.forEach((n) => out.push(n));
  return out;
}

const reject = (code, reason) => ({ status: 'REJECTED', code, reason });

function applyAt(doc, { block_id, expected_block_hash, from, to, selected_slice_hash, replacement }, { guard }) {
  if (!block_id) return reject('BLOCK_ID_MISSING', 'operations must address a block id; text search is never used');
  let block;
  try {
    block = findBlock(doc, block_id);
  } catch (e) {
    return reject(e.code, e.message);
  }
  const { node, pos } = block;
  if (blockHash(node) !== expected_block_hash) return { status: 'STALE', code: 'BLOCK_CHANGED', reason: 'block changed since the selection was taken; regenerate from the latest text' };
  try {
    validateRange(node, from, to);
  } catch (e) {
    return reject(e.code, e.message);
  }
  if (selected_slice_hash !== undefined && sliceHash(node, from, to) !== selected_slice_hash) return reject('SLICE_HASH_MISMATCH', 'selected content does not match the handle');
  let nodes;
  try {
    nodes = buildReplacement(doc.type.schema, replacement || [], atomNodesIn(node, from, to));
  } catch (e) {
    return reject(e.code, e.message);
  }
  if (guard) {
    const before = [];
    node.slice(from, to).content.forEach((n) => before.push(n));
    const problem = conservativeGuard(before, nodes);
    if (problem) return problem;
  }
  const start = pos + 1; // inside the block
  const tr = new Transform(doc);
  tr.replaceWith(start + from, start + to, nodes);
  tr.doc.check();
  return { status: 'APPLIED', doc: tr.doc, mapping: tr.mapping };
}

// Server-side store of selection handles taken from the user's real selection.
export class HandleStore {
  #handles = new Map();
  #consumed = new Set();
  register(handle) { this.#handles.set(handle.handle_id, handle); return handle; }
  get(id) { return this.#handles.get(id) ?? null; }
  consume(id) { this.#consumed.add(id); }
  isConsumed(id) { return this.#consumed.has(id); }
}

// AI proposals: range comes only from the stored handle, guard is mandatory, apply is at-most-once.
// Any mode/actor field in the proposal is ignored: the actor is decided by the server route.
export function applyAiProposal(doc, proposal, { handles, applied }) {
  if (!proposal?.proposal_id) return reject('PROPOSAL_ID_MISSING', 'proposal id required for idempotency');
  if (applied.has(proposal.proposal_id)) return { status: 'ALREADY_APPLIED', code: 'DUPLICATE_PROPOSAL' };
  const handle = proposal.selection_handle_id ? handles.get(proposal.selection_handle_id) : null;
  if (!handle) return reject('HANDLE_NOT_FOUND', 'proposal must reference a stored selection handle');
  if (handles.isConsumed(handle.handle_id)) return reject('HANDLE_CONSUMED', 'this selection was already changed; take a new selection');
  for (const k of ['block_id', 'from', 'to']) {
    if (proposal[k] !== undefined && proposal[k] !== handle[k]) return reject('HANDLE_RANGE_MISMATCH', `proposal ${k}=${proposal[k]} differs from the selection (${handle[k]})`);
  }
  const res = applyAt(doc, { ...handle, replacement: proposal.replacement }, { guard: true });
  if (res.status === 'APPLIED') {
    applied.add(proposal.proposal_id);
    handles.consume(handle.handle_id);
  }
  return res;
}

// The user's own typing: position/version contract only, no content guard.
export function applyUserEdit(doc, edit) {
  if (edit.expected_block_hash === undefined) return reject('EXPECTED_HASH_MISSING', 'user edits also carry the block hash they were based on');
  return applyAt(doc, edit, { guard: false });
}
