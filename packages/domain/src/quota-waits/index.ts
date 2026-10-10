// Quota waits and the owner's auto-resume permission (PW-049, spec 08 "자동 재개").
// - grantAutoResume(): the owner allows one unfinished job to resume on its own after a quota wait, for
//   1–72 hours, or revokes it. Without a valid permission a job never resumes by itself; it comes back to
//   the owner. The latest row counts.
// - listQuotaWaits(): a job's waits, oldest first (the scheduler is in apps/worker/src/quota-scheduler).
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '../shared/db.ts';

export interface AutoResumeGrant { id: string; job_id: string; kind: 'allow' | 'revoke'; hours: number | null; expires_at: string | null; created_at: string }
export interface QuotaWait {
  id: string; job_id: string; provider: string; auth_profile_id: string; attempt: number; wake_at: string; reset_known: boolean;
  blocking: { bucket: string; model: string | null; resets_at: string | null }[]; state: string; reason: string | null; decided_at: string | null; created_at: string;
}
const FINISHED = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE'];

export async function grantAutoResume(pool: TxPool, a: { paperId: string; ownerId: string; jobId: string; body: unknown }): Promise<AutoResumeGrant> {
  const b = (a.body && typeof a.body === 'object' ? a.body : {}) as Record<string, unknown>;
  if (Object.keys(b).some((k) => !['intent', 'hours'].includes(k))) throw new DomainError('INVALID', 'unknown fields', 'body');
  let kind: 'allow' | 'revoke';
  let hours: number | null = null;
  if (b.intent === 'allow_auto_resume') {
    kind = 'allow';
    if (!Number.isInteger(b.hours) || (b.hours as number) < 1 || (b.hours as number) > 72) throw new DomainError('INVALID', 'hours must be a whole number from 1 to 72', 'hours');
    hours = b.hours as number;
  } else if (b.intent === 'revoke_auto_resume') {
    kind = 'revoke';
    if (b.hours !== undefined) throw new DomainError('INVALID', 'a revocation takes no hours', 'hours');
  } else throw new DomainError('INVALID', 'intent must be allow_auto_resume or revoke_auto_resume', 'intent');
  if (!UUID_RE.test(a.jobId)) throw new DomainError('NOT_FOUND', 'job not found');
  return inTransaction(pool, async (tx) => {
    const job = (await tx.query<{ status: string }>('SELECT status FROM jobs WHERE id = $1 AND paper_id = $2 FOR SHARE', [a.jobId, a.paperId])).rows[0];
    if (!job) throw new DomainError('NOT_FOUND', 'job not found');
    if (FINISHED.includes(job.status)) throw new DomainError('CONFLICT', `the job is ${job.status}`);
    return (await tx.query<AutoResumeGrant>(
      `INSERT INTO auto_resume_grants (paper_id, job_id, owner_id, kind, hours, expires_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::int IS NULL THEN NULL ELSE clock_timestamp() + make_interval(hours => $5::int) END)
       RETURNING id, job_id, kind, hours, expires_at, created_at`, [a.paperId, a.jobId, a.ownerId, kind, hours])).rows[0]!;
  });
}

// the permission in force: the latest row, if it allows and has not expired at `now`
export async function autoResumeAt(db: Queryable, jobId: string, now: Date): Promise<'allowed' | 'not_allowed' | 'expired'> {
  const g = (await db.query<{ kind: string; expires_at: Date | null }>('SELECT kind, expires_at FROM auto_resume_grants WHERE job_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [jobId])).rows[0];
  if (!g || g.kind !== 'allow') return 'not_allowed';
  return g.expires_at!.getTime() > now.getTime() ? 'allowed' : 'expired';
}

export async function listQuotaWaits(db: Queryable, paperId: string, jobId: string): Promise<QuotaWait[]> {
  if (!UUID_RE.test(jobId)) return [];
  return (await db.query<QuotaWait>(
    'SELECT id, job_id, provider, auth_profile_id, attempt, wake_at, reset_known, blocking, state, reason, decided_at, created_at FROM quota_waits WHERE paper_id = $1 AND job_id = $2 ORDER BY attempt', [paperId, jobId])).rows;
}
