// Leases and what a run can claim (PW-051, spec 08 "신뢰 가능한 queue").
// - leaseState(): who runs a job now and whether that lease has expired (a lost worker is not shown alive).
// - billingAccount(): how many runs a job had and how many of them reported provider usage. A run whose
//   result was discarded (it lost its lease) may still have called — and been billed by — the provider;
//   its usage is counted. Billing is at least once, never claimed to be exactly once.
import { DomainError, UUID_RE, type Queryable } from '../shared/db.ts';

export async function leaseState(db: Queryable, paperId: string, jobId: string) {
  const r = UUID_RE.test(jobId) ? (await db.query<{ status: string; lease_owner: string | null; lease_expires_at: string | null; fencing_token: number; expired: boolean; attempts: number }>(
    `SELECT status, lease_owner, lease_expires_at, fencing_token::int AS fencing_token, attempts,
            (status = 'RUNNING' AND lease_expires_at < clock_timestamp()) AS expired
     FROM jobs WHERE id = $1 AND paper_id = $2`, [jobId, paperId])).rows[0] : undefined;
  if (!r) throw new DomainError('NOT_FOUND', 'job not found');
  return r;
}

export async function billingAccount(db: Queryable, paperId: string, jobId: string) {
  const j = UUID_RE.test(jobId) ? (await db.query<{ runs: number; status: string }>('SELECT fencing_token::int AS runs, status FROM jobs WHERE id = $1 AND paper_id = $2', [jobId, paperId])).rows[0] : undefined;
  if (!j) throw new DomainError('NOT_FOUND', 'job not found');
  // runs with usage: distinct provider sessions or, for reports without one, the run they name
  const u = (await db.query<{ n: number }>(
    `SELECT count(DISTINCT coalesce(native_session_id, 'job')) ::int AS n FROM usage_events WHERE job_id = $1 AND paper_id = $2`, [jobId, paperId])).rows[0]!;
  return {
    runs: j.runs,
    runs_with_usage: u.n,
    // only one run's result is ever kept (the fence); every reported run is counted, kept or not
    results_kept: j.status === 'SUCCEEDED' ? 1 : 0,
    billing: 'at_least_once' as const,
    exactly_once: false as const,
    note: 'A provider may have been called (and billed) by a run that lost its lease; its usage is counted. Billing is at least once, not exactly once.',
  };
}
