// Waiting out a provider quota and resuming only after a re-check (PW-049, spec 08 "Quota normalization",
// "자동 재개", "오류 종류별 동작": 429 → WAITING_QUOTA).
// - A handler that meets a quota limit throws QuotaExceeded (provider and login). withQuotaWaits() records a
//   durable wait while the run still holds the job (fenced), then the job becomes WAITING_QUOTA.
// - The wake-up time comes from the latest observations of that provider and login: every blocked bucket
//   must reset, so it is the latest known reset plus a short jitter. A blocked bucket without a known reset
//   (none is invented) gives a bounded backoff (15, 30, 60, 120 min), and then the provider's confirmation
//   is required. A provider's retry-after is respected.
// - wakeDueWaits() decides each due wait once (row lock), in this order: the job is still waiting (else
//   closed: cancelled); the owner's auto-resume permission is valid (else WAITING_USER); no other bucket is
//   still blocked (else rescheduled to its reset, without asking the provider); the provider's answer
//   (auth → WAITING_AUTH, still limited → backoff, cannot tell → backoff unless the known reset passed);
//   the paper still allows sending to this provider (else WAITING_USER); the document the job was asked on
//   has not moved (else STALE). Then the job is QUEUED again — it makes a proposal; nothing is applied, the
//   provider is never switched, nothing extra is paid for. At most six waits; then the owner decides.
import { randomInt } from 'node:crypto';
import { DomainError, inTransaction, type Queryable, type TxPool } from '@pw/domain/shared/db.ts';
import type { Job } from '@pw/domain/jobs/index.ts';
import { autoResumeAt } from '@pw/domain/quota-waits/index.ts';
import { JobOutcomeError, type JobHandler } from '../queue/index.ts';

export const MAX_WAITS = 6;
const BACKOFF_MIN = [15, 30, 60, 120];
const backoffMs = (attempt: number) => BACKOFF_MIN[Math.min(attempt - 1, BACKOFF_MIN.length - 1)]! * 60_000;
// a short random delay after a reset, so waiting jobs do not all start at the same second
export const defaultJitterMs = () => randomInt(30_000, 120_001);

export class QuotaExceeded extends JobOutcomeError {
  readonly provider: 'mock' | 'claude_agent' | 'codex';
  readonly authProfileId: string;
  constructor(message: string, a: { provider: 'mock' | 'claude_agent' | 'codex'; authProfileId: string }) {
    super(message, 'WAITING_QUOTA');
    this.provider = a.provider;
    this.authProfileId = a.authProfileId;
  }
}

interface Blocking { bucket: string; model: string | null; resets_at: string | null }
// the latest observation of each bucket (and model) of this provider and login, as of `now`; blocked when
// rejected or used up and not yet reset
async function blockedAt(db: Queryable, provider: string, authProfileId: string, now: Date): Promise<{ blocking: Blocking[]; retryUntil: number | null }> {
  const rows = (await db.query<{ bucket: string; model: string | null; status: string; used_percent: string | null; resets_at: Date | null; retry_after_s: number | null; observed_at: Date }>(
    `SELECT DISTINCT ON (bucket, coalesce(model, '')) bucket, model, status, used_percent, resets_at, retry_after_s, observed_at
     FROM quota_observations WHERE provider = $1 AND auth_profile_id = $2 AND observed_at <= $3
     ORDER BY bucket, coalesce(model, ''), observed_at DESC, created_at DESC`, [provider, authProfileId, now])).rows;
  const blocking: Blocking[] = [];
  let retryUntil: number | null = null;
  for (const r of rows) {
    const used = r.status === 'rejected' || (r.used_percent !== null && Number(r.used_percent) >= 100);
    if (r.retry_after_s !== null) retryUntil = Math.max(retryUntil ?? 0, r.observed_at.getTime() + r.retry_after_s * 1000);
    if (!used) continue;
    if (r.resets_at && r.resets_at.getTime() <= now.getTime()) continue; // reset passed: the provider is asked
    blocking.push({ bucket: r.bucket, model: r.model, resets_at: r.resets_at ? r.resets_at.toISOString() : null });
  }
  return { blocking, retryUntil };
}
function schedule(b: { blocking: Blocking[]; retryUntil: number | null }, attempt: number, now: Date, jitter: number) {
  const known = b.blocking.filter((x) => x.resets_at !== null).map((x) => new Date(x.resets_at!).getTime());
  const unknown = b.blocking.length === 0 || b.blocking.some((x) => x.resets_at === null);
  let at = Math.max(known.length ? Math.max(...known) : 0, unknown ? now.getTime() + backoffMs(attempt) : 0, b.retryUntil ?? 0);
  at += jitter;
  return { wakeAt: new Date(at), resetKnown: !unknown };
}

async function lockRunningJob(tx: Queryable, paperId: string, jobId: string, fencingToken: number) {
  const job = (await tx.query<{ status: string; token: number }>('SELECT status, fencing_token::float8 AS token FROM jobs WHERE id = $1 AND paper_id = $2 FOR UPDATE', [jobId, paperId])).rows[0];
  if (!job) throw new DomainError('NOT_FOUND', 'job not found');
  if (job.status !== 'RUNNING' || job.token !== fencingToken) throw new DomainError('CONFLICT', 'only the current run of this job enters a quota wait (lease lost)');
}

export async function enterQuotaWait(pool: TxPool, a: {
  paperId: string; jobId: string; fencingToken: number; provider: string; authProfileId: string; now: Date; jitterMs: () => number;
}): Promise<{ toUser: boolean; wakeAt: Date | null }> {
  return inTransaction(pool, async (tx) => {
    await lockRunningJob(tx, a.paperId, a.jobId, a.fencingToken);
    const attempt = (await tx.query<{ n: number }>('SELECT count(*)::int + 1 AS n FROM quota_waits WHERE job_id = $1', [a.jobId])).rows[0]!.n;
    if (attempt > MAX_WAITS) return { toUser: true, wakeAt: null };
    const b = await blockedAt(tx, a.provider, a.authProfileId, a.now);
    const s = schedule(b, attempt, a.now, a.jitterMs());
    await tx.query(
      `INSERT INTO quota_waits (paper_id, job_id, provider, auth_profile_id, attempt, wake_at, reset_known, blocking) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [a.paperId, a.jobId, a.provider, a.authProfileId, attempt, s.wakeAt, s.resetKnown, JSON.stringify(b.blocking)]);
    return { toUser: false, wakeAt: s.wakeAt };
  });
}

// A handler wrapper: a QuotaExceeded becomes a recorded wait (or, after too many, the owner's decision).
export function withQuotaWaits<K extends string>(pool: TxPool, handlers: Record<K, JobHandler>, opts: { jitterMs?: () => number; now?: () => Date } = {}): Record<K, JobHandler> {
  const out = {} as Record<K, JobHandler>;
  for (const [intent, handler] of Object.entries(handlers) as [K, JobHandler][]) {
    out[intent] = async (job: Job, ctx) => {
      try {
        return await handler(job, ctx);
      } catch (e) {
        if (!(e instanceof QuotaExceeded)) throw e;
        const r = await enterQuotaWait(pool, { paperId: job.paper_id, jobId: job.id, fencingToken: ctx.fencingToken, provider: e.provider, authProfileId: e.authProfileId, now: opts.now?.() ?? new Date(), jitterMs: opts.jitterMs ?? defaultJitterMs });
        if (r.toUser) throw new JobOutcomeError(`the quota was hit ${MAX_WAITS} times; the owner decides how to go on`, 'WAITING_USER');
        throw e;
      }
    };
  }
  return out;
}

export type Probe = (q: { provider: string; authProfileId: string }) => Promise<'allowed' | 'rejected' | 'auth' | 'unknown'>;
export interface WakeDecision { job_id: string; decision: 'resumed' | 'rescheduled' | 'to_user' | 'to_auth' | 'stale' | 'closed'; reason: string | null }
interface WaitRow { id: string; paper_id: string; job_id: string; provider: string; auth_profile_id: string; attempt: number; reset_known: boolean }

const USER_TEXT: Record<string, string> = {
  auto_resume_not_allowed: 'the quota reset passed; auto-resume is not allowed for this job — resume or cancel it',
  auto_resume_expired: 'the quota reset passed after the auto-resume permission expired — resume or cancel it',
  policy_changed: 'the paper no longer allows sending to this provider',
  waited_too_long: 'the quota stayed unavailable after several waits — resume or cancel it',
};

export async function wakeDueWaits(pool: TxPool, a: { now: Date; probe: Probe; jitterMs?: () => number; limit?: number }): Promise<WakeDecision[]> {
  const jitter = a.jitterMs ?? defaultJitterMs;
  const due = (await pool.query<{ id: string }>("SELECT id FROM quota_waits WHERE state = 'waiting' AND wake_at <= $1 ORDER BY wake_at, id LIMIT $2", [a.now, a.limit ?? 50])).rows;
  const out: WakeDecision[] = [];
  for (const { id } of due) {
    const d = await inTransaction(pool, async (tx) => {
      await tx.query("SELECT set_config('pw.actor', 'system:quota-scheduler', true)");
      // decided once: a concurrent scheduler skips a wait being decided
      const w = (await tx.query<WaitRow>("SELECT id, paper_id, job_id, provider, auth_profile_id, attempt, reset_known FROM quota_waits WHERE id = $1 AND state = 'waiting' FOR UPDATE SKIP LOCKED", [id])).rows[0];
      if (!w) return null;
      const job = (await tx.query<{ status: string; payload: Record<string, unknown> }>('SELECT status, payload FROM jobs WHERE id = $1 FOR UPDATE', [w.job_id])).rows[0]!;
      const close = async (state: string, reason: string | null) => { await tx.query('UPDATE quota_waits SET state = $2, reason = $3, decided_at = $4 WHERE id = $1', [w.id, state, reason, a.now]); };
      const jobTo = async (status: string, message: string) => {
        await tx.query(`UPDATE jobs SET status = $2, last_error = $3, finished_at = CASE WHEN $2 = 'STALE' THEN clock_timestamp() END WHERE id = $1`, [w.job_id, status, message]);
      };
      const decide = (decision: WakeDecision['decision'], reason: string | null): WakeDecision => ({ job_id: w.job_id, decision, reason });
      const toUser = async (reason: string) => { await close('to_user', reason); await jobTo('WAITING_USER', USER_TEXT[reason] ?? reason); return decide('to_user', reason); };
      const reschedule = async (reason: string, b: { blocking: Blocking[]; retryUntil: number | null }) => {
        if (w.attempt + 1 > MAX_WAITS) return toUser('waited_too_long');
        const s = schedule(b, w.attempt + 1, a.now, jitter());
        await close('rescheduled', reason);
        await tx.query('INSERT INTO quota_waits (paper_id, job_id, provider, auth_profile_id, attempt, wake_at, reset_known, blocking) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [w.paper_id, w.job_id, w.provider, w.auth_profile_id, w.attempt + 1, s.wakeAt, s.resetKnown, JSON.stringify(b.blocking)]);
        return decide('rescheduled', reason);
      };

      if (job.status !== 'WAITING_QUOTA') { await close('closed', job.status === 'CANCELLED' ? 'job_cancelled' : 'job_not_waiting'); return decide('closed', job.status === 'CANCELLED' ? 'job_cancelled' : 'job_not_waiting'); }
      const permission = await autoResumeAt(tx, w.job_id, a.now);
      if (permission !== 'allowed') return toUser(permission === 'expired' ? 'auto_resume_expired' : 'auto_resume_not_allowed');
      const b = await blockedAt(tx, w.provider, w.auth_profile_id, a.now);
      // another bucket still blocked with a known reset: wait for it, without asking the provider
      if (b.blocking.some((x) => x.resets_at !== null) || (b.retryUntil !== null && b.retryUntil > a.now.getTime())) return reschedule('bucket_still_blocked', b);
      const answer = await a.probe({ provider: w.provider, authProfileId: w.auth_profile_id });
      if (answer === 'auth') { await close('to_auth', 'login_required'); await jobTo('WAITING_AUTH', 'the provider login must be renewed'); return decide('to_auth', 'login_required'); }
      if (answer === 'rejected') return reschedule('still_limited', { blocking: [], retryUntil: null });
      // the provider cannot tell: only a known reset that has passed (and no blocked bucket) lets it run
      if (answer === 'unknown' && (!w.reset_known || b.blocking.length)) return reschedule('availability_unknown', { blocking: [], retryUntil: null });
      if (w.provider !== 'mock') {
        const p = (await tx.query<{ external_send_policy: string; data_classification: string; allowed_providers: string[] }>('SELECT external_send_policy, data_classification, allowed_providers FROM paper_projects WHERE id = $1', [w.paper_id])).rows[0]!;
        if (p.data_classification === 'sensitive' || p.external_send_policy !== 'allow_selected' || !p.allowed_providers.includes(w.provider)) return toUser('policy_changed');
      }
      const docId = job.payload.document_id;
      const base = job.payload.base_revision_id;
      if (typeof docId === 'string' && typeof base === 'string') {
        const head = (await tx.query<{ head_revision_id: string }>('SELECT head_revision_id FROM documents WHERE id = $1 AND paper_id = $2', [docId, w.paper_id])).rows[0]?.head_revision_id;
        if (head !== base) { await close('stale', 'document_changed'); await jobTo('STALE', 'the manuscript changed while the job waited for the quota; ask again'); return decide('stale', 'document_changed'); }
      }
      await close('resumed', null);
      await jobTo('QUEUED', 'resumed after the quota wait');
      return decide('resumed', null);
    });
    if (d) out.push(d);
  }
  return out;
}
