// PW-029 — display rules: unknown is said, reset times are in Asia/Seoul, a missing reset is not guessed.
import { describe, expect, test } from 'vitest';
import { percentText, resetText, tokens, usd } from '../../../apps/web/src/features/usage/format.ts';

describe('usage display', () => {
  test('unknown values are "알 수 없음" or a lower bound, never 0', () => {
    expect(tokens({ value: null, unknown: true })).toBe('알 수 없음');
    expect(tokens({ value: 1200, unknown: false })).toBe('1,200');
    expect(tokens({ value: 50, unknown: true })).toBe('50 이상 (일부 보고 없음)');
    expect(usd({ value: 0, unknown: true })).toBe('알 수 없음');
    expect(tokens({ value: 0, unknown: true })).toBe('알 수 없음'); // nothing known is not "0 이상"
    expect(usd({ value: 0.03, unknown: false })).toBe('$0.0300 (추정)');
    expect(percentText(null)).toBe('알 수 없음');
  });
  test('reset times are shown in Seoul time; a missing one says it cannot be confirmed', () => {
    expect(resetText(null)).toBe('초기화 시각 확인 불가');
    expect(resetText('2026-10-09T05:00:00Z')).toMatch(/오후 2:00.*\(서울\)/);
  });
});
