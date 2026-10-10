// A job's checkpoints on the worker side (PW-047, spec 08 "Checkpoint"). A handler marks its boundaries
// (before the provider call, after validation, after the proposal is stored — the last inside the fenced
// completion transaction); the completed actions only grow. A run that follows an earlier one (a retry,
// a new session after a lost one, a quota wait) first re-checks the last checkpoint: anything approved or
// settled that changed since, or a changed sending policy, sends the job to the owner (WAITING_USER)
// instead of resuming on a guess. No model is called for any of this.
import type { Queryable, TxPool } from '@pw/domain/shared/db.ts';
import type { Job } from '@pw/domain/jobs/index.ts';
import { latestCheckpoint, recordCheckpoint, rehydrate, type Boundary, type CheckpointScope, type Rehydrated } from '@pw/domain/checkpoints/index.ts';
import { JobOutcomeError } from '../queue/index.ts';

export function jobCheckpoints(pool: TxPool, job: Pick<Job, 'id' | 'paper_id'>, fencingToken: number, base: { provider: string; versions?: Record<string, string> }) {
  let completed: string[] = [];
  let scope: CheckpointScope = {};
  return {
    // the earlier run's state, re-checked; null on a first run
    async resume(): Promise<Rehydrated | null> {
      if (!(await latestCheckpoint(pool, job.paper_id, job.id))) return null;
      const r = await rehydrate(pool, job.paper_id, job.id);
      if (r.drift.length) {
        throw new JobOutcomeError(`changed since the last checkpoint, check before resuming: ${r.drift.map((d) => `${d.kind} ${d.id} ${d.reason}`).join('; ')}`.slice(0, 1000), 'WAITING_USER');
      }
      completed = [...r.completed_actions];
      return r;
    },
    setScope(s: CheckpointScope) { scope = s; },
    // `done`: durable effects only (a stored proposal, …) — what a lost run loses is not done
    async mark(boundary: Boundary, pendingStep: string | null, done: string[], db: Queryable = pool, nativeSessionId: string | null = null, lastEvent: string | null = null) {
      for (const d of done) if (!completed.includes(d)) completed.push(d);
      return recordCheckpoint(db, {
        paperId: job.paper_id, jobId: job.id, fencingToken, boundary, pendingStep, completedActions: [...completed], scope,
        provider: { provider: base.provider, native_session_id: nativeSessionId }, versions: base.versions ?? {}, lastEvent,
      });
    },
  };
}
