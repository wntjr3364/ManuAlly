// PW-045 — the synthetic scientific hard cases (SCI-001..030) run through the product's deterministic
// layers. Fails on any case where the product allows more than the case expects, on an undeclared
// deviation, or when a case meant to be decided deterministically is not.
import { describe, expect, test } from 'vitest';
import { loadCases, runSuite } from './runner.ts';

describe('scientific hard cases', () => {
  const { cases } = loadCases();
  const suite = runSuite(cases);
  test('30 synthetic cases, each with a run spec', () => {
    expect(cases).toHaveLength(30);
    expect(cases.every((c) => c.run?.layer)).toBe(true);
  });
  test.each(suite.results.map((r) => [r.id, r] as const))('%s', (_id, r) => {
    expect(r.status, `${r.name}: expected ${r.expected}, product ${r.actual ?? 'not run'} (${r.detail})`).not.toBe('unsafe');
    expect(r.status, `${r.name}: an undeclared deviation (${r.actual}); declare it in the case with the reason, or fix the product`).not.toBe('stricter');
    if (r.layer === 'not_deterministic') expect(r.status).toBe('not_run');
    else expect(['match', 'known_deviation']).toContain(r.status);
  });
  test('the summary: what matches, what is stricter on purpose, what needs AI review and the user', () => {
    expect(suite.summary).toEqual({ total: 30, match: 23, known_deviation: 2, stricter: 0, unsafe: 0, not_run: 5 });
  });
});
