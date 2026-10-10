// Recovery of in-flight work (PW-051, spec 08 "신뢰 가능한 queue"). One sweep, run regularly by the worker:
// - runs whose lease expired (a crashed or cut-off worker) are queued again — or failed once their attempts
//   are used — each with an event (kind 'error', reason lease_expired) in the same transaction, so its
//   progress in the browser says what happened instead of showing a run that is gone;
// - a QUEUED job whose message the queue lost gets a new one (recoverJobs);
// - reservations of runs that ended without settling are settled (PW-050);
// - the sweep is recorded (recovery_log).
// What makes this safe is the fence: a worker whose lease was taken over cannot heartbeat, report progress,
// write a checkpoint, reserve, enter a quota wait or complete (each checks the job's current fencing token
// under the job row lock), so only the current run's result is ever stored.
import type { TxPool } from '@pw/domain/shared/db.ts';
import { inTransaction } from '@pw/domain/shared/db.ts';
import { MAX_ATTEMPTS, appendJobEventIn, recoverJobs } from '@pw/domain/jobs/index.ts';
import { settleOrphanReservations } from '@pw/domain/budget/index.ts';

// afterRecover: a test hook between re-queueing and the rest of the sweep (another worker may claim meanwhile)
export async function reconcileInflight(pool: TxPool, opts: { redispatchAfterMs?: number; afterRecover?: () => Promise<void> } = {}) {
  // runs whose lease expired: each recovered here, with its event, in one transaction — so a job gets one
  // event, and only from the sweep that recovered it (review n1/n2). A run that heartbeats first is skipped.
  const jobs: { job_id: string; status: string; previous_owner: string | null }[] = [];
  let requeued = 0;
  let failed = 0;
  await inTransaction(pool, async (tx) => {
    await tx.query("SELECT set_config('pw.actor', 'system:recovery', true)");
    const expired = (await tx.query<{ id: string; attempts: number; lease_owner: string | null }>(
      "SELECT id, attempts, lease_owner FROM jobs WHERE status = 'RUNNING' AND lease_expires_at < clock_timestamp() ORDER BY id FOR UPDATE SKIP LOCKED")).rows;
    for (const j of expired) {
      const give = j.attempts >= MAX_ATTEMPTS;
      const status = give ? 'FAILED' : 'QUEUED';
      await tx.query(
        `UPDATE jobs SET status = $2, lease_owner = NULL, lease_expires_at = NULL, last_error = $3, finished_at = CASE WHEN $2 = 'FAILED' THEN clock_timestamp() END WHERE id = $1`,
        [j.id, status, give ? `lease expired ${j.attempts} times; giving up` : 'lease expired; re-queued']);
      // the browser's progress: not a 'status' (that starts a run there; review m1) but a note that the run
      // was lost; who ran it stays in the recovery log, not in what the browser sees
      await appendJobEventIn(tx, { jobId: j.id, kind: 'error', data: { reason: 'lease_expired', status } });
      jobs.push({ job_id: j.id, status, previous_owner: j.lease_owner });
      if (give) failed++; else requeued++;
    }
  });
  await opts.afterRecover?.();
  // lost messages of QUEUED jobs are sent again (recoverJobs; its expired runs were handled above)
  const r = await recoverJobs(pool, { redispatchAfterMs: opts.redispatchAfterMs });
  const settled = await settleOrphanReservations(pool);
  await pool.query('INSERT INTO recovery_log (requeued, failed, redispatched, settled, jobs) VALUES ($1, $2, $3, $4, $5)', [requeued + r.requeued, failed + r.failed, r.redispatched, settled, JSON.stringify(jobs)]);
  return { requeued: requeued + r.requeued, failed: failed + r.failed, redispatched: r.redispatched, settled, jobs: jobs.map(({ job_id, status }) => ({ job_id, status })) };
}

export async function listRecoveryLog(pool: TxPool, limit = 50) {
  return (await pool.query<{ requeued: number; failed: number; redispatched: number; settled: number; jobs: { job_id: string; status: string }[]; created_at: string }>(
    'SELECT requeued, failed, redispatched, settled, jobs, created_at FROM recovery_log ORDER BY id DESC LIMIT $1', [limit])).rows.reverse();
}
