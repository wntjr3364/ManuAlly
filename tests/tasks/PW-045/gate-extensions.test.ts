// PW-045 — the gate rules the hard cases added (pw-sci-gate-2), with the cases they must not flag.
import { describe, expect, test } from 'vitest';
import { scientificGate, type GateClaim, type GateFact } from '../../../packages/domain/src/scientific-checks/index.ts';

const fact = (o: Partial<GateFact> & { id: string }): GateFact => ({ evidence_id: 'e', evidence_label: 'E', locator: null, entity: '', metric: '', value_text: '1', unit: '', group_label: '', comparison: '', n: null, statistics: [], ...o });
const run = (text: string, facts: GateFact[] = [], claims: GateClaim[] = []) => scientificGate({ paragraph: { content: [{ type: 'text', text }] }, facts, references: [], claims });
const of = (r: ReturnType<typeof run>, check: string) => r.findings.filter((f) => f.check === check);

describe('significance and impossible probabilities', () => {
  test('a p at or above 0.05 called significant fails; "not significant", a smaller p or no claim of significance does not', () => {
    expect(of(run('The difference was significant (p = 0.08).'), 'statistic')[0]).toMatchObject({ verdict: 'fail', reason: 'significance_misstated' });
    expect(of(run('ABC1 was significantly higher (p > 0.05).'), 'statistic')[0]).toMatchObject({ verdict: 'fail', reason: 'significance_misstated' });
    for (const t of ['The difference was not significant (p = 0.08).', 'The difference was non-significant (p = 0.08).', 'The difference was significant (p = 0.03).', 'The difference was small (p = 0.08).']) {
      expect(of(run(t), 'statistic')[0]?.reason, t).not.toBe('significance_misstated');
    }
  });
  test('p = 0 or above 1 fails', () => {
    expect(of(run('The p-value was 0.000.'), 'statistic')[0]).toMatchObject({ verdict: 'fail', reason: 'impossible_probability' });
    expect(of(run('ABC1 changed (q = 1.2).'), 'statistic')[0]).toMatchObject({ verdict: 'fail', reason: 'impossible_probability' });
  });
});

describe('replicates and units', () => {
  const f = fact({ id: 'f', entity: 'ABC1', metric: 'fold change', value_text: '2.4', unit: 'fold', n: 3 });
  test('"N biological replicates" is n: a different recorded n fails, the same is not a failure; technical replicates are not n', () => {
    // the sentence names what was measured: then its n contradicts the record (an unattributed n is unknown)
    expect(of(run('ABC1 was measured in 6 independent biological replicates.', [f]), 'sample_size')[0]).toMatchObject({ verdict: 'fail', reason: 'n_mismatch' });
    expect(of(run('We used 6 independent biological replicates.', [f]), 'sample_size')[0]).toMatchObject({ verdict: 'unknown' });
    expect(of(run('We used 3 biological replicates.', [f]), 'sample_size')[0]).toMatchObject({ verdict: 'unknown' });
    expect(of(run('Each sample had 2 technical replicates.', [f]), 'sample_size')).toEqual([]);
  });
  test('molar units are units: mol/L is not mmol/L', () => {
    const c = fact({ id: 'c', entity: 'concentration', metric: 'molarity', value_text: '2', unit: 'mmol/L' });
    expect(of(run('The concentration was 2 mol/L.', [c]), 'quantity')[0]).toMatchObject({ verdict: 'fail', reason: 'unit_mismatch' });
    expect(of(run('The concentration was 2 mmol/L.', [c]), 'quantity')[0]).toMatchObject({ verdict: 'pass' });
  });
});

describe('group comparisons without numbers', () => {
  const a = fact({ id: 'a', entity: 'score', metric: 'mean', value_text: '12', group_label: 'A' });
  const b = fact({ id: 'b', entity: 'score', metric: 'mean', value_text: '8', group_label: 'B' });
  test('the order the facts hold passes; the reverse fails; the article "a" is not group A', () => {
    expect(of(run('B exceeded A.', [a, b]), 'comparison')[0]).toMatchObject({ verdict: 'fail', reason: 'comparison_contradicts_facts' });
    expect(of(run('A exceeded B.', [a, b]), 'comparison')[0]).toMatchObject({ verdict: 'pass' });
    expect(of(run('B was lower than A.', [a, b]), 'comparison')[0]).toMatchObject({ verdict: 'pass' });
    expect(of(run('B scored higher than a typical control.', [a, b]), 'comparison')).toEqual([]);
  });
});

describe('claim strength against the approved claim', () => {
  test('a cause over an observation and certainty over a hypothesis fail; the same strength passes', () => {
    const obs = [{ id: 'c', kind: 'observation', text: 'Treatment is associated with the phenotype.' }];
    expect(of(run('Treatment caused the phenotype.', [], obs), 'claim')[0]).toMatchObject({ verdict: 'fail', reason: 'causal_overstatement' });
    expect(of(run('Treatment is associated with the phenotype.', [], obs), 'claim')[0]).toMatchObject({ verdict: 'pass' });
    const hyp = [{ id: 'h', kind: 'hypothesis', text: 'The mechanism operates in roots.' }];
    expect(of(run('The mechanism was experimentally confirmed in roots.', [], hyp), 'claim')[0]).toMatchObject({ verdict: 'fail', reason: 'certainty_overstatement' });
    expect(of(run('The mechanism may operate in roots.', [], hyp), 'claim')[0]).toMatchObject({ verdict: 'pass' });
    // an interpretation the user approved as causal may be stated causally
    expect(of(run('Treatment caused the phenotype.', [], [{ id: 'i', kind: 'interpretation', text: 'Treatment caused the phenotype.' }]), 'claim')[0]).toMatchObject({ verdict: 'pass' });
  });
  test('a claim of priority is never verified here', () => {
    expect(of(run('This is the first study to show it.'), 'claim')[0]).toMatchObject({ verdict: 'unknown', reason: 'priority_claim' });
    expect(run('We first measured ABC1, then ABC2.').status).toBe('NOT_APPLICABLE');
  });
});

describe('review MAJOR/MINOR (a576c5b): correct prose is not failed', () => {
  const abc1 = fact({ id: 'f', entity: 'ABC1', metric: 'fold change', value_text: '2.4', unit: 'fold', group_label: 'drought', comparison: 'control', n: 3, statistics: [{ kind: 'p_value', value_text: '0.003' }] });
  test.each([
    'Differences in leaf area were not statistically significant (p > 0.05).',
    'ABC1 changed significantly (p = 0.003), but ABC2 did not (p = 0.21).',
    'This difference is biologically significant even though p = 0.08.',
    'The change did not reach significance (p = 0.07).',
    'Leaf area showed no significant change (p = 0.4).',
    'We transferred 20 plants to soil and grew them for 2 weeks.',
    'Forty mice were housed per cage; 12 mice were used for each group.',
    'Root length was scored in five independent experiments (n = 5).',
    'A total n of 12 seedlings was sampled.',
    // the entity is named, so an organism count read as n would contradict it: it is a count, not n
    'ABC1 was measured after 20 plants were transferred to soil.',
  ])('%s', (t) => {
    expect(run(t, [abc1]).findings.filter((f) => f.verdict === 'fail')).toEqual([]);
  });
  test('the same rules still fail what is wrong', () => {
    expect(of(run('ABC1 was significantly induced (p = 0.08).', [abc1]), 'statistic')[0]).toMatchObject({ verdict: 'fail', reason: 'significance_misstated' });
    expect(of(run('ABC1 expression was measured in 6 independent biological replicates.', [abc1]), 'sample_size')[0]).toMatchObject({ verdict: 'fail', reason: 'n_mismatch' });
    expect(of(run('ABC1 was induced 2.4-fold under drought (n = 5).', [abc1]), 'sample_size')[0]).toMatchObject({ verdict: 'fail', reason: 'n_mismatch' });
    expect(of(run('ABC1 was compared in 12 plants per group.', [abc1]), 'sample_size')[0]).toMatchObject({ verdict: 'fail', reason: 'n_mismatch' });
  });
  test('experimental wording ("led to", "results in") over an observation is not a failure; "causes" still is', () => {
    const obs = [{ id: 'c', kind: 'observation', text: 'Drought treatment induced ABC1 2.4-fold in roots.' }];
    expect(of(run('Drought treatment led to a 2.4-fold induction of ABC1 in roots.', [], obs), 'claim')[0]?.verdict).not.toBe('fail');
    const loss = [{ id: 'l', kind: 'observation', text: 'Loss of ABC1 is associated with shorter roots.' }];
    expect(of(run('Loss of ABC1 results in shorter roots.', [], loss), 'claim')[0]?.verdict).not.toBe('fail');
    expect(of(run('Loss of ABC1 causes shorter roots.', [], loss), 'claim')[0]).toMatchObject({ verdict: 'fail', reason: 'causal_overstatement' });
  });
});
