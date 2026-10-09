// PW-015 — TST-015B (client side): autosave never reports a failed save as saved, never saves in the
// middle of an IME composition, and a retry after a lost answer resends the identical request.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Autosave, type SaveRequest, type SendResult } from '../../../apps/web/src/editor/autosave.ts';
import { initialSaveState, saveLabel, saveReducer, type SaveAction, type SaveState } from '../../../apps/web/src/features/paper/save-state.ts';

interface Rig {
  auto: Autosave;
  sent: SaveRequest[];
  state: () => SaveState;
  labels: string[];
  setDoc: (text: string) => void;
  composing: { on: boolean };
  answer: (r: SendResult) => Promise<void>;
  invalid: string[][];
}

function rig(opts: { idleMs?: number; maxWaitMs?: number } = {}): Rig {
  let state = initialSaveState('rev-0');
  const labels: string[] = [];
  const sent: SaveRequest[] = [];
  const waiting: ((r: SendResult) => void)[] = [];
  let doc = '';
  const composing = { on: false };
  const invalid: string[][] = [];
  const auto = new Autosave({
    headRevisionId: 'rev-0',
    savedKey: JSON.stringify(''),
    idleMs: opts.idleMs ?? 1000,
    maxWaitMs: opts.maxWaitMs ?? 5000,
    retryMs: [2000, 4000],
    snapshot: () => (doc === 'INVALID' ? { invalid: ['bad'] } : { json: { text: doc }, key: JSON.stringify(doc) }),
    isComposing: () => composing.on,
    send: (req) => { sent.push(req); return new Promise<SendResult>((r) => waiting.push(r)); },
    dispatch: (a: SaveAction) => { state = saveReducer(state, a); labels.push(saveLabel(state)); },
    onInvalid: (e) => invalid.push(e),
  });
  return {
    auto, sent, labels, composing, invalid,
    state: () => state,
    setDoc: (t) => { doc = t; auto.edit(); },
    answer: async (r) => { waiting.shift()!(r); await vi.advanceTimersByTimeAsync(0); },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('autosave', () => {
  test('saves after typing pauses, and shows 저장됨 only after the server acknowledged it', async () => {
    const r = rig();
    r.setDoc('a');
    r.setDoc('ab');
    await vi.advanceTimersByTimeAsync(999);
    expect(r.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ json: { text: 'ab' }, expectedHead: 'rev-0', version: 2 });
    expect(r.state().status).toBe('saving');
    expect(r.labels.some((l) => l === '저장됨')).toBe(false);
    await r.answer({ ok: true, headRevisionId: 'rev-1' });
    expect(r.state().status).toBe('saved');
    expect(r.state().headRevisionId).toBe('rev-1');
  });

  test('continuous typing is still saved after the maximum wait', async () => {
    const r = rig({ idleMs: 1000, maxWaitMs: 3000 });
    for (let i = 0; i < 10; i++) { r.setDoc(`t${i}`); await vi.advanceTimersByTimeAsync(500); }
    expect(r.sent.length).toBeGreaterThanOrEqual(1);
    expect(r.sent[0]!.version).toBeLessThanOrEqual(7);
  });

  test('never saves while an IME composition is in progress; saves after it ends', async () => {
    const r = rig();
    r.composing.on = true;
    r.setDoc('ㅎ');
    r.setDoc('하');
    r.setDoc('한');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.sent).toHaveLength(0);
    r.auto.saveNow(); // Ctrl+S during composition waits too
    expect(r.sent).toHaveLength(0);
    expect(r.state().status).toBe('dirty');
    r.composing.on = false;
    r.auto.compositionEnded();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.json).toEqual({ text: '한' });
  });

  test('a failed save is never shown as saved, and is retried with the identical request', async () => {
    const r = rig();
    r.setDoc('v1');
    await vi.advanceTimersByTimeAsync(1000);
    const first = r.sent[0]!;
    await r.answer({ ok: false, kind: 'network', message: '네트워크 오류' });
    expect(r.state().status).toBe('failed');
    r.setDoc('v2'); // typing meanwhile does not change what is retried first
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]).toEqual(first);
    await r.answer({ ok: true, headRevisionId: 'rev-1' });
    expect(r.state().status).toBe('dirty'); // v1 stored, v2 still on screen only
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.sent[2]).toMatchObject({ json: { text: 'v2' }, expectedHead: 'rev-1' });
    await r.answer({ ok: true, headRevisionId: 'rev-2' });
    expect(r.state().status).toBe('saved');
    expect(r.labels.filter((l) => l === '저장됨')).toHaveLength(1);
  });

  test('server errors back off and keep retrying the same request; going online retries at once', async () => {
    const r = rig();
    r.setDoc('x');
    await vi.advanceTimersByTimeAsync(1000);
    await r.answer({ ok: false, kind: 'server', message: '서버 응답 500' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.sent).toHaveLength(2);
    await r.answer({ ok: false, kind: 'network', message: '오프라인' });
    await vi.advanceTimersByTimeAsync(3999);
    expect(r.sent).toHaveLength(2);
    r.auto.online();
    expect(r.sent).toHaveLength(3);
    expect(r.sent[2]).toEqual(r.sent[0]);
  });

  test('a conflict stops autosave: nothing is retried or overwritten', async () => {
    const r = rig();
    r.setDoc('mine');
    await vi.advanceTimersByTimeAsync(1000);
    await r.answer({ ok: false, kind: 'conflict', message: '409' });
    expect(r.state().status).toBe('conflict');
    r.setDoc('mine 2');
    r.auto.saveNow();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.sent).toHaveLength(1);
    expect(r.state().status).toBe('conflict');
  });

  test('a rejected save (invalid content) is not retried until the next edit', async () => {
    const r = rig();
    r.setDoc('bad?');
    await vi.advanceTimersByTimeAsync(1000);
    await r.answer({ ok: false, kind: 'rejected', message: '서버 응답 400' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.sent).toHaveLength(1);
    expect(r.state().status).toBe('failed');
    r.setDoc('good');
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.sent).toHaveLength(2);
  });

  test('content the editor itself rejects is not sent and stays unsaved', async () => {
    const r = rig();
    r.setDoc('INVALID');
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.sent).toHaveLength(0);
    expect(r.invalid).toEqual([['bad']]);
    expect(r.state().status).toBe('dirty');
  });

  test('typing back to the stored text needs no new revision', async () => {
    const r = rig();
    r.setDoc('a');
    r.setDoc('');
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.sent).toHaveLength(0);
    expect(r.state().status).toBe('saved');
  });

  test('only one request is in flight; edits during it are saved afterwards on the new head', async () => {
    const r = rig();
    r.setDoc('1');
    await vi.advanceTimersByTimeAsync(1000);
    r.setDoc('12');
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.sent).toHaveLength(1);
    await r.answer({ ok: true, headRevisionId: 'rev-1' });
    expect(r.state().status).toBe('dirty');
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.sent[1]).toMatchObject({ json: { text: '12' }, expectedHead: 'rev-1' });
  });

  test('dispose stops all timers', async () => {
    const r = rig();
    r.setDoc('a');
    r.auto.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.sent).toHaveLength(0);
  });
});
