// PW-045 — the human blind rubric (evals/HUMAN_RUBRIC.md) and the release-quality decision.
// - Rubric results are only accepted from human raters, blind to the candidate's model, on paragraphs
//   whose rights (and external sending) are confirmed, split into tune and held-out sets; every
//   criterion 1–5 with the reason; critical flags are listed and are never offset by an average.
// - Release quality is never declared from an AI-detector score or a model's self-evaluation. Even
//   with a clean hard-case suite and recorded human ratings the outcome is "ready_for_user_decision":
//   the numeric target is decided with the user (HUMAN_RUBRIC.md).
import type { runSuite } from './runner.ts';

export const CRITERIA = ['fact_preservation', 'story_alignment', 'paragraph_logic', 'concision', 'genre_fit', 'academic_style'] as const;
export const CRITICAL_FLAGS = ['false_fact_or_citation', 'meaning_reversal', 'overclaim', 'source_copying', 'personal_data'] as const;
export const MIN_RATED = 10;

export interface RubricEntry {
  paragraph_id: string; set: 'tune' | 'held_out'; rights_confirmed: boolean; rater_kind: 'human'; rater: string; blind: boolean;
  candidate: 'baseline' | 'candidate'; scores: Record<(typeof CRITERIA)[number], number>; reasons: Record<string, string>; critical_flags: (typeof CRITICAL_FLAGS)[number][];
}
export interface RubricFile { status: 'not_run' | 'recorded'; reason?: string; entries: RubricEntry[] }

const ENTRY_KEYS = ['paragraph_id', 'set', 'rights_confirmed', 'rater_kind', 'rater', 'blind', 'candidate', 'scores', 'reasons', 'critical_flags'];
export function validateRubric(file: unknown): { errors: string[]; means: Record<'baseline' | 'candidate', Record<string, number | null>>; summary: { rated_paragraphs: number; held_out: number; raters: number; critical: number } } {
  const errors: string[] = [];
  const f = (file ?? {}) as Partial<RubricFile> & Record<string, unknown>;
  const extra = Object.keys(f).filter((k) => !['status', 'reason', 'entries'].includes(k));
  if (extra.length) errors.push(`unknown fields: ${extra.join(', ')} (no AI-detector or self-evaluation score is accepted)`);
  const entries = Array.isArray(f.entries) ? f.entries : [];
  if (f.status === 'not_run' && entries.length) errors.push('status not_run but entries exist');
  if (f.status === 'not_run' && !f.reason) errors.push('not_run needs the reason');
  entries.forEach((e, i) => {
    const at = `entries[${i}]`;
    const bad = Object.keys(e).filter((k) => !ENTRY_KEYS.includes(k));
    if (bad.length) errors.push(`${at}: unknown fields ${bad.join(', ')}`);
    if (e.rater_kind !== 'human') errors.push(`${at}: only human raters (a model's self-evaluation is not a rating)`);
    if (e.blind !== true) errors.push(`${at}: ratings must be blind to the candidate's model`);
    if (e.rights_confirmed !== true) errors.push(`${at}: the paragraph's rights must be confirmed`);
    if (e.set !== 'tune' && e.set !== 'held_out') errors.push(`${at}: set must be tune or held_out`);
    for (const c of CRITERIA) {
      const v = e.scores?.[c];
      if (!Number.isInteger(v) || v! < 1 || v! > 5) errors.push(`${at}: ${c} must be 1–5`);
      if (!e.reasons?.[c]?.trim()) errors.push(`${at}: ${c} needs the reason`);
    }
    if (!Array.isArray(e.critical_flags) || e.critical_flags.some((x) => !(CRITICAL_FLAGS as readonly string[]).includes(x))) errors.push(`${at}: critical_flags must list known flags`);
  });
  // one rating per paragraph, rater and candidate (review NIT)
  const seen = new Set<string>();
  entries.forEach((e, i) => {
    const k = `${e.paragraph_id}|${e.rater}|${e.candidate}`;
    if (seen.has(k)) errors.push(`entries[${i}]: duplicate rating of ${e.paragraph_id} by ${e.rater} for ${e.candidate}`);
    seen.add(k);
  });
  // the means per criterion, baseline and candidate side by side, for the user's decision
  const means = (cand: string) => Object.fromEntries(CRITERIA.map((c) => {
    const v = entries.filter((e) => e.candidate === cand).map((e) => e.scores?.[c]).filter((x): x is number => Number.isInteger(x));
    return [c, v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null];
  }));
  return {
    errors,
    means: { baseline: means('baseline'), candidate: means('candidate') },
    summary: {
      rated_paragraphs: new Set(entries.map((e) => e.paragraph_id)).size,
      held_out: new Set(entries.filter((e) => e.set === 'held_out').map((e) => e.paragraph_id)).size,
      raters: new Set(entries.map((e) => e.rater)).size,
      critical: entries.filter((e) => e.critical_flags?.length).length,
    },
  };
}

export function releaseQuality(suite: ReturnType<typeof runSuite>, rubric: unknown, extra: Record<string, unknown> = {}) {
  const reasons: string[] = [];
  // signals that never count (TST-045B)
  for (const k of Object.keys(extra)) reasons.push(`ignored: ${k} (an AI-detector score or a self-evaluation never decides release quality)`);
  if (suite.summary.unsafe) reasons.push(`hard cases: ${suite.summary.unsafe} unsafe`);
  if (suite.summary.stricter) reasons.push(`hard cases: ${suite.summary.stricter} undeclared deviations to review`);
  if (suite.summary.not_run) reasons.push(`hard cases: ${suite.summary.not_run} need AI review and the user (not run here)`);
  const r = validateRubric(rubric);
  if (r.errors.length) reasons.push(`human rubric invalid: ${r.errors.length} errors`);
  else if ((rubric as RubricFile).status !== 'recorded' || r.summary.rated_paragraphs === 0) reasons.push('human rubric: not run (no rights-cleared paragraphs yet)');
  else {
    if (r.summary.rated_paragraphs < MIN_RATED) reasons.push(`human rubric: ${r.summary.rated_paragraphs} of at least ${MIN_RATED} paragraphs`);
    if (!r.summary.held_out) reasons.push('human rubric: no held-out set');
    if (r.summary.critical) reasons.push(`human rubric: ${r.summary.critical} ratings with critical flags (not offset by averages)`);
  }
  const blocking = reasons.filter((x) => !x.startsWith('ignored:') && !x.includes('need AI review'));
  return {
    declared_pass: false as const, outcome: blocking.length ? 'not_ready' as const : 'ready_for_user_decision' as const, reasons,
    // what the user decides on (review NIT): no single score
    for_user: {
      hard_cases: suite.summary,
      not_run_cases: suite.results.filter((x) => x.status === 'not_run').map((x) => ({ id: x.id, detail: x.detail })),
      ai_proposals_still_applicable: suite.results.filter((x) => x.applicable_as_ai_proposal === true && x.expected !== 'ALLOW').map((x) => x.id),
      rubric: { ...r.summary, means: r.means },
    },
  };
}
