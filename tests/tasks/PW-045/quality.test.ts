// PW-045 — TST-045A: the hard-case suite and the human rubric record results, what was not run and
// regressions; TST-045B: release quality is never declared from an AI-detector score or a model's
// self-evaluation, and never as an automatic "pass".
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadCases, runCase, runSuite, type HardCase } from '../../scientific/runner.ts';
import { CRITERIA, releaseQuality, validateRubric, type RubricEntry } from '../../scientific/quality.ts';

const rubricFile = () => JSON.parse(fs.readFileSync(path.resolve('evals/human-rubric.results.json'), 'utf8'));
const entry = (i: number, o: Partial<RubricEntry> = {}): RubricEntry => ({
  paragraph_id: `para-${i}`, set: i % 3 === 0 ? 'held_out' : 'tune', rights_confirmed: true, rater_kind: 'human', rater: 'rater-1', blind: true, candidate: 'candidate',
  scores: Object.fromEntries(CRITERIA.map((c) => [c, 4])) as RubricEntry['scores'], reasons: Object.fromEntries(CRITERIA.map((c) => [c, 'kept the numbers and the order'])), critical_flags: [], ...o,
});
const clean = { results: [], summary: { total: 30, match: 30, known_deviation: 0, stricter: 0, unsafe: 0, not_run: 0 } };

describe('TST-045A: results, not-run cases and regressions are recorded', () => {
  test('every case has a result; the ones no deterministic layer decides are recorded as not run, with who decides them', () => {
    const s = runSuite();
    expect(s.results.map((r) => r.id)).toEqual(loadCases().cases.map((c) => c.id));
    const notRun = s.results.filter((r) => r.status === 'not_run');
    expect(notRun.map((r) => r.id)).toEqual(['SCI-010', 'SCI-017', 'SCI-020', 'SCI-024', 'SCI-027']);
    for (const r of notRun) expect(r.detail).toMatch(/decided by .*user/);
    expect(s.results.find((r) => r.id === 'SCI-015')).toMatchObject({ status: 'known_deviation', actual: 'NEEDS_EVIDENCE', expected: 'ALLOW' });
  });
  test('a regression shows: a product change that lets a case through is "unsafe"; an unexplained stricter result is "stricter"', () => {
    const c = loadCases().cases.find((x) => x.id === 'SCI-007')!;
    // the same case with the unit the fact really has: the product allows it, the (now wrong) expectation says BLOCK
    const allowed: HardCase = { ...c, run: { ...c.run, text: 'The concentration was 2 mmol/L.' } };
    expect(runCase(allowed)).toMatchObject({ status: 'unsafe', actual: 'ALLOW', expected: 'BLOCK' });
    const strict: HardCase = { ...c, expected: 'NEEDS_EVIDENCE' };
    expect(runCase(strict).status).toBe('stricter');
  });
  test('the human rubric file is valid and records that it was not run, and why', () => {
    const f = rubricFile();
    expect(validateRubric(f).errors).toEqual([]);
    expect(f).toMatchObject({ status: 'not_run', entries: [] });
    expect(f.reason).toMatch(/권리/);
  });
  test('rubric entries: only blind human ratings on rights-confirmed paragraphs, every criterion 1–5 with a reason', () => {
    const errs = (e: Partial<RubricEntry> & Record<string, unknown>) => validateRubric({ status: 'recorded', entries: [{ ...entry(1), ...e }] }).errors;
    expect(errs({})).toEqual([]);
    expect(errs({ rater_kind: 'model' as 'human' })[0]).toMatch(/only human raters/);
    expect(errs({ blind: false })[0]).toMatch(/blind/);
    expect(errs({ rights_confirmed: false })[0]).toMatch(/rights/);
    expect(errs({ scores: { ...entry(1).scores, concision: 6 } })[0]).toMatch(/concision must be 1–5/);
    expect(errs({ reasons: { ...entry(1).reasons, concision: ' ' } })[0]).toMatch(/concision needs the reason/);
    expect(errs({ self_score: 5 })[0]).toMatch(/unknown fields self_score/);
  });
});

describe('TST-045B: no release "pass" from AI-detector scores, self-evaluation or averages', () => {
  test('an AI-detector score and a self-evaluation are ignored; with no human ratings the outcome is not ready', () => {
    const q = releaseQuality(clean, rubricFile(), { ai_detector_human_likeness: 0.99, model_self_evaluation: 'excellent' });
    expect(q.declared_pass).toBe(false);
    expect(q.outcome).toBe('not_ready');
    expect(q.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^ignored: ai_detector_human_likeness/), expect.stringMatching(/^ignored: model_self_evaluation/), expect.stringMatching(/not run/)]));
    expect(validateRubric({ status: 'recorded', entries: [], ai_detector_score: 0.1 }).errors[0]).toMatch(/no AI-detector or self-evaluation/);
  });
  test('a critical flag is not offset by high averages; too few paragraphs or no held-out set is not ready', () => {
    const ten = Array.from({ length: 10 }, (_, i) => entry(i));
    const flagged = ten.map((e, i) => (i === 4 ? { ...e, scores: Object.fromEntries(CRITERIA.map((c) => [c, 5])) as RubricEntry['scores'], critical_flags: ['meaning_reversal' as const] } : e));
    expect(releaseQuality(clean, { status: 'recorded', entries: flagged }).reasons).toContain('human rubric: 1 ratings with critical flags (not offset by averages)');
    expect(releaseQuality(clean, { status: 'recorded', entries: ten.slice(0, 9) }).outcome).toBe('not_ready');
    expect(releaseQuality(clean, { status: 'recorded', entries: ten.map((e) => ({ ...e, set: 'tune' as const })) }).reasons).toContain('human rubric: no held-out set');
  });
  test('even a clean suite with enough blind human ratings is only "ready for the user\'s decision", never a pass', () => {
    const q = releaseQuality(clean, { status: 'recorded', entries: Array.from({ length: 12 }, (_, i) => entry(i)) });
    expect(q).toMatchObject({ declared_pass: false, outcome: 'ready_for_user_decision', reasons: [] });
  });
  test('the current state of this product: not ready (unsafe 0, but the human rubric was not run)', () => {
    const q = releaseQuality(runSuite(), rubricFile());
    expect(q.outcome).toBe('not_ready');
    expect(q.reasons.some((r) => r.includes('unsafe'))).toBe(false);
  });
});

describe('review NITs (a576c5b)', () => {
  test('each result says whether the candidate, as an AI proposal, could still be applied and what stops it', () => {
    const s = runSuite();
    const by = (id: string) => s.results.find((r) => r.id === id)!;
    expect(by('SCI-002')).toMatchObject({ applicable_as_ai_proposal: false, stopped_by: 'scientific gate (PW-043)' });
    expect(by('SCI-001')).toMatchObject({ applicable_as_ai_proposal: false, stopped_by: 'Writer number check (PW-042)' });
    // a priority claim is only shown (UNKNOWN): the owner can still apply it — said, not hidden
    expect(by('SCI-005')).toMatchObject({ actual: 'NEEDS_EVIDENCE', applicable_as_ai_proposal: true, stopped_by: null });
    expect(releaseQuality(s, rubricFile()).for_user.ai_proposals_still_applicable).toContain('SCI-005');
  });
  test('an AI candidate meets the Writer number check too: a number the gate does not read (a year) still needs evidence', () => {
    const c: HardCase = { id: 'X', name: 'year_in_draft', candidate: '', expected: 'NEEDS_EVIDENCE', run: { layer: 'gate', text: 'Samples from 2019 were used.', facts: [] } };
    expect(runCase(c)).toMatchObject({ status: 'match', actual: 'NEEDS_EVIDENCE', stopped_by: 'Writer number check (PW-042)' });
  });
  test('the user decides on means per criterion for baseline and candidate, raters and the not-run cases; duplicates are refused', () => {
    const entries = [entry(1), { ...entry(1), candidate: 'baseline' as const, scores: Object.fromEntries(CRITERIA.map((c) => [c, 3])) as RubricEntry['scores'] }];
    const v = validateRubric({ status: 'recorded', entries });
    expect(v.means.candidate.concision).toBe(4);
    expect(v.means.baseline.concision).toBe(3);
    expect(validateRubric({ status: 'recorded', entries: [entry(1), entry(1)] }).errors[0]).toMatch(/duplicate rating/);
    const q = releaseQuality(runSuite(), rubricFile());
    expect(q.for_user.not_run_cases.map((x) => x.id)).toEqual(['SCI-010', 'SCI-017', 'SCI-020', 'SCI-024', 'SCI-027']);
  });
});
