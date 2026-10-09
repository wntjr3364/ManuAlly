// PW-039 — how a stated number is read for the "number not in evidence" rule (review MAJOR: the ways
// scientific prose writes quantities).
import { describe, expect, test } from 'vitest';
import { numbersIn } from '../../../apps/worker/src/story/index.ts';

describe('numbersIn', () => {
  test('values, not names, ordinals, labels or figure numbers', () => {
    expect(numbersIn('ABC1 rises 2.4-fold in H2O-treated roots')).toEqual([2.4]);
    expect(numbersIn('day-3 and day 7')).toEqual([3, 7]);
    expect(numbersIn('the 3rd replicate in 2D culture, panel 5A, Figure 2, Table 3')).toEqual([]);
  });
  test('the same number in another spelling is the same; the sign counts', () => {
    expect(numbersIn('2.40 fold')).toEqual([2.4]);
    expect(numbersIn('a change of −0.5 (p<0.05)')).toEqual([-0.5, 0.05]);
    expect(numbersIn('-1.2 vs 1.2')).toEqual([-1.2, 1.2]);
    expect(numbersIn('1e-3')).toEqual([0.001]);
  });
  test('review: units glued to the number, x/×, ranges, separators, scientific notation, words, fractions', () => {
    expect(numbersIn('ABC1 rises 9x under drought')).toEqual([9]);
    expect(numbersIn('treated with 50mM NaCl for 24h, 10µg')).toEqual([50, 24, 10]);
    expect(numbersIn('a 2-9 fold rise; 2–3 days')).toEqual([2, 9, 2, 3]);
    expect(numbersIn('2,4-fold; 1,200 plants; 2·4')).toEqual([2.4, 1200, 2.4]);
    expect(numbersIn('3 × 10⁵ cells')).toEqual([300000]);
    expect(numbersIn('p < 10⁻⁶')).toEqual([1e-6]);
    expect(numbersIn('3x10^5 and 10^5')).toEqual([300000, 100000]);
    expect(numbersIn('50% of roots')).toEqual([50]);
    expect(numbersIn('ABC1 rises tenfold, a fivefold increase, two-fold, twice as much, half the plants')).toEqual([10, 5, 2, 2, 0.5]);
    expect(numbersIn('½ of plants')).toEqual([0.5]);
    expect(numbersIn('one possibility; a single genotype')).toEqual([]);
  });
});
