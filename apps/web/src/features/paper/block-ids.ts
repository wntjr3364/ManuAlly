// Stable block ids (PW-012 contract: blocks are addressed by id only). After every change the ids are
// reconciled: a block that existed before keeps its id wherever it moved (mapped through the change),
// even if a command dropped the attribute (setBlockType); a copy or a newly created block gets a fresh
// id. Positions and STALE checks of later AI proposals rely on this.
import { getSchema } from '@tiptap/core';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import type { Node as PMNode } from '@tiptap/pm/model';
import { editorExtensions, setBlockIdReconciler } from './editor-extensions.ts';

export type { EditorState, Transaction };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const BLOCK_TYPES = ['paragraph', 'heading'];
export const editorSchema = getSchema(editorExtensions);
export const createEditorState = (doc: PMNode) => EditorState.create({ schema: editorSchema, doc });

// Returns a transaction that fixes the ids in `state`, or null when nothing needs fixing.
export function reconcileBlockIds(oldDoc: PMNode, state: EditorState, transactions: readonly Transaction[]): Transaction | null {
  const mapping = new Mapping(transactions.flatMap((t) => t.mapping.maps));
  // A block whose start survived claims its new position first. A block that was replaced in place
  // (setBlockType reports its start as deleted while the block is still there) claims its position
  // only if no surviving block does — a block deleted outright never takes its neighbour's id.
  const claims = new Map<number, string>();
  const replaced: [number, string][] = [];
  oldDoc.forEach((node, offset) => {
    const id = node.attrs.id as unknown;
    if (!BLOCK_TYPES.includes(node.type.name) || typeof id !== 'string' || !UUID.test(id)) return;
    // follow the first position inside the block (not its start) and claim the top-level block that
    // now contains it: Enter at the very start leaves the id with the text, content inserted before
    // the block pushes it along, and text typed at its start stays in the same block
    const r = mapping.mapResult(offset + 1, 1);
    const $p = state.doc.resolve(Math.min(r.pos, state.doc.content.size));
    const at = $p.depth >= 1 ? $p.before(1) : -1;
    if (at < 0) return;
    if (r.deleted) replaced.push([at, id]);
    else if (!claims.has(at)) claims.set(at, id);
  });
  const claimed = new Set(claims.values());
  for (const [pos, id] of replaced) if (!claims.has(pos) && !claimed.has(id)) { claims.set(pos, id); claimed.add(id); }
  const blocks: { node: PMNode; offset: number }[] = [];
  state.doc.forEach((node, offset) => { if (BLOCK_TYPES.includes(node.type.name)) blocks.push({ node, offset }); });
  const used = new Set<string>();
  const want = new Map<number, string>();
  // 1) blocks that existed before keep their id
  for (const b of blocks) {
    const id = claims.get(b.offset);
    if (id && !used.has(id)) { want.set(b.offset, id); used.add(id); }
  }
  // 2) other blocks keep their own valid, unused id; otherwise they get a fresh one
  for (const b of blocks) {
    if (want.has(b.offset)) continue;
    const own = b.node.attrs.id as unknown;
    const id = typeof own === 'string' && UUID.test(own) && !used.has(own) && ![...claims.values()].includes(own) ? own : crypto.randomUUID();
    want.set(b.offset, id);
    used.add(id);
  }
  const tr = state.tr;
  let changed = false;
  for (const b of blocks) {
    const id = want.get(b.offset)!;
    if (b.node.attrs.id !== id) {
      tr.setNodeMarkup(b.offset, undefined, { ...b.node.attrs, id });
      changed = true;
    }
  }
  return changed ? tr.setMeta('addToHistory', false).setMeta('pw-ids', true) : null;
}

// wire into the editor's BlockIds plugin
setBlockIdReconciler(reconcileBlockIds);
