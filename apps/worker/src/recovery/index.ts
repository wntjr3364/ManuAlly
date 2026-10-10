// Recovery of in-flight work (PW-051, spec 08 "신뢰 가능한 queue"). One sweep, run regularly by the worker:
// - runs whose lease expired (a crashed or cut-off worker) are queued again — or failed once their attempts
//   are used — by recoverJobs (PW-013); each such job gets a status event, so its progress in the browser
//   says what happened instead of showing a run that is gone;
// - a QUEUED job whose message the queue lost gets a new one (recoverJobs);
// - reservations of runs that ended without settling are settled (PW-050);
// - the sweep is recorded (recovery_log).
// What makes this safe is the fence: a worker whose lease was taken over cannot heartbeat, report progress,
// write a checkpoint, reserve, enter a quota wait or complete (each checks the job's current fencing token
// under the job row lock), so only the current run's result is ever stored.
import type { TxPool } from '@pw/domain/shared/db.ts';
import { inTransaction } from '@pw/domain/shared/db.ts';
import { appendJobEventIn, recoverJobs } from '@pw/domain/jobs/index.ts';
import { settleOrphanReservations } from '@pw/domain/budget/index.ts';

// afterRecover: a test hook between re-queueing and the status events (another worker may claim meanwhile)
export async function reconcileInflight(pool: TxPool, opts: { redispatchAfterMs?: number; afterRecover?: () => Promise<void> } = {}) {
  // the runs about to be recovered, with who held them
  const expired = (await pool.query<{ id: string; lease_owner: string | null }>(
    "SELECT id, lease_owner FROM jobs WHERE status = 'RUNNING' AND lease_expires_at < clock_timestamp()")).rows;
  const r = await recoverJobs(pool, { redispatchAfterMs: opts.redispatchAfterMs });
  await opts.afterRecover?.();
  const jobs: { job_id: string; status: string }[] = [];
  for (const e of expired) {
    const status = await inTransaction(pool, async (tx) => {
      const j = (await tx.query<{ status: string }>('SELECT status FROM jobs WHERE id = $1 FOR UPDATE', [e.id])).rows[0];
      // recovered by this sweep (another worker may have claimed it in the meantime: then nothing to add)
      if (!j || !['QUEUED', 'FAILED'].includes(j.status)) return null;
      await appendJobEventIn(tx, { jobId: e.id, kind: 'status', data: { status: j.status, reason: 'lease_expired', previous_owner: e.lease_owner } });
      return j.status;
    });
    if (status) jobs.push({ job_id: e.id, status });
  }
  const settled = await settleOrphanReservations(pool);
  await pool.query('INSERT INTO recovery_log (requeued, failed, redispatched, settled, jobs) VALUES ($1, $2, $3, $4, $5)', [r.requeued, r.failed, r.redispatched, settled, JSON.stringify(jobs)]);
  return { ...r, settled, jobs };
}

export async function listRecoveryLog(pool: TxPool, limit = 50) {
  return (await pool.query<{ requeued: number; failed: number; redispatched: number; settled: number; jobs: { job_id: string; status: string }[]; created_at: string }>(
    'SELECT requeued, failed, redispatched, settled, jobs, created_at FROM recovery_log ORDER BY id DESC LIMIT $1', [limit])).rows.reverse();
}
