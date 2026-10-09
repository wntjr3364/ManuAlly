// PW-039 — how a stated number is read for the "number not in evidence" rule.
import { describe, expect, test } from 'vitest';
import { numbersIn } from '../../../apps/worker/src/story/index.ts';

describe('numbersIn', () => {
  test('values, not names', () => {
    expect(numbersIn('ABC1 rises 2.4-fold in H2O-treated roots')).toEqual([2.4]);
    expect(numbersIn('day-3 and day 7')).toEqual([3, 7]);
    expect(numbersIn('the 3rd replicate')).toEqual([]);
  });
  test('the same number in another spelling is the same; the sign counts', () => {
    expect(numbersIn('2.40 fold')).toEqual([2.4]);
    expect(numbersIn('a change of −0.5 (p<0.05)')).toEqual([-0.5, 0.05]);
    expect(numbersIn('-1.2 vs 1.2')).toEqual([-1.2, 1.2]);
    expect(numbersIn('1e-3')).toEqual([0.001]);
  });
});
