// PW-043 — the deterministic scientific gate (spec 06 "검증 층" A).
// TST-043A: an exactly matched fact or citation gives a check result with its evidence locator.
// TST-043B: a p↔q swap, a unit change, a group swap, a negated claim or a citation that does not exist
//   never passes, and an ambiguous or missing mapping is UNKNOWN — never VERIFIED.
import { describe, expect, test } from 'vitest';
import { scientificGate, type GateFact, type GateInput } from '../../../packages/domain/src/scientific-checks/index.ts';

const F1: GateFact = {
  id: 'f1', evidence_id: 'e1', evidence_label: 'Fig 1A', locator: { panel: 'A' }, entity: 'ABC1 roots', metric: 'fold change', value_text: '2.4', unit: 'fold',
  group_label: 'drought', comparison: 'control', n: 3, statistics: [{ kind: 'p_value', value_text: '0.003' }, { kind: 'q_value', value_text: '0.04' }],
};
const F2: GateFact = { ...F1, id: 'f2', evidence_id: 'e2', evidence_label: 'Fig 1B', locator: { panel: 'B' }, entity: 'proline', metric: 'concentration', value_text: '2.5', unit: 'mM', n: 4, statistics: [] };
const F3: GateFact = { ...F1, id: 'f3', evidence_id: 'e3', evidence_label: 'Fig 2', locator: { panel: 'C' }, entity: 'ABC2 roots', group_label: 'salt', statistics: [] };
const REF = { id: 'r1', label: 'Kim 2019', retracted: false };
const OLD = { id: 'r2', label: 'Lee 2015', retracted: true };
type Inline = { type: string; text?: string; attrs?: Record<string, unknown> };
const para = (...content: (string | Inline)[]) => ({ type: 'paragraph', attrs: { id: 'p' }, content: content.map((c) => (typeof c === 'string' ? { type: 'text', text: c } : c)) });
const cite = (id: string, locator: string | null = null) => ({ type: 'citation', attrs: { referenceId: id, locator } });
const gate = (paragraph: ReturnType<typeof para>, o: Partial<GateInput> = {}) => scientificGate({ paragraph, facts: [F1, F2, F3], references: [REF, OLD], claims: [], ...o });
const find = (r: ReturnType<typeof gate>, check: string) => r.findings.filter((f) => f.check === check);

describe('TST-043A: exact matches carry their evidence locators', () => {
  test('value, unit, group, n, p-value and citation all match: VERIFIED, each finding names its fact or reference and locator', () => {
    const r = gate(para('Under drought, ABC1 was induced 2.4-fold in roots compared with control (n = 3; p = 0.003) ', cite('r1', 'p. 4'), '.'));
    expect(r.status).toBe('VERIFIED');
    expect(find(r, 'quantity')).toEqual([expect.objectContaining({ verdict: 'pass', text: '2.4-fold', fact_id: 'f1', evidence_id: 'e1', locator: { panel: 'A' }, evidence_label: 'Fig 1A' })]);
    expect(find(r, 'sample_size')).toEqual([expect.objectContaining({ verdict: 'pass', text: 'n = 3', fact_id: 'f1' })]);
    expect(find(r, 'statistic')).toEqual([expect.objectContaining({ verdict: 'pass', text: 'p = 0.003', fact_id: 'f1', statistic: 'p_value' })]);
    expect(find(r, 'citation')).toEqual([expect.objectContaining({ verdict: 'pass', reference_id: 'r1', label: 'Kim 2019', locator: 'p. 4' })]);
  });
  test('a threshold the fact meets passes; the entity in the sentence picks one of two facts with the same value', () => {
    expect(find(gate(para('ABC1 rose 2.4-fold under drought (p < 0.01).')), 'statistic')[0]).toMatchObject({ verdict: 'pass', fact_id: 'f1' });
    expect(find(gate(para('Under salt, ABC2 rose 2.4-fold in roots.')), 'quantity')[0]).toMatchObject({ verdict: 'pass', fact_id: 'f3' });
  });
  test('an approved claim stated with the same polarity passes with its id', () => {
    const r = gate(para('ABC1 rises in roots under drought (2.4-fold).'), { claims: [{ id: 'c1', text: 'ABC1 rises in roots under drought.' }] });
    expect(find(r, 'claim')).toEqual([expect.objectContaining({ verdict: 'pass', claim_id: 'c1' })]);
  });
});

describe('TST-043B: never pass a changed fact; ambiguity is UNKNOWN', () => {
  test('p ↔ q: a q-value written as p, or a p-value written as q, fails', () => {
    expect(find(gate(para('ABC1 rose 2.4-fold under drought (p = 0.04).')), 'statistic')[0]).toMatchObject({ verdict: 'fail', reason: 'p_q_mismatch' });
    expect(find(gate(para('ABC1 rose 2.4-fold under drought (q = 0.003).')), 'statistic')[0]).toMatchObject({ verdict: 'fail', reason: 'p_q_mismatch' });
    expect(find(gate(para('ABC1 rose 2.4-fold under drought (FDR = 0.003).')), 'statistic')[0]).toMatchObject({ verdict: 'fail', reason: 'p_q_mismatch' });
    expect(find(gate(para('ABC1 rose 2.4-fold under drought (p < 0.001).')), 'statistic')[0]).toMatchObject({ verdict: 'fail', reason: 'threshold_not_met' });
  });
  test('the same value with another unit fails', () => {
    const r = gate(para('Under drought, proline reached 2.5 µM.'));
    expect(r.status).toBe('FAILED');
    expect(find(r, 'quantity')[0]).toMatchObject({ verdict: 'fail', reason: 'unit_mismatch' });
  });
  test('the value attributed to the comparison group fails', () => {
    const r = gate(para('In control plants, ABC1 was 2.4-fold higher in roots.'));
    expect(find(r, 'quantity')[0]).toMatchObject({ verdict: 'fail', reason: 'group_mismatch' });
  });
  test('a negated or reversed claim fails', () => {
    const claims = [{ id: 'c1', text: 'ABC1 rises in roots under drought.' }];
    expect(find(gate(para('ABC1 does not rise in roots under drought.'), { claims }), 'claim')[0]).toMatchObject({ verdict: 'fail', reason: 'negation_changed', claim_id: 'c1' });
    expect(find(gate(para('ABC1 falls in roots under drought.'), { claims }), 'claim')[0]).toMatchObject({ verdict: 'fail', reason: 'direction_changed', claim_id: 'c1' });
  });
  test('a citation of a reference that is not the paper\'s, or of a retracted work, fails', () => {
    expect(find(gate(para('As shown ', cite('nope'), '.')), 'citation')[0]).toMatchObject({ verdict: 'fail', reason: 'citation_not_found' });
    expect(find(gate(para('As shown ', cite('r2'), '.')), 'citation')[0]).toMatchObject({ verdict: 'fail', reason: 'citation_retracted' });
  });
  test('a different n fails', () => {
    expect(find(gate(para('ABC1 rose 2.4-fold under drought in roots (n = 5).')), 'sample_size')[0]).toMatchObject({ verdict: 'fail', reason: 'n_mismatch' });
  });
  test('two facts with the same value and nothing to choose between them: UNKNOWN with both candidates, not VERIFIED', () => {
    const r = gate(para('Expression changed 2.4-fold.'));
    expect(r.status).toBe('UNKNOWN');
    expect(find(r, 'quantity')[0]).toMatchObject({ verdict: 'unknown', reason: 'ambiguous', candidates: ['f1', 'f3'] });
  });
  test('two facts that both match fully (same value, unit and group) and the sentence names neither: UNKNOWN, not the first one', () => {
    const F4: GateFact = { ...F1, id: 'f4', evidence_id: 'e4', entity: 'ABC3 roots', statistics: [] };
    const r = gate(para('Under drought, expression rose 2.4-fold.'), { facts: [F1, F4] });
    expect(find(r, 'quantity')[0]).toMatchObject({ verdict: 'unknown', reason: 'ambiguous', candidates: ['f1', 'f4'] });
    expect(r.status).toBe('UNKNOWN');
  });
  test('a number no fact holds, a rounded value, a missing unit or an unstated group is UNKNOWN', () => {
    expect(find(gate(para('Samples were taken after 24 h.')), 'quantity')[0]).toMatchObject({ verdict: 'unknown', reason: 'no_matching_fact' });
    expect(find(gate(para('ABC1 rose 2.43-fold in roots under drought.'), { facts: [{ ...F1, value_text: '2.4' }] }), 'quantity')[0]).toMatchObject({ verdict: 'unknown', reason: 'no_matching_fact' });
    expect(find(gate(para('Under drought ABC1 in roots reached 2.4.')), 'quantity')[0]).toMatchObject({ verdict: 'unknown', reason: 'unit_not_stated' });
    expect(find(gate(para('ABC1 rose 2.4-fold in roots.')), 'quantity')[0]).toMatchObject({ verdict: 'unknown', reason: 'group_not_stated' });
    // a statistic of no matched fact
    expect(find(gate(para('The effect was significant (p = 0.02).')), 'statistic')[0]).toMatchObject({ verdict: 'unknown' });
  });
  test('a protected atom (math, figure reference) of the original that is dropped or changed fails', () => {
    const original = para('Rate ', { type: 'math_inline', attrs: { latex: 'k_1' } }, ' see ', { type: 'figure_ref', attrs: { targetId: 'fig1' } }, '.');
    expect(find(gate(para('Rate ', { type: 'math_inline', attrs: { latex: 'k_1' } }, ' see ', { type: 'figure_ref', attrs: { targetId: 'fig1' } }, '.'), { original }), 'protected_span')[0]).toMatchObject({ verdict: 'pass' });
    expect(find(gate(para('Rate ', { type: 'math_inline', attrs: { latex: 'k_2' } }, ' see ', { type: 'figure_ref', attrs: { targetId: 'fig1' } }, '.'), { original }), 'protected_span')[0]).toMatchObject({ verdict: 'fail', reason: 'protected_span_changed' });
  });
  test('names with digits, figure numbers and years are not quantities', () => {
    const r = gate(para('ABC1 and H2O2 levels (Fig. 2, Table 1) in 2019.'));
    expect(find(r, 'quantity')).toEqual([]);
    expect(r.status).toBe('NOT_APPLICABLE');
  });
});
