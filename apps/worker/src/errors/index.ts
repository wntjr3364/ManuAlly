// Run errors: classified, recorded, turned into the job's state (PW-052, spec 08 "오류 종류별 동작").
// withErrorHandling() wraps job handlers (inside withQuotaWaits, so a quota error becomes a quota wait):
// - before the run: a provider that was overloaded repeatedly (3 times in 5 minutes) is not called for 5
//   minutes (circuit breaker); the run is retried later, without a model call;
// - an error the handler already decided (a JobOutcomeError: a gate, a refused answer, a quota wait) passes
//   through unchanged; a lost lease too;
// - any other error is classified (packages/providers/src/error-normalization) and recorded while the run
//   still holds the job (fenced), then: quota → QuotaExceeded (a quota wait, PW-049); login → WAITING_AUTH
//   (never retried: no model call is repeated on an account problem); budget → WAITING_BUDGET; evidence →
//   WAITING_USER; schema, invalid request, disk full, unknown → FAILED; conflict → STALE; network and
//   overload → retried by the queue (at most MAX_ATTEMPTS, with a growing delay).
// The job's last_error is the classified notice with the owner's next step, never the provider's message.
import type { TxPool } from '@pw/domain/shared/db.ts';
import { DomainError, inTransaction } from '@pw/domain/shared/db.ts';
import type { Job } from '@pw/domain/jobs/index.ts';
import { classifyError, type Classified } from '@pw/providers/error-normalization/index.ts';
import { JobOutcomeError, type JobHandler } from '../queue/index.ts';
import { QuotaExceeded } from '../quota-scheduler/index.ts';

export const CIRCUIT = { threshold: 3, windowMs: 5 * 60_000, openMs: 5 * 60_000 };
export class CircuitOpen extends Error {}

async function record(pool: TxPool, job: Pick<Job, 'id' | 'paper_id'>, fencingToken: number, provider: string, c: Classified | { class: 'circuit_open'; next: 'RETRY'; action: 'none'; retry: true; retry_after_s: number | null; detail: string }): Promise<boolean> {
  return inTransaction(pool, async (tx) => {
    const j = (await tx.query<{ status: string; token: number }>('SELECT status, fencing_token::float8 AS token FROM jobs WHERE id = $1 FOR UPDATE', [job.id])).rows[0];
    // a run that lost its lease records nothing (the current run decides the job)
    if (!j || j.status !== 'RUNNING' || j.token !== fencingToken) return false;
    await tx.query(
      `INSERT INTO run_errors (paper_id, job_id, fencing_token, provider, class, next_state, action, retried, retry_after_s, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [job.paper_id, job.id, fencingToken, provider, c.class, c.next, c.action, c.retry, c.retry_after_s, c.detail]);
    return true;
  });
}

export async function circuitOpenUntil(pool: TxPool, provider: string, authProfileId: string, now = new Date()): Promise<Date | null> {
  const rows = (await pool.query<{ created_at: Date }>(
    'SELECT created_at FROM provider_overloads WHERE provider = $1 AND auth_profile_id = $2 AND created_at > $3 ORDER BY created_at DESC LIMIT $4',
    [provider, authProfileId, new Date(now.getTime() - CIRCUIT.windowMs), CIRCUIT.threshold])).rows;
  if (rows.length < CIRCUIT.threshold) return null;
  const until = new Date(rows[0]!.created_at.getTime() + CIRCUIT.openMs);
  return until > now ? until : null;
}

export function withErrorHandling<K extends string>(pool: TxPool, handlers: Record<K, JobHandler>, o: { provider: string; authProfileId: string }): Record<K, JobHandler> {
  const out = {} as Record<K, JobHandler>;
  for (const [intent, handler] of Object.entries(handlers) as [K, JobHandler][]) {
    out[intent] = async (job, ctx) => {
      const until = await circuitOpenUntil(pool, o.provider, o.authProfileId);
      if (until) {
        await record(pool, job, ctx.fencingToken, o.provider, { class: 'circuit_open', next: 'RETRY', action: 'none', retry: true, retry_after_s: Math.ceil((until.getTime() - Date.now()) / 1000), detail: `${o.provider}: overloaded repeatedly; not called until ${until.toISOString()}` });
        throw new CircuitOpen(`the provider was overloaded repeatedly; it is not called until ${until.toISOString()} (retried later)`);
      }
      try {
        return await handler(job, ctx);
      } catch (e) {
        if (e instanceof JobOutcomeError) throw e; // decided by the handler (or a quota wait)
        if (e instanceof DomainError && e.code === 'CONFLICT' && /lease lost/.test(e.message)) throw e;
        const c = classifyError({ provider: o.provider, error: e });
        const recorded = await record(pool, job, ctx.fencingToken, o.provider, c);
        if (!recorded) throw e;
        if (c.class === 'overloaded') await pool.query('INSERT INTO provider_overloads (provider, auth_profile_id) VALUES ($1, $2)', [o.provider, o.authProfileId]);
        const message = `${c.notice} [${c.class}]`;
        if (c.class === 'quota') throw new QuotaExceeded(message, { provider: o.provider as 'mock' | 'claude_agent' | 'codex', authProfileId: o.authProfileId });
        if (c.next === 'RETRY') throw new Error(message, { cause: e });
        throw new JobOutcomeError(message, c.next);
      }
    };
  }
  return out;
}
