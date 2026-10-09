// Comment anchors (spec 04 "Comment / Highlight"): a comment points at text in one block, recorded as
// block id, block-relative positions, the quote (one U+FFFC per inline atom, plus the atoms' identity)
// and a little text before and after it. Against a later revision the anchor is ATTACHED only when its
// place is certain:
//   * exactly one occurrence of the quote (same atoms) has the recorded surroundings, or
//   * none has them, but exactly one occurrence still has the text right before or right after it
//     (NEAR characters) as recorded — e.g. a small edit on one side of the quote. A side counts only
//     if it was unique when the comment was made (parallel sentences share their near text).
// A quote that merely appears again elsewhere in the paragraph is not evidence.
// Otherwise it is ORPHANED (text changed or deleted, block gone, or several equal candidates). It is
// never moved to another block or to merely similar text.
import { canonicalJson, type parseDocument } from '@pw/editor-core';

type PMNode = ReturnType<typeof parseDocument>;
export const CONTEXT = 32; // characters of surroundings kept on each side
const NEAR = 12; // characters next to the quote that must still match when the full surroundings do not
const ATOM = '￼';

export type AtomSig = { type: string; [attr: string]: unknown };
export interface Anchor { block_id: string; from: number; to: number; quote: string; prefix: string; suffix: string; atoms: AtomSig[]; near: { before: boolean; after: boolean } }
export type Resolved =
  | { state: 'ATTACHED'; block_id: string; from: number; to: number; moved: boolean }
  | { state: 'ORPHANED'; reason: 'BLOCK_MISSING' | 'TEXT_CHANGED' | 'AMBIGUOUS' };

// the block's text with one placeholder per inline atom, so index i is position i
export function flatBlock(node: PMNode): string {
  let s = '';
  node.forEach((child) => { s += child.isText ? child.text! : ATOM; });
  return s;
}

// identity of each inline atom in [from, to), in order (a placeholder alone matches any atom)
export function atomsBetween(node: PMNode, from: number, to: number): AtomSig[] {
  const out: AtomSig[] = [];
  let pos = 0;
  node.forEach((child) => {
    const size = child.isText ? child.text!.length : 1;
    if (!child.isText && pos >= from && pos < to) out.push({ type: child.type.name, ...child.attrs });
    pos += size;
  });
  return out;
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
  const quote = flat.slice(from, to);
  const prefix = flat.slice(Math.max(0, from - CONTEXT), from);
  const suffix = flat.slice(to, to + CONTEXT);
  const atoms = atomsBetween(node, from, to);
  // which near side identifies this occurrence among the equal ones at the time of the comment
  const occ = occurrences(node, flat, quote, atoms);
  const near = {
    before: occ.filter((i) => nearBefore(flat, i, prefix)).length === 1,
    after: occ.filter((i) => nearAfter(flat, i, quote.length, suffix)).length === 1,
  };
  return { block_id: blockId, from, to, quote, prefix, suffix, atoms, near };
}

const sameAtomList = (x: readonly AtomSig[], y: readonly AtomSig[]) => canonicalJson(x) === canonicalJson(y); // key order from jsonb differs
function occurrences(node: PMNode, flat: string, quote: string, atoms: readonly AtomSig[]): number[] {
  const at: number[] = [];
  for (let i = flat.indexOf(quote); i >= 0; i = flat.indexOf(quote, i + 1)) if (sameAtomList(atomsBetween(node, i, i + quote.length), atoms)) at.push(i);
  return at;
}
// the NEAR characters right before / after the occurrence equal the recorded ones (a block edge counts as text)
const nearBefore = (flat: string, i: number, prefix: string) => {
  const t = prefix.slice(-NEAR);
  return t ? flat.slice(Math.max(0, i - t.length), i) === t : i === 0;
};
const nearAfter = (flat: string, i: number, len: number, suffix: string) => {
  const t = suffix.slice(0, NEAR);
  return t ? flat.slice(i + len, i + len + t.length) === t : i + len === flat.length;
};

export function resolveAnchor(doc: PMNode, a: Anchor): Resolved {
  const node = blockById(doc, a.block_id);
  if (!node) return { state: 'ORPHANED', reason: 'BLOCK_MISSING' };
  const flat = flatBlock(node);
  const len = a.quote.length;
  const at = occurrences(node, flat, a.quote, a.atoms ?? []);
  if (at.length === 0) return { state: 'ORPHANED', reason: 'TEXT_CHANGED' };
  const inContext = at.filter((i) => flat.slice(Math.max(0, i - a.prefix.length), i) === a.prefix && flat.slice(i + len, i + len + a.suffix.length) === a.suffix);
  // the text right next to the quote on a side that was unique when the comment was made
  const sides = a.near ?? { before: false, after: false };
  const near = at.filter((i) => (sides.before && nearBefore(flat, i, a.prefix)) || (sides.after && nearAfter(flat, i, len, a.suffix)));
  let i: number;
  if (inContext.length === 1) i = inContext[0]!;
  else if (inContext.length > 1) return { state: 'ORPHANED', reason: 'AMBIGUOUS' };
  else if (near.length === 1) i = near[0]!;
  else return { state: 'ORPHANED', reason: near.length > 1 || at.length > 1 ? 'AMBIGUOUS' : 'TEXT_CHANGED' };
  return { state: 'ATTACHED', block_id: a.block_id, from: i, to: i + len, moved: i !== a.from };
}
