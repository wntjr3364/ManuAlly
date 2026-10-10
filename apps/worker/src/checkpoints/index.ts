// A job's checkpoints on the worker side (PW-047, spec 08 "Checkpoint"). A handler marks its boundaries
// (before the provider call, after validation, after the proposal is stored — the last inside the fenced
// completion transaction); the completed actions only grow. A run that follows an earlier one (a retry,
// a new session after a lost one, a quota wait) first re-checks the last checkpoint (review MINOR 3):
// - 'recheck': the handler re-runs its own run-time checks (the Writer: draft gate, sending policy, a
//   contract rebuilt from the database), so what changed is recorded in a session_change checkpoint and
//   the handler decides; nothing is resumed on a guess
// - 'stop': a handler without such checks sends the job to the owner (WAITING_USER); the owner asks again
// No model is called for any of this.
import type { Queryable, TxPool } from '@pw/domain/shared/db.ts';
import type { Job } from '@pw/domain/jobs/index.ts';
import { latestCheckpoint, recordCheckpoint, recordCheckpointIn, rehydrate, type Boundary, type CheckpointScope, type Rehydrated } from '@pw/domain/checkpoints/index.ts';
import { JobOutcomeError } from '../queue/index.ts';

export function jobCheckpoints(pool: TxPool, job: Pick<Job, 'id' | 'paper_id'>, fencingToken: number, base: { provider: string; versions?: Record<string, string> }) {
  let completed: string[] = [];
  let scope: CheckpointScope = {};
  return {
    // the earlier run's state, re-checked; null on a first run
    async resume(mode: 'recheck' | 'stop'): Promise<Rehydrated | null> {
      const last = await latestCheckpoint(pool, job.paper_id, job.id);
      if (!last) return null;
      const r = await rehydrate(pool, job.paper_id, job.id, { fencingToken });
      completed = [...r.completed_actions];
      if (r.drift.length) {
        if (mode === 'stop') throw new JobOutcomeError(`changed since the last checkpoint, check before resuming: ${r.drift.map((d) => `${d.kind} ${d.id} ${d.reason}`).join('; ')}`.slice(0, 1000), 'WAITING_USER');
        scope = last.state.scope;
        const kinds = [...new Set(r.drift.map((d) => d.kind))].join(',');
        await this.mark('session_change', last.pending_step, [], null, null, `resumed_after_change:${kinds}`.slice(0, 200));
      }
      return r;
    },
    setScope(s: CheckpointScope) { scope = s; },
    // `done`: durable effects only (a stored proposal, …) — what a lost run loses is not done
    // `tx`: inside the caller's transaction (the fenced completion); otherwise in its own
    async mark(boundary: Boundary, pendingStep: string | null, done: string[], tx: Queryable | null = null, nativeSessionId: string | null = null, lastEvent: string | null = null) {
      for (const d of done) if (!completed.includes(d)) completed.push(d);
      const input = {
        paperId: job.paper_id, jobId: job.id, fencingToken, boundary, pendingStep, completedActions: [...completed], scope,
        provider: { provider: base.provider, native_session_id: nativeSessionId }, versions: base.versions ?? {}, lastEvent,
      };
      return tx ? recordCheckpointIn(tx, input) : recordCheckpoint(pool, input);
    },
  };
}
