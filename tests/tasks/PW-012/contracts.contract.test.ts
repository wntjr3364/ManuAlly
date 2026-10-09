// PW-012 — TST-012A/B at the contract boundary: edit_proposal v2 and the model-output contract
// agree with editor-core; anything a model must not decide (positions, ids, approvals) is refused.
import { describe, expect, test } from 'vitest';
import * as core from '../../../packages/editor-core/src/index.ts';
import { validateAiReplacement, validateEditProposal, type EditProposalV2 } from '../../../packages/contracts/src/index.ts';
import { ID, REPLACEMENTS, manuscript } from './fixtures.ts';

const HANDLE = '00000000-0000-4000-8000-0000000000f1';
const ai = (over: Record<string, unknown> = {}) => ({ schema_version: 1, selection_handle_id: HANDLE, outcome: 'replacement', replacement: [{ type: 'text', text: 'x' }], ...over });

async function proposalFor(replacement: unknown[]): Promise<EditProposalV2> {
  const doc = core.parseDocument(manuscript, core.EDITOR_SCHEMA_VERSION);
  const snap = await core.snapshotSelection(doc, { blockId: ID.cite, from: 0, to: 8 });
  return {
    schema_version: 2, proposal_id: crypto.randomUUID(), paper_id: crypto.randomUUID(), document_id: crypto.randomUUID(),
    base_revision_id: crypto.randomUUID(), outline_revision_id: crypto.randomUUID(),
    operation: { type: 'replace_selection', selection_handle_id: HANDLE, block_id: snap.block_id, expected_block_hash: snap.expected_block_hash, selected_slice_hash: snap.selected_slice_hash, from: snap.from, to: snap.to, replacement: replacement as EditProposalV2['operation']['replacement'] },
    source_evidence_ids: [], checks: [{ check: 'scope', result: 'pass' }],
  };
}

describe('edit_proposal v2', () => {
  test('a proposal built from an editor-core selection snapshot is valid', async () => {
    const r = validateEditProposal(await proposalFor([{ type: 'text', text: 'was induced' }, { type: 'preserve_atom', atom_index: 0 }]));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  test('version 1 proposals, missing slice hashes, empty text and raw HTML items are refused', async () => {
    const good = await proposalFor([{ type: 'text', text: 'ok' }]);
    const cases: [string, unknown][] = [
      ['schema_version 1', { ...good, schema_version: 1 }],
      ['no selected_slice_hash', { ...good, operation: { ...good.operation, selected_slice_hash: undefined } }],
      ['empty text', { ...good, operation: { ...good.operation, replacement: [{ type: 'text', text: '' }] } }],
      ['raw html item', { ...good, operation: { ...good.operation, replacement: [{ type: 'html', html: '<b>x</b>' }] } }],
      ['negative atom index', { ...good, operation: { ...good.operation, replacement: [{ type: 'preserve_atom', atom_index: -1 }] } }],
      ['approval field', { ...good, approved_by: crypto.randomUUID() }],
    ];
    for (const [name, v] of cases) expect(validateEditProposal(JSON.parse(JSON.stringify(v))).ok, name).toBe(false);
  });

  test('every replacement editor-core builds is contract-valid, and contract-invalid content is refused by editor-core too', async () => {
    const doc = core.parseDocument(manuscript, core.EDITOR_SCHEMA_VERSION);
    for (const c of REPLACEMENTS) {
      const { node } = core.findBlock(doc, c.blockId);
      let built = true;
      try {
        core.buildReplacement(c.replacement, core.atomNodesIn(node, c.from, c.to));
      } catch {
        built = false;
      }
      const contract = validateAiReplacement(ai({ replacement: c.replacement })).ok;
      if (built) expect(contract, c.name).toBe(true);
      if (!contract) expect(built, c.name).toBe(false);
    }
  });
});

describe('ai_replacement v1 (model output)', () => {
  test('a model cannot send positions, block ids, hashes, approvals or verification', () => {
    for (const extra of [{ from: 0 }, { to: 5 }, { block_id: ID.plain }, { expected_block_hash: 'a'.repeat(64) }, { approved_by: crypto.randomUUID() }, { verified: true }, { mode: 'unguarded' }]) {
      expect(validateAiReplacement(ai(extra)).ok, JSON.stringify(extra)).toBe(false);
    }
    expect(validateAiReplacement(ai()).ok).toBe(true);
  });

  test('needs_evidence lists what is missing and carries no replacement; no_change carries nothing', () => {
    expect(validateAiReplacement(ai({ outcome: 'needs_evidence', replacement: undefined, missing: ['n per group for Fig. 2b'] })).ok).toBe(true);
    expect(validateAiReplacement(ai({ outcome: 'needs_evidence', replacement: undefined })).ok).toBe(false);
    expect(validateAiReplacement(ai({ outcome: 'needs_evidence', missing: ['x'] })).ok).toBe(false);
    expect(validateAiReplacement(ai({ outcome: 'no_change', replacement: undefined })).ok).toBe(true);
    expect(validateAiReplacement(ai({ outcome: 'replacement', replacement: undefined })).ok).toBe(false);
  });
});
