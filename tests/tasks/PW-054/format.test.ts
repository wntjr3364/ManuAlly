// PW-054 — how the run control panel words what it shows (spec 08 "웹 상태"). Unknown stays unknown (never
// 0, never a percentage); an estimate is called an estimate; a reset time that is not known is said so, with
// the next check; auto-resume is described as making a proposal only.
// TST-054B: unknown usage is never shown as 0 or a precise percentage; auto-resume is not an approval.
import { describe, expect, test } from 'vitest';
import { autoResumeText, checkpointText, contextText, waitText } from '../../../apps/web/src/features/run-control/format.ts';

describe('TST-054B: unknown is unknown, an estimate is an estimate', () => {
  test('an unknown context is "알 수 없음" — no 0, no percentage', () => {
    const t = contextText({ tokens: null, window: null, source: 'unknown', observed_at: null });
    expect(t).toBe('알 수 없음');
    expect(t).not.toMatch(/\d/);
  });
  test('a measured context gives the tokens, the window and the share; an estimate is rounded and called an estimate', () => {
    expect(contextText({ tokens: 141000, window: 200000, source: 'provider_reported', observed_at: '2026-10-10T00:00:00Z' })).toBe('141,000 / 200,000 토큰 (70.5%, 공급자 보고)');
    const e = contextText({ tokens: 141234, window: 200000, source: 'estimated', observed_at: '2026-10-10T00:00:00Z' });
    expect(e).toBe('약 141,000 / 200,000 토큰 (약 71%, 추정)');
    expect(e).not.toMatch(/\d+\.\d+%/);
  });
  test('without a known window there is no share', () => {
    expect(contextText({ tokens: 5000, window: null, source: 'provider_reported', observed_at: '2026-10-10T00:00:00Z' })).toBe('5,000 토큰 (창 크기 알 수 없음, 공급자 보고)');
    expect(contextText({ tokens: 5000, window: null, source: 'provider_reported', observed_at: null })).not.toMatch(/%/);
  });
  test('a wait with no known reset says so and gives the next check in Seoul time', () => {
    const t = waitText({ wake_at: '2026-10-10T03:00:00Z', reset_known: false, state: 'waiting' });
    expect(t).toContain('초기화 시각 확인 불가');
    expect(t).toContain('다음 확인');
    expect(t).toContain('(서울)');
    expect(t).toContain('12:00');
    const k = waitText({ wake_at: '2026-10-10T03:00:00Z', reset_known: true, state: 'waiting' });
    expect(k).toContain('초기화 뒤 확인');
    expect(k).not.toContain('확인 불가');
    expect(waitText({ wake_at: '2026-10-10T03:00:00Z', reset_known: true, state: 'closed' })).toContain('끝난 대기');
  });
});

describe('the rest of the panel', () => {
  test('auto-resume is described as making a proposal only, never as applying', () => {
    for (const s of [{ state: 'allowed' as const, expires_at: '2026-10-10T09:00:00Z' }, { state: 'not_allowed' as const, expires_at: null }, { state: 'expired' as const, expires_at: '2026-10-09T09:00:00Z' }]) {
      const t = autoResumeText(s);
      expect(t).toContain('원고 적용은 언제나 직접');
    }
    expect(autoResumeText({ state: 'allowed', expires_at: '2026-10-10T09:00:00Z' })).toContain('오후 6:00 (서울)');
    expect(autoResumeText({ state: 'not_allowed', expires_at: null })).toContain('허용하지 않음');
    expect(autoResumeText({ state: 'expired', expires_at: '2026-10-09T09:00:00Z' })).toContain('만료');
  });
  test('a checkpoint is named by its step; none is "아직 없음"', () => {
    expect(checkpointText(null)).toBe('아직 없음');
    const t = checkpointText({ seq: 3, boundary: 'after_validation', pending_step: 'store_proposal', provider: 'mock', created_at: '2026-10-10T00:00:00Z' });
    expect(t).toContain('답 검증 뒤');
    expect(t).toContain('남은 단계: 제안 저장');
    expect(t).toContain('#3');
  });
});
