// A run's control state as stored (PW-054, spec 08 "웹 상태"): the job, its last checkpoint and provider,
// the context the last reading saw (measured, estimated or unknown — never a guessed 0), its quota waits,
// the auto-resume permission, its last classified error, and what the owner may do now. Read only from the
// database; no lease or fencing detail is returned.
// resumeJob(): the owner queues a waiting job again (WAITING_QUOTA/AUTH/BUDGET/USER). It is the owner's act
// and only a new run: that run re-checks everything (gate, policy, quota, budget) and makes a proposal at
// most; applying it stays the owner's act. An open quota wait of the job is closed.
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '../shared/db.ts';
import { autoResumeAt, listQuotaWaits, type QuotaWait } from '../quota-waits/index.ts';

const WAITING = ['WAITING_QUOTA', 'WAITING_AUTH', 'WAITING_BUDGET', 'WAITING_USER'];
const FINISHED = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE'];

export interface RunControl {
  job: { id: string; intent: string; status: string; attempts: number; last_error: string | null; created_at: string; finished_at: string | null };
  checkpoint: { seq: number; boundary: string; pending_step: string | null; provider: string | null; created_at: string } | null;
  context: { tokens: number | null; window: number | null; source: 'provider_reported' | 'estimated' | 'unknown'; observed_at: string | null };
  quota_waits: Pick<QuotaWait, 'attempt' | 'provider' | 'wake_at' | 'reset_known' | 'state' | 'reason' | 'decided_at'>[];
  auto_resume: { state: 'allowed' | 'not_allowed' | 'expired'; expires_at: string | null };
  last_error: { class: string; action: string; provider: string; retry_after_s: number | null; created_at: string } | null;
  actions: { cancel: boolean; resume: boolean; auto_resume: boolean };
}

export async function runControl(db: Queryable, paperId: string, jobId: string): Promise<RunControl> {
  if (!UUID_RE.test(jobId)) throw new DomainError('NOT_FOUND', 'job not found');
  const job = (await db.query<RunControl['job']>(
    'SELECT id, intent, status, attempts, last_error, created_at, finished_at FROM jobs WHERE id = $1 AND paper_id = $2', [jobId, paperId])).rows[0];
  if (!job) throw new DomainError('NOT_FOUND', 'job not found');
  const cp = (await db.query<{ seq: number; boundary: string; pending_step: string | null; provider: string | null; created_at: string }>(
    "SELECT seq, boundary, pending_step, state->'provider'->>'provider' AS provider, created_at FROM job_checkpoints WHERE job_id = $1 ORDER BY seq DESC LIMIT 1", [jobId])).rows[0] ?? null;
  const cs = (await db.query<{ tokens: number | null; window: number | null; source: RunControl['context']['source']; observed_at: string }>(
    'SELECT context_tokens AS tokens, context_window AS window, context_source AS source, created_at AS observed_at FROM context_switches WHERE job_id = $1 ORDER BY seq DESC LIMIT 1', [jobId])).rows[0];
  const context: RunControl['context'] = cs && cs.source !== 'unknown' ? cs : { tokens: null, window: null, source: 'unknown', observed_at: null };
  const waits = (await listQuotaWaits(db, paperId, jobId)).map(({ attempt, provider, wake_at, reset_known, state, reason, decided_at }) => ({ attempt, provider, wake_at, reset_known, state, reason, decided_at }));
  const grant = (await db.query<{ kind: string; expires_at: string | null }>('SELECT kind, expires_at FROM auto_resume_grants WHERE job_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [jobId])).rows[0];
  const state = await autoResumeAt(db, jobId, new Date());
  const err = (await db.query<NonNullable<RunControl['last_error']>>(
    'SELECT class, action, provider, retry_after_s, created_at FROM run_errors WHERE job_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [jobId])).rows[0] ?? null;
  const open = !FINISHED.includes(job.status);
  return {
    job, checkpoint: cp, context, quota_waits: waits,
    auto_resume: { state, expires_at: state === 'not_allowed' ? null : (grant?.expires_at ?? null) },
    last_error: err,
    actions: { cancel: open, resume: WAITING.includes(job.status), auto_resume: open },
  };
}

export async function resumeJob(pool: TxPool, a: { paperId: string; ownerId: string; jobId: string; body: unknown }) {
  const b = (a.body && typeof a.body === 'object' ? a.body : {}) as Record<string, unknown>;
  if (b.intent !== 'resume_job' || Object.keys(b).length !== 1) throw new DomainError('INVALID', 'resuming needs the explicit intent "resume_job" and nothing else', 'intent');
  if (!UUID_RE.test(a.jobId)) throw new DomainError('NOT_FOUND', 'job not found');
  return inTransaction(pool, async (tx) => {
    await tx.query("SELECT set_config('pw.actor', $1, true)", [`owner:${a.ownerId}`]);
    const j = (await tx.query<{ status: string }>('SELECT status FROM jobs WHERE id = $1 AND paper_id = $2 FOR UPDATE', [a.jobId, a.paperId])).rows[0];
    if (!j) throw new DomainError('NOT_FOUND', 'job not found');
    if (!WAITING.includes(j.status)) throw new DomainError('CONFLICT', `only a waiting job can be resumed; this one is ${j.status}`);
    await tx.query("UPDATE quota_waits SET state = 'closed', reason = 'resumed by the owner', decided_at = clock_timestamp() WHERE job_id = $1 AND state = 'waiting'", [a.jobId]);
    // dispatched again at once (jobs_dispatch trigger)
    await tx.query("SELECT set_config('pw.dispatch_delay_secs', '0', true)");
    return (await tx.query('UPDATE jobs SET status = \'QUEUED\' WHERE id = $1 RETURNING id, intent, status, attempts, last_error, created_at, finished_at', [a.jobId])).rows[0];
  });
}
