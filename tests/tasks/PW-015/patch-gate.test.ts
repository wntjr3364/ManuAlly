// PW-015 — TST-015B: a change from outside the keyboard (an AI patch, PW-017) is never applied while
// an IME composition is in progress or while the editor is read-only.
import { describe, expect, test } from 'vitest';
import { applyExternalPatch } from '../../../apps/web/src/editor/patch-gate.ts';
import { createEditorState, editorSchema, type EditorState, type Transaction } from '../../../apps/web/src/features/paper/block-ids.ts';

const view = (composing: boolean, editable = true) => {
  let state: EditorState = createEditorState(editorSchema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: '00000000-0000-4000-8000-000000000001' }, content: [{ type: 'text', text: 'abc' }] }] }));
  return {
    composing,
    editable,
    get state() { return state; },
    dispatch(tr: Transaction) { state = state.apply(tr); },
  };
};

describe('external patch gate', () => {
  test('applies a patch when the user is not composing', () => {
    const v = view(false);
    const r = applyExternalPatch(v, (s) => s.tr.insertText('X', 1));
    expect(r).toEqual({ applied: true });
    expect(v.state.doc.textContent).toBe('Xabc');
  });

  test('refuses while an IME composition is in progress and leaves the document unchanged', () => {
    const v = view(true);
    let built = false;
    const r = applyExternalPatch(v, (s) => { built = true; return s.tr.insertText('X', 1); });
    expect(r).toEqual({ applied: false, code: 'COMPOSING' });
    expect(built).toBe(false);
    expect(v.state.doc.textContent).toBe('abc');
  });

  test('refuses on a read-only editor and when there is nothing to apply', () => {
    expect(applyExternalPatch(view(false, false), (s) => s.tr.insertText('X', 1))).toEqual({ applied: false, code: 'NOT_EDITABLE' });
    expect(applyExternalPatch(view(false), () => null)).toEqual({ applied: false, code: 'NO_CHANGE' });
    expect(applyExternalPatch(null, (s) => s.tr)).toEqual({ applied: false, code: 'NO_EDITOR' });
  });
});
