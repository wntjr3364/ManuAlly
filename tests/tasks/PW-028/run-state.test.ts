// PW-028 — run labels come only from the stored job row; "finished" names what finished.
import { describe, expect, test } from 'vitest';
import { aiRuns, isActive, statusLabel } from '../../../apps/web/src/features/runs/run-state.ts';

describe('run labels', () => {
  test('each stored status has one label; success says what finished and that nothing was applied', () => {
    expect(statusLabel({ status: 'CANCELLED', result: null })).toBe('취소됨 — 취소 뒤 결과는 반영되지 않음'); // not "결과 없음": a proposal made before the stop stays
    expect(statusLabel({ status: 'SUCCEEDED', result: { kind: 'proposal' } })).toBe('제안 준비됨 — 적용은 원고에서 따로');
    expect(statusLabel({ status: 'SUCCEEDED', result: { kind: 'answer' } })).toBe('답변 완료 — 원고는 바뀌지 않음');
    expect(statusLabel({ status: 'STALE', result: null })).toMatch(/결과 없음/);
    for (const s of ['QUEUED', 'RUNNING', 'WAITING_QUOTA', 'WAITING_AUTH', 'WAITING_BUDGET', 'WAITING_USER']) expect(isActive({ status: s }), s).toBe(true);
    for (const s of ['SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE']) expect(isActive({ status: s }), s).toBe(false);
  });
  test('only AI runs are listed (exports and other jobs are not)', () => {
    const row = (intent: string) => ({ id: intent, intent, status: 'QUEUED', attempts: 0, last_error: null, result: null, created_at: '', finished_at: null });
    expect(aiRuns([row('ask_selection'), row('export'), row('revise_selection')]).map((r) => r.id)).toEqual(['ask_selection', 'revise_selection']);
  });
});
