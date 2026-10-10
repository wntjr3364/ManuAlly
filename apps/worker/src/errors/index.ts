// Run errors: classified, recorded, turned into the job's state (PW-052, spec 08 "오류 종류별 동작").
// withErrorHandling() wraps job handlers (inside withQuotaWaits, so a quota error becomes a quota wait):
// - an error the handler already decided (a JobOutcomeError: a gate, a refused answer, a quota wait) passes
//   through unchanged; a lost lease too;
// - any other error is classified (packages/providers/src/error-normalization) and recorded while the run
//   still holds the job (fenced), then: quota → QuotaExceeded (a quota wait, PW-049); login → WAITING_AUTH
//   (never retried: no model call is repeated on an account problem); budget → WAITING_BUDGET; evidence →
//   WAITING_USER; schema, invalid request, disk full, unknown → FAILED; conflict → STALE; network and
//   overload → retried by the queue (at most MAX_ATTEMPTS, with a growing delay).
// The job's last_error is the classified notice with the owner's next step, never the provider's message.
// withCircuitBreaker() goes outside admission (apps/worker/src/main.ts): a provider login that was overloaded
// repeatedly (3 times in 5 minutes) is not called until 5 minutes after its last overload. A run that finds
// the circuit open calls nothing, takes no budget run and uses no attempt: the job is deferred until the
// circuit closes (review M1), at most CIRCUIT.maxDeferrals times, then FAILED.
import type { TxPool } from '@pw/domain/shared/db.ts';
import { DomainError, inTransaction } from '@pw/domain/shared/db.ts';
import type { Job } from '@pw/domain/jobs/index.ts';
import { classifyError, type Classified } from '@pw/providers/error-normalization/index.ts';
import { JobDeferred, JobOutcomeError, type JobHandler } from '../queue/index.ts';
import { QuotaExceeded } from '../quota-scheduler/index.ts';

export const CIRCUIT = { threshold: 3, windowMs: 5 * 60_000, openMs: 5 * 60_000, maxDeferrals: 6 };
export class CircuitOpen extends JobDeferred {}

async function record(pool: TxPool, job: Pick<Job, 'id' | 'paper_id'>, fencingToken: number, provider: string, c: Classified | { class: 'circuit_open'; next: 'RETRY' | 'FAILED'; action: 'none' | 'report'; retry: boolean; retry_after_s: number | null; detail: string }): Promise<boolean> {
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

export function withCircuitBreaker<K extends string>(pool: TxPool, handlers: Record<K, JobHandler>, o: { provider: string; authProfileId: string; now?: () => Date }): Record<K, JobHandler> {
  const out = {} as Record<K, JobHandler>;
  for (const [intent, handler] of Object.entries(handlers) as [K, JobHandler][]) {
    out[intent] = async (job, ctx) => {
      const now = o.now?.() ?? new Date();
      const until = await circuitOpenUntil(pool, o.provider, o.authProfileId, now);
      if (!until) return handler(job, ctx);
      const waitS = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
      const deferred = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM run_errors WHERE job_id = $1 AND class = 'circuit_open'", [job.id])).rows[0]!.n;
      const detail = `${o.provider}: overloaded repeatedly; not called until ${until.toISOString()}`;
      if (deferred >= CIRCUIT.maxDeferrals) {
        await record(pool, job, ctx.fencingToken, o.provider, { class: 'circuit_open', next: 'FAILED', action: 'report', retry: false, retry_after_s: null, detail });
        throw new JobOutcomeError(`The provider stayed overloaded; the job waited ${CIRCUIT.maxDeferrals} times and stopped. Ask again later. [circuit_open]`, 'FAILED');
      }
      await record(pool, job, ctx.fencingToken, o.provider, { class: 'circuit_open', next: 'RETRY', action: 'none', retry: true, retry_after_s: waitS, detail });
      throw new CircuitOpen(`The provider was overloaded repeatedly; it is not called until ${until.toISOString()} and the job waits until then. [circuit_open]`, waitS);
    };
  }
  return out;
}

export function withErrorHandling<K extends string>(pool: TxPool, handlers: Record<K, JobHandler>, o: { provider: string; authProfileId: string }): Record<K, JobHandler> {
  const out = {} as Record<K, JobHandler>;
  for (const [intent, handler] of Object.entries(handlers) as [K, JobHandler][]) {
    out[intent] = async (job, ctx) => {
      try {
        return await handler(job, ctx);
      } catch (e) {
        if (e instanceof JobOutcomeError || e instanceof JobDeferred) throw e; // decided by the handler (or a quota wait)
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
