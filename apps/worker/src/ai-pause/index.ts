// PW-061 AI pause (spec 12 "비상 중단"): while the operator has paused AI (ops_controls.ai_paused), an AI
// job is not started — it waits, without using an attempt, and is tried again later. A job that was already
// running when the pause came is let finish its call, but its result is not applied: the job waits and runs
// again after the pause is lifted (nothing an AI produced during a pause reaches a paper). Manual editing
// and non-AI jobs (PDF parsing) are never affected: only the handlers wrapped here wait.
// The pause is read again right after the call returns; a pause set between that read and the commit of the
// result (completeJob) does not stop that one result (documented in docs/runbooks/OPERATIONS.md).
import type { TxPool } from '@pw/domain/shared/db.ts';
import { JobDeferred, type JobHandler } from '../queue/index.ts';

// how soon a waiting job looks again (PW_AI_PAUSE_RECHECK_S, 1–3600 s; default 30)
const tuned = Number(process.env.PW_AI_PAUSE_RECHECK_S);
export const AI_PAUSE_RECHECK_S = Number.isInteger(tuned) && tuned >= 1 && tuned <= 3600 ? tuned : 30;
export class AiPaused extends JobDeferred {}

export async function aiPause(pool: TxPool): Promise<{ paused: boolean; reason: string | null }> {
  const r = (await pool.query<{ ai_paused: boolean; ai_reason: string | null }>('SELECT ai_paused, ai_reason FROM ops_controls')).rows[0];
  // no row means the controls table was never set up: treat as paused rather than silently running
  return r ? { paused: r.ai_paused, reason: r.ai_reason } : { paused: true, reason: 'operations controls are missing' };
}

export function withAiPause<K extends string>(pool: TxPool, handlers: Record<K, JobHandler>, o: { recheckS?: number } = {}): Record<K, JobHandler> {
  const wait = o.recheckS ?? AI_PAUSE_RECHECK_S;
  const out = {} as Record<K, JobHandler>;
  for (const [intent, handler] of Object.entries(handlers) as [K, JobHandler][]) {
    out[intent] = async (job, ctx) => {
      const before = await aiPause(pool);
      if (before.paused) throw new AiPaused(`AI is paused by the operator (${before.reason}); the job waits and starts after the pause is lifted. [ai_paused]`, wait);
      const result = await handler(job, ctx);
      const after = await aiPause(pool);
      if (after.paused) throw new AiPaused(`AI was paused while this job ran (${after.reason}); its result was not applied and the job runs again after the pause is lifted. [ai_paused]`, wait);
      return result;
    };
  }
  return out;
}
