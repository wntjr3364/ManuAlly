// Runs every PW-012 fixture through an editor-core instance and returns plain JSON.
// The same file is executed in Node (server) and, transpiled, in Chromium (browser); TST-012A
// compares the two outputs for exact equality.
import type * as EditorCore from '../../../packages/editor-core/src/index.ts';
import { BOUNDARIES, ID, REPLACEMENTS, SELECTIONS, manuscript } from './fixtures.ts';

type Core = typeof EditorCore;

export async function fixtureReport(core: Core) {
  const v = core.validateDocument(manuscript, core.EDITOR_SCHEMA_VERSION);
  if (!v.ok) return { valid: false, errors: v.errors };
  const doc = v.doc;
  const blocks: Record<string, { hash: string; boundaries: number[] | null }> = {};
  for (const id of [...Object.keys(BOUNDARIES), ID.table]) {
    const { node } = core.findBlock(doc, id);
    blocks[id] = { hash: await core.blockHash(node), boundaries: node.isTextblock ? core.graphemeBoundaries(node) : null };
  }
  const selections: Record<string, unknown> = {};
  for (const s of SELECTIONS) {
    try {
      selections[s.name] = { ok: await core.snapshotSelection(doc, s) };
    } catch (e) {
      selections[s.name] = { error: (e as { code?: string }).code ?? String(e) };
    }
  }
  const replacements: Record<string, unknown> = {};
  for (const r of REPLACEMENTS) {
    const { node } = core.findBlock(doc, r.blockId);
    try {
      const nodes = core.buildReplacement(r.replacement, core.atomNodesIn(node, r.from, r.to));
      replacements[r.name] = { ok: nodes.map((n) => n.toJSON()) };
    } catch (e) {
      replacements[r.name] = { error: (e as { code?: string }).code ?? String(e) };
    }
  }
  return { valid: true, docHash: await core.hashJson(doc.toJSON()), blocks, selections, replacements };
}
