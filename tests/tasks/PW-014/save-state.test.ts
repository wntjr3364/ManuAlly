// PW-014 — TST-014B (client side): "저장됨" appears only after the server acknowledged exactly the
// content on screen; failures and conflicts keep the editor in an unsaved state.
import { describe, expect, test } from 'vitest';
import { initialSaveState, saveLabel, saveReducer, isUnsaved, type SaveState } from '../../../apps/web/src/features/paper/save-state.ts';

const run = (...actions: Parameters<typeof saveReducer>[1][]) => actions.reduce<SaveState>((s, a) => saveReducer(s, a), initialSaveState('rev-0'));

describe('save state', () => {
  test('a fresh document is saved; an edit makes it unsaved', () => {
    expect(isUnsaved(run())).toBe(false);
    const s = run({ type: 'edit' });
    expect(s.status).toBe('dirty');
    expect(isUnsaved(s)).toBe(true);
    expect(saveLabel(s)).not.toMatch(/저장됨/);
  });

  test('only the acknowledgement of the latest edit shows 저장됨', () => {
    let s = run({ type: 'edit' }, { type: 'saveStart' });
    expect(s.status).toBe('saving');
    expect(saveLabel(s)).not.toMatch(/저장됨/);
    const sent = s.inFlight!;
    s = saveReducer(s, { type: 'saveOk', version: sent, headRevisionId: 'rev-1' });
    expect(s.status).toBe('saved');
    expect(saveLabel(s)).toMatch(/저장됨/);
    expect(s.headRevisionId).toBe('rev-1');
  });

  test('typing while a save is in flight keeps the document unsaved after the acknowledgement', () => {
    let s = run({ type: 'edit' }, { type: 'saveStart' });
    const sent = s.inFlight!;
    s = saveReducer(s, { type: 'edit' });
    s = saveReducer(s, { type: 'saveOk', version: sent, headRevisionId: 'rev-1' });
    expect(s.status).toBe('dirty');
    expect(s.headRevisionId).toBe('rev-1'); // the next save is based on the new head
    expect(isUnsaved(s)).toBe(true);
  });

  test('a failed save is reported as not saved and keeps the edit; retry can then succeed', () => {
    let s = run({ type: 'edit' }, { type: 'saveStart' });
    s = saveReducer(s, { type: 'saveFailed', version: s.inFlight!, error: 'server error 500' });
    expect(s.status).toBe('failed');
    expect(saveLabel(s)).toMatch(/저장되지 않/);
    expect(isUnsaved(s)).toBe(true);
    s = saveReducer(s, { type: 'saveStart' });
    s = saveReducer(s, { type: 'saveOk', version: s.inFlight!, headRevisionId: 'rev-2' });
    expect(s.status).toBe('saved');
  });

  test('a conflict (someone else saved) is unsaved and not retried silently', () => {
    let s = run({ type: 'edit' }, { type: 'saveStart' });
    s = saveReducer(s, { type: 'saveFailed', version: s.inFlight!, error: 'stale head', conflict: true });
    expect(s.status).toBe('conflict');
    expect(saveLabel(s)).toMatch(/저장되지 않/);
  });

  test('a late acknowledgement of an older save cannot mark newer content saved', () => {
    let s = run({ type: 'edit' }, { type: 'saveStart' });
    const first = s.inFlight!;
    s = saveReducer(s, { type: 'saveFailed', version: first, error: 'timeout' });
    s = saveReducer(s, { type: 'edit' });
    s = saveReducer(s, { type: 'saveOk', version: first, headRevisionId: 'rev-x' });
    expect(s.status).not.toBe('saved');
  });
});
