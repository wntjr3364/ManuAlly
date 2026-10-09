// PW-016 — selection target and frozen selection request (TST-016A / TST-016B, unit part).
import { describe, expect, test } from 'vitest';
import { selectionTarget } from '../../../apps/web/src/features/selection-chat/target.ts';
import { INTENTS, buildSelectionRequest, freezeSelection, intentAllowed } from '../../../apps/web/src/features/selection-chat/request.ts';
import { editorSchema } from '../../../apps/web/src/features/paper/block-ids.ts';
import { parseDocument, snapshotSelection } from '../../../packages/editor-core/src/index.ts';

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
const REF = '00000000-0000-4000-8000-0000000000f1';
const json = {
  type: 'doc',
  content: [
    { type: 'paragraph', attrs: { id: A }, content: [{ type: 'text', text: 'First sentence. Second sentence.' }] },
    { type: 'paragraph', attrs: { id: B }, content: [{ type: 'text', text: 'induced ' }, { type: 'citation', attrs: { referenceId: REF, locator: null } }, { type: 'text', text: ' a😀b' }] },
  ],
};
const doc = editorSchema.nodeFromJSON(json);
// absolute positions: paragraph A starts at 0, its text at 1; paragraph B starts at 34, its text at 35
const A_TEXT = 1;
const B_TEXT = 35;

describe('selection target', () => {
  test('an empty selection has no target (never the whole manuscript)', () => {
    expect(selectionTarget(doc, 5, 5)).toEqual({ kind: 'none' });
  });

  test('a range inside one paragraph targets that paragraph with block-relative positions', () => {
    const from = A_TEXT + 16;
    const to = A_TEXT + 31;
    expect(selectionTarget(doc, from, to)).toEqual({ kind: 'block', blockId: A, blockIndex: 0, blockType: 'paragraph', from: 16, to: 31, absFrom: from, absTo: to, quote: 'Second sentence' });
  });

  test('a range across paragraphs or the whole document is not a target', () => {
    expect(selectionTarget(doc, A_TEXT + 5, B_TEXT + 2)).toEqual({ kind: 'multi' });
    expect(selectionTarget(doc, 0, doc.content.size)).toEqual({ kind: 'multi' });
  });

  test('an atom inside the range is quoted as one placeholder', () => {
    const t = selectionTarget(doc, B_TEXT, B_TEXT + 9);
    expect(t).toMatchObject({ kind: 'block', blockId: B, from: 0, to: 9, quote: 'induced ￼' });
  });
});

describe('frozen selection request', () => {
  test('the snapshot equals what the server derives from the stored document', async () => {
    const target = selectionTarget(doc, A_TEXT + 16, A_TEXT + 31);
    if (target.kind !== 'block') throw new Error('target');
    const snap = await freezeSelection(json, target);
    const server = await snapshotSelection(parseDocument(json, 1), { blockId: A, from: 16, to: 31 });
    expect(snap).toEqual(server);
    expect(snap.quote).toBe('Second sentence');
  });

  test('a range that splits a character is refused with a reason', async () => {
    const target = selectionTarget(doc, B_TEXT + 11, B_TEXT + 12); // inside the emoji's surrogate pair
    if (target.kind !== 'block') throw new Error('target');
    await expect(freezeSelection(json, target)).rejects.toMatchObject({ code: 'SPLITS_SURROGATE_PAIR' });
  });

  test('the request keeps the frozen snapshot and base revision; the instruction is checked', async () => {
    const target = selectionTarget(doc, A_TEXT, A_TEXT + 15);
    if (target.kind !== 'block') throw new Error('target');
    const selection = await freezeSelection(json, target);
    const base = { documentId: 'doc-1', baseRevisionId: 'rev-1', selection };
    const req = buildSelectionRequest(base, 'concise', '  더 짧게  ');
    expect(req).toEqual({ ok: true, request: { document_id: 'doc-1', base_revision_id: 'rev-1', intent: 'concise', instruction: '더 짧게', selection } });
    expect(buildSelectionRequest(base, 'grammar', '')).toMatchObject({ ok: true });
    expect(buildSelectionRequest(base, 'ask', '   ')).toEqual({ ok: false, error: expect.stringMatching(/질문/) });
    expect(buildSelectionRequest(base, 'concise', 'x'.repeat(2001))).toEqual({ ok: false, error: expect.stringMatching(/2000/) });
    expect(buildSelectionRequest(base, 'delete_everything' as never, '')).toEqual({ ok: false, error: expect.any(String) });
  });

  test('before the outline is approved only questions and conservative edits are allowed (RFC-003)', () => {
    expect(Object.keys(INTENTS)).toEqual(['ask', 'grammar', 'concise', 'rewrite']);
    expect(intentAllowed('ask', false)).toBe(true);
    expect(intentAllowed('grammar', false)).toBe(true);
    expect(intentAllowed('concise', false)).toBe(true);
    expect(intentAllowed('rewrite', false)).toBe(false);
    expect(intentAllowed('rewrite', true)).toBe(true);
  });
});
