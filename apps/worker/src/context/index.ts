// Context budget and switching at a safe boundary (PW-048, spec 08 "Context builder", "압축 시점").
// - readContext(): the session's current context is its latest request's input plus that request's answer
//   (both go into the next request; review MAJOR 1), from a message-scope usage report of the last turn.
//   Turn- and session-scope totals are cumulative billing and never count as occupancy. Without such a
//   report, or with an answer of unknown size, it is estimated from the text exchanged in this session
//   (a lower bound, marked "estimated"); without a window nothing is known (UNKNOWN, never a percentage).
// - requestBudget(): window − current input − next prompt − expected tool payload − output reserve −
//   safety margin. At 70% the run records a checkpoint for review; at 80%, or when the next request would
//   not fit, it switches. These are this app's thresholds, not provider limits.
// - canStartTurn(): no turn while the previous one is open (a tool may still run) or a compaction is not
//   confirmed.
// - A retried job starts again from its first step: the answers of earlier steps are not stored, so
//   re-sending them is the safe choice (the cost is a remaining risk; review MINOR 2).
// - runJobTurns(): a job's steps on one session. A switch happens only between turns: checkpoint (PW-047) →
//   compaction where the provider's manual_compact is verified and the provider confirms it, else a new
//   session started from the rehydrated state → re-check (a change since the checkpoint stops the job) →
//   the next step. A compaction that is not confirmed is never trusted.
import type { Queryable, TxPool } from '@pw/domain/shared/db.ts';
import { DomainError, UUID_RE, inTransaction } from '@pw/domain/shared/db.ts';
import { rehydrate, resumePrompt } from '@pw/domain/checkpoints/index.ts';
import type { FeatureState } from '@pw/providers/core/index.ts';
import type { ProviderEvent } from '../../../../packages/contracts/src/provider/index.ts';
import { JobOutcomeError } from '../queue/index.ts';
import type { jobCheckpoints } from '../checkpoints/index.ts';

export const REVIEW_AT = 0.7;
export const SWITCH_AT = 0.8;
// a rough size of text in tokens when the provider reports nothing (an estimate, marked as such)
const CHARS_PER_TOKEN = 4;

export interface ContextReading { context_window: number | null; current_context: number | null; source: 'provider_reported' | 'estimated' | 'unknown' }
// the model's window, whatever the scope that reported it
export function windowOf(events: ProviderEvent[]): number | null {
  let window: number | null = null;
  for (const e of events) if (e.kind === 'usage' && e.data.context_window) window = e.data.context_window;
  return window;
}
// `events`: the last turn's events (an earlier turn's report does not stand for a later one; NIT 2);
// `promptChars`: the text exchanged in this session since it started or was compacted
export function readContext(events: ProviderEvent[], fallback: { window: number | null; promptChars?: number }): ContextReading {
  let reported: number | null = null;
  let partial: number | null = null;
  for (const e of events) {
    // only a single request counts; turn/session totals add up billed requests
    if (e.kind !== 'usage' || e.data.scope !== 'message' || e.data.input_tokens === null) continue;
    if (e.data.output_tokens !== null) { reported = e.data.input_tokens + e.data.output_tokens; partial = null; } else { partial = e.data.input_tokens; reported = null; }
  }
  const window = windowOf(events) ?? fallback.window;
  if (window === null) return { context_window: null, current_context: null, source: 'unknown' };
  if (reported !== null) return { context_window: window, current_context: reported, source: 'provider_reported' };
  if (fallback.promptChars !== undefined) {
    const est = Math.ceil(fallback.promptChars / CHARS_PER_TOKEN);
    return { context_window: window, current_context: Math.max(est, partial ?? 0), source: 'estimated' };
  }
  return { context_window: window, current_context: null, source: 'unknown' };
}

export interface BudgetInput { nextPromptTokens: number; expectedToolPayload?: number; outputReserve: number; safetyMargin: number }
export function requestBudget(r: ContextReading, b: BudgetInput) {
  const unknown = [r.context_window === null ? 'context_window' : null, r.current_context === null ? 'current_context' : null].filter((x): x is string => x !== null);
  if (r.context_window === null || r.current_context === null) return { available: null, occupancy: null, state: 'unknown' as const, unknown };
  const available = r.context_window - r.current_context - b.nextPromptTokens - (b.expectedToolPayload ?? 0) - b.outputReserve - b.safetyMargin;
  const occupancy = r.current_context / r.context_window;
  const state = available < 0 || occupancy >= SWITCH_AT ? 'switch' as const : occupancy >= REVIEW_AT ? 'review' as const : 'ok' as const;
  return { available, occupancy, state, unknown };
}

// a turn that did not complete, or a turn that cannot start: the queue retries the job (from its first
// step; earlier answers are not stored)
export class TurnIncomplete extends Error {}

export interface TurnState { turnOpen: boolean; openToolCalls: number; compaction: 'none' | 'requested' | 'confirmed' | 'failed' }
export function canStartTurn(s: TurnState): { ok: true } | { ok: false; reason: 'turn_in_progress' | 'tool_call_open' | 'compaction_unconfirmed' } {
  if (s.turnOpen) return { ok: false, reason: 'turn_in_progress' };
  if (s.openToolCalls > 0) return { ok: false, reason: 'tool_call_open' };
  if (s.compaction === 'requested') return { ok: false, reason: 'compaction_unconfirmed' };
  return { ok: true };
}

// ---- records -----------------------------------------------------------------------------------------
type SwitchKind = 'checkpoint_review' | 'compact_requested' | 'compact_confirmed' | 'compact_failed' | 'session_replaced';
export interface ContextSwitch {
  id: string; seq: number; kind: SwitchKind; from_session: string; to_session: string | null; context_window: number | null; context_tokens: number | null;
  context_source: ContextReading['source']; occupancy: string | null; checkpoint_id: string | null; created_at: string;
}
export async function recordSwitch(pool: TxPool, a: { paperId: string; jobId: string; fencingToken: number; kind: SwitchKind; from: string; to?: string | null; reading: ContextReading; checkpointId: string | null }) {
  return inTransaction(pool, async (tx: Queryable) => {
    const job = (await tx.query<{ status: string; token: number }>('SELECT status, fencing_token::float8 AS token FROM jobs WHERE id = $1 AND paper_id = $2 FOR UPDATE', [a.jobId, a.paperId])).rows[0];
    if (!job) throw new DomainError('NOT_FOUND', 'job not found');
    if (job.status !== 'RUNNING' || job.token !== a.fencingToken) throw new DomainError('CONFLICT', 'only the current run of this job records its context (lease lost)');
    // the checkpoint is this job's (NIT 4)
    if (a.checkpointId !== null && !(await tx.query('SELECT 1 FROM job_checkpoints WHERE id = $1 AND job_id = $2', [a.checkpointId, a.jobId])).rowCount) throw new DomainError('INVALID', 'the checkpoint is not this job\'s', 'checkpoint_id');
    const seq = (await tx.query<{ n: number }>('SELECT coalesce(max(seq), 0)::int + 1 AS n FROM context_switches WHERE job_id = $1', [a.jobId])).rows[0]!.n;
    const r = a.reading;
    const occupancy = r.context_window !== null && r.current_context !== null ? Math.round((r.current_context / r.context_window) * 10_000) / 10_000 : null;
    await tx.query(
      `INSERT INTO context_switches (paper_id, job_id, seq, fencing_token, kind, from_session, to_session, context_window, context_tokens, context_source, occupancy, checkpoint_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [a.paperId, a.jobId, seq, a.fencingToken, a.kind, a.from, a.to ?? null, r.context_window, r.current_context, r.current_context === null ? 'unknown' : r.source, occupancy, a.checkpointId]);
  });
}
export async function listContextSwitches(db: Queryable, paperId: string, jobId: string): Promise<ContextSwitch[]> {
  if (!UUID_RE.test(jobId)) return [];
  return (await db.query<ContextSwitch>(
    'SELECT id, seq, kind, from_session, to_session, context_window, context_tokens, context_source, occupancy, checkpoint_id, created_at FROM context_switches WHERE paper_id = $1 AND job_id = $2 ORDER BY seq', [paperId, jobId])).rows;
}

// ---- the run -----------------------------------------------------------------------------------------
export interface ContextSession { readonly id: string; turn(prompt: string): AsyncIterable<ProviderEvent>; compact?(): AsyncIterable<ProviderEvent> }
export interface SessionFactory { start(prompt: string): Promise<ContextSession> }
export interface Step { name: string; prompt: string; expectedToolPayload?: number }

export async function runJobTurns(pool: TxPool, a: {
  paperId: string; job: { id: string; paper_id: string }; fencingToken: number; cps: ReturnType<typeof jobCheckpoints>;
  factory: SessionFactory; compactSupport: FeatureState; window: number | null; steps: Step[]; initialPrompt: string;
  nextPromptTokens: number; outputReserve: number; safetyMargin: number;
}): Promise<{ completed: string[] }> {
  // step names are the checkpoints' pending steps: checked before anything runs (NIT 1)
  const names = a.steps.map((x) => x.name);
  if (names.some((n) => !/^[a-z][a-z_]{0,49}$/.test(n)) || new Set(names).size !== names.length) throw new JobOutcomeError('step names must be distinct lowercase names (a-z, _)', 'FAILED');
  const ids = { paperId: a.paperId, jobId: a.job.id, fencingToken: a.fencingToken };
  const state: TurnState = { turnOpen: false, openToolCalls: 0, compaction: 'none' };
  let session = await a.factory.start(a.initialPrompt);
  // the model's window as last reported (kept across switches: it belongs to the model), the last turn's
  // events (for its size), the text exchanged since the session started or was compacted
  let knownWindow: number | null = null;
  let lastTurn: ProviderEvent[] = [];
  // undefined after a compaction: the compacted summary's size is not observed (UNKNOWN, not 0; re-review NIT 1)
  let chars: number | undefined = a.initialPrompt.length;
  const reading = () => readContext(lastTurn, { window: knownWindow ?? a.window, promptChars: chars });
  const completed: string[] = [];
  // after a switch: what changed since the checkpoint stops the job (nothing is resumed on a guess)
  const recheck = async () => {
    const r = await rehydrate(pool, a.paperId, a.job.id, { fencingToken: a.fencingToken });
    if (r.drift.length) throw new JobOutcomeError(`changed since the checkpoint, check before resuming: ${r.drift.map((d) => `${d.kind} ${d.id} ${d.reason}`).join('; ')}`.slice(0, 1000), 'WAITING_USER');
    return r;
  };
  for (const [i, step] of a.steps.entries()) {
    let review = false;
    if (i > 0) {
      const now = reading();
      const budget = requestBudget(now, { nextPromptTokens: a.nextPromptTokens, expectedToolPayload: step.expectedToolPayload, outputReserve: a.outputReserve, safetyMargin: a.safetyMargin });
      if (budget.state === 'switch') {
        // the safe boundary: the previous turn is complete; checkpoint first
        const cp = await a.cps.mark('session_change', step.name, []);
        let switched = false;
        if (a.compactSupport === 'verified' && session.compact) {
          await recordSwitch(pool, { ...ids, kind: 'compact_requested', from: session.id, reading: now, checkpointId: cp.id });
          state.compaction = 'requested';
          // confirmed only by a clean stream: the provider's 'compacted' and no error after it (NIT 3)
          let compacted = false;
          let failed = false;
          for await (const e of session.compact()) {
            if (e.kind === 'compacted') compacted = true;
            if (e.kind === 'error' || (e.kind === 'turn_completed' && e.data.outcome !== 'success')) failed = true;
          }
          const confirmed = compacted && !failed;
          if (confirmed) {
            state.compaction = 'confirmed';
            await recordSwitch(pool, { ...ids, kind: 'compact_confirmed', from: session.id, reading: now, checkpointId: cp.id });
            switched = true;
          } else {
            state.compaction = 'failed';
            await recordSwitch(pool, { ...ids, kind: 'compact_failed', from: session.id, reading: now, checkpointId: cp.id });
          }
        }
        if (!switched) {
          const r = await recheck();
          const prompt = resumePrompt(r);
          const next = await a.factory.start(prompt);
          await recordSwitch(pool, { ...ids, kind: 'session_replaced', from: session.id, to: next.id, reading: now, checkpointId: cp.id });
          session = next;
          state.compaction = 'none';
          chars = prompt.length;
        }
        await recheck();
        // earlier readings described the session before the switch
        lastTurn = [];
        if (switched) chars = undefined;
      } else if (budget.state === 'review') review = true;
    }
    const gate = canStartTurn(state);
    if (!gate.ok) throw new TurnIncomplete(`the next turn cannot start: ${gate.reason}`);
    const cp = await a.cps.mark('before_call', step.name, []);
    if (review) await recordSwitch(pool, { ...ids, kind: 'checkpoint_review', from: session.id, reading: reading(), checkpointId: cp.id });
    state.turnOpen = true;
    let outcome: string | null = null;
    lastTurn = [];
    if (chars !== undefined) chars += step.prompt.length;
    for await (const e of session.turn(step.prompt)) {
      lastTurn.push(e);
      knownWindow = windowOf([e]) ?? knownWindow;
      if (e.kind === 'message_completed' && chars !== undefined) chars += e.data.text.length;
      if (e.kind === 'tool_requested') state.openToolCalls++;
      if (e.kind === 'turn_completed') { outcome = e.data.outcome; state.turnOpen = false; state.openToolCalls = 0; }
    }
    // a stream that ended without its turn completing (a tool still running, a lost session) is not a
    // boundary: nothing more is started on it
    if (state.turnOpen || outcome !== 'success') throw new TurnIncomplete(`the turn for ${step.name} did not complete (${outcome ?? 'no turn_completed'}); not continuing on it`);
    if (state.compaction === 'confirmed') state.compaction = 'none';
    completed.push(step.name);
  }
  return { completed };
}
