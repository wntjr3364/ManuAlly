// PW-052 — run errors become the right job state, with the owner's next step, through the worker wrappers
// (errors inside quota waits inside admission, as in apps/worker/src/main.ts).
// TST-052A: each error leads to its WAITING/FAILED/STALE state or a bounded retry, with the next step shown.
// TST-052B: a login error is never a quota wait and is never retried; no model call repeats on it; repeated
//   overload stops the calls (circuit breaker); retries end.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { createPaper } from '../../../packages/domain/src/papers/index.ts';
import { cancelJob, claimJob, enqueueJob } from '../../../packages/domain/src/jobs/index.ts';
import { processDelivery, type JobHandler } from '../../../apps/worker/src/queue/index.ts';
import { withQuotaWaits } from '../../../apps/worker/src/quota-scheduler/index.ts';
import { withCircuitBreaker, withErrorHandling, CIRCUIT } from '../../../apps/worker/src/errors/index.ts';
import { withAdmission } from '../../../apps/worker/src/admission/index.ts';

let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let ownerId: string;
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  ownerId = (await createOwner(pool, { username: 'alice', password: 'correct horse battery' })).id;
});
afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

let profile = 0;
// a job whose handler throws the given error; counts the handler (model) calls
async function scenario(err: () => unknown) {
  const paperId = (await createPaper(pool, ownerId, { working_title: 'errors', article_type: 'research_article' })).id;
  const { job } = await enqueueJob(pool, { paperId, ownerId, intent: 'review', idempotencyKey: randomUUID(), payload: { note: 'e' } });
  const calls = { n: 0 };
  const auth = `p${++profile}`;
  const handlers = withQuotaWaits(pool, withErrorHandling(pool, { review: (async () => { calls.n++; throw err(); }) as JobHandler }, { provider: 'claude_agent', authProfileId: auth }), { jitterMs: () => 0 });
  const deliver = () => processDelivery(pool, { job_id: job.id, paper_id: paperId, intent: 'review' }, { workerId: 'w', leaseMs: 60_000, handlers });
  const state = async () => (await pool.query('SELECT status, last_error, attempts FROM jobs WHERE id = $1', [job.id])).rows[0] as { status: string; last_error: string; attempts: number };
  const errors = async () => (await pool.query('SELECT class, next_state, action, retried, detail FROM run_errors WHERE job_id = $1 ORDER BY created_at', [job.id])).rows;
  // a retried job: let it be claimed again now (its dispatch delay passed)
  const again = () => pool.query("UPDATE job_outbox SET available_at = clock_timestamp() WHERE job_id = $1", [job.id]);
  return { paperId, job, calls, auth, deliver, state, errors, again };
}
const httpErr = (status: number, type?: string, message = 'request failed') => Object.assign(new Error(message), { status, error: type ? { type } : undefined });

describe('TST-052A: each error leads to its state, with the owner\'s next step', () => {
  test.each([
    ['a 401 login error', () => httpErr(401, 'authentication_error'), 'WAITING_AUTH', 'auth', 'log_in_again', /log in again/i],
    ['a budget stop', () => Object.assign(new Error('budget'), { error: { type: 'budget_exhausted' } }), 'WAITING_BUDGET', 'budget', 'set_budget', /set a budget/i],
    ['missing evidence', () => Object.assign(new Error('no evidence'), { error: { type: 'evidence_missing' } }), 'WAITING_USER', 'evidence_missing', 'add_evidence', /evidence/i],
    ['a schema violation after its repair', () => Object.assign(new Error('bad answer'), { error: { type: 'schema_violation' } }), 'FAILED', 'schema', 'ask_again', /required form/i],
    ['a document conflict', () => Object.assign(new Error('changed'), { error: { type: 'document_conflict' } }), 'STALE', 'conflict', 'ask_again', /text changed/i],
    ['a full disk', () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }), 'FAILED', 'disk_full', 'free_disk_space', /disk is full/i],
    ['an unknown error', () => new Error('something odd'), 'FAILED', 'unknown', 'report', /not retried/i],
  ])('%s → %s with its next step', async (_name, err, status, cls, action, notice) => {
    const s = await scenario(err);
    expect((await s.deliver()).outcome).toBe('failed');
    const st = await s.state();
    expect(st.status).toBe(status);
    expect(st.last_error).toMatch(notice);
    expect(st.last_error).toContain(`[${cls}]`);
    expect(await s.errors()).toEqual([expect.objectContaining({ class: cls, next_state: status, action, retried: false })]);
    expect(s.calls.n).toBe(1);
  });

  test('a usage limit becomes a quota wait (PW-049), not a failure', async () => {
    const s = await scenario(() => httpErr(429, 'rate_limit_error', 'Claude AI usage limit reached'));
    await s.deliver();
    expect((await s.state()).status).toBe('WAITING_QUOTA');
    expect((await pool.query('SELECT provider, auth_profile_id, state FROM quota_waits WHERE job_id = $1', [s.job.id])).rows).toEqual([{ provider: 'claude_agent', auth_profile_id: s.auth, state: 'waiting' }]);
    expect(await s.errors()).toEqual([expect.objectContaining({ class: 'quota', next_state: 'WAITING_QUOTA', action: 'wait_for_reset' })]);
  });

  test('a network error is retried with a growing delay, and the retries end', async () => {
    const s = await scenario(() => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      await s.again();
      const o = (await s.deliver()).outcome;
      seen.push(`${o}:${(await s.state()).status}`);
      if ((await s.state()).status === 'FAILED') break;
    }
    expect(seen).toEqual(['failed:QUEUED', 'failed:QUEUED', 'failed:FAILED']);
    expect(s.calls.n).toBe(3);
    expect((await s.errors()).map((e) => e.class)).toEqual(['network', 'network', 'network']);
  });
});

describe('TST-052B: no quota wait and no repeated model call on a login problem; overload stops the calls', () => {
  test('a 401 that mentions a usage limit is a login problem: no quota wait, and delivering it again calls nothing', async () => {
    const s = await scenario(() => httpErr(401, undefined, 'usage limit reached'));
    await s.deliver();
    expect((await s.state()).status).toBe('WAITING_AUTH');
    expect((await pool.query('SELECT count(*)::int AS n FROM quota_waits WHERE job_id = $1', [s.job.id])).rows[0].n).toBe(0);
    for (let i = 0; i < 3; i++) expect((await s.deliver()).outcome).toBe('skipped');
    expect(s.calls.n).toBe(1);
  });

  test('a 403 account error is the same', async () => {
    const s = await scenario(() => httpErr(403, 'permission_error', 'quota exceeded for this account'));
    await s.deliver();
    expect((await s.state()).status).toBe('WAITING_AUTH');
    expect(s.calls.n).toBe(1);
  });

  test('repeated overload opens the circuit: the next jobs do not call the provider until it closes', async () => {
    const auth = `circuit-${randomUUID().slice(0, 8)}`;
    const mk = async () => {
      const paperId = (await createPaper(pool, ownerId, { working_title: 'overload', article_type: 'research_article' })).id;
      const { job } = await enqueueJob(pool, { paperId, ownerId, intent: 'review', idempotencyKey: randomUUID(), payload: { note: 'o' } });
      return { paperId, job };
    };
    let calls = 0;
    let overloaded = true;
    let now = () => new Date();
    // as composed in apps/worker/src/main.ts: the circuit outside admission, admission outside the rest
    const handlers = withCircuitBreaker(pool, withAdmission(pool, withQuotaWaits(pool, withErrorHandling(pool, { review: (async () => {
      calls++;
      if (overloaded) throw httpErr(529, 'overloaded_error');
      return { result: {} };
    }) as JobHandler }, { provider: 'claude_agent', authProfileId: auth })), { provider: 'mock', authMode: 'none', estimateUsd: () => null }), { provider: 'claude_agent', authProfileId: auth, now: () => now() });
    const deliver = (j: { paperId: string; job: { id: string } }) => processDelivery(pool, { job_id: j.job.id, paper_id: j.paperId, intent: 'review' }, { workerId: 'w', leaseMs: 60_000, handlers });
    for (let i = 0; i < CIRCUIT.threshold; i++) await deliver(await mk());
    expect(calls).toBe(CIRCUIT.threshold);

    // review M1: while the circuit is open a job is deferred until it closes — no attempt, no budget run, no call
    const j = await mk();
    const st = async () => (await pool.query('SELECT status, attempts, last_error FROM jobs WHERE id = $1', [j.job.id])).rows[0];
    for (let i = 0; i < CIRCUIT.maxDeferrals; i++) {
      await pool.query('UPDATE job_outbox SET available_at = clock_timestamp() WHERE job_id = $1', [j.job.id]);
      expect((await deliver(j)).outcome).toBe('deferred');
      expect(await st()).toMatchObject({ status: 'QUEUED', attempts: 0 });
    }
    expect(calls).toBe(CIRCUIT.threshold);
    expect((await pool.query('SELECT count(*)::int AS n FROM budget_reservations WHERE job_id = $1', [j.job.id])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM run_errors WHERE job_id = $1 AND class = 'circuit_open'", [j.job.id])).rows[0].n).toBe(CIRCUIT.maxDeferrals);
    expect((await st()).last_error).toMatch(/overloaded repeatedly/);
    // dispatched again only when the circuit closes (about openMs after the last overload)
    const wait = (await pool.query("SELECT EXTRACT(EPOCH FROM (max(available_at) - clock_timestamp()))::float8 AS s FROM job_outbox WHERE job_id = $1 AND published_at IS NULL", [j.job.id])).rows[0].s as number;
    expect(wait).toBeGreaterThan(CIRCUIT.openMs / 1000 - 30);
    expect(wait).toBeLessThanOrEqual(CIRCUIT.openMs / 1000 + 1);

    // the deferrals are bounded too: one more open-circuit delivery fails the job, still without a call
    const k = await mk();
    for (let i = 0; i <= CIRCUIT.maxDeferrals; i++) {
      await pool.query('UPDATE job_outbox SET available_at = clock_timestamp() WHERE job_id = $1', [k.job.id]);
      await deliver(k);
    }
    expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [k.job.id])).rows[0].status).toBe('FAILED');
    expect(calls).toBe(CIRCUIT.threshold);

    // once the circuit has closed the deferred job runs normally
    overloaded = false;
    now = () => new Date(Date.now() + CIRCUIT.openMs + 1000);
    await pool.query('UPDATE job_outbox SET available_at = clock_timestamp() WHERE job_id = $1', [j.job.id]);
    expect((await deliver(j)).outcome).toBe('completed');
    expect(await st()).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    expect(calls).toBe(CIRCUIT.threshold + 1);

    // another login of the same provider is not affected
    const other = withCircuitBreaker(pool, withErrorHandling(pool, { review: (async () => ({ result: {} })) as JobHandler }, { provider: 'claude_agent', authProfileId: `${auth}-b` }), { provider: 'claude_agent', authProfileId: `${auth}-b` });
    const o = await mk();
    expect((await processDelivery(pool, { job_id: o.job.id, paper_id: o.paperId, intent: 'review' }, { workerId: 'w', leaseMs: 60_000, handlers: other })).outcome).toBe('completed');
  });

  test('an error the handler already decided passes through unchanged and is not re-classified', async () => {
    const { JobOutcomeError } = await import('../../../apps/worker/src/queue/index.ts');
    const s = await scenario(() => new JobOutcomeError('draft gate: the plan is not approved', 'FAILED'));
    await s.deliver();
    expect(await s.state()).toMatchObject({ status: 'FAILED', last_error: 'draft gate: the plan is not approved' });
    expect(await s.errors()).toEqual([]);
  });

  test('the provider\'s own message is not the job\'s message; its detail is short', async () => {
    const s = await scenario(() => httpErr(401, 'authentication_error', `token sk-secret-${'x'.repeat(2000)}`));
    await s.deliver();
    expect((await s.state()).last_error).not.toContain('sk-secret');
    expect((await s.errors())[0].detail.length).toBeLessThanOrEqual(500);
    // keys and tokens are never stored
    expect((await s.errors())[0].detail).not.toContain('sk-secret');
  });

  test('a run that lost the job (cancelled meanwhile) records nothing and does not decide the job', async () => {
    const paperId = (await createPaper(pool, ownerId, { working_title: 'errors', article_type: 'research_article' })).id;
    const { job } = await enqueueJob(pool, { paperId, ownerId, intent: 'review', idempotencyKey: randomUUID(), payload: { note: 'e' } });
    const handlers = withErrorHandling(pool, { review: (async () => {
      await cancelJob(pool, { paperId, jobId: job.id, ownerId }); // the owner cancels during the call
      throw httpErr(401, 'authentication_error');
    }) as JobHandler }, { provider: 'claude_agent', authProfileId: 'lost' });
    await processDelivery(pool, { job_id: job.id, paper_id: paperId, intent: 'review' }, { workerId: 'w', leaseMs: 60_000, handlers });
    expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [job.id])).rows[0].status).toBe('CANCELLED');
    expect((await pool.query('SELECT count(*)::int AS n FROM run_errors WHERE job_id = $1', [job.id])).rows[0].n).toBe(0);
  });

  test('a deferral from inside passes the error handling unchanged (not classified, no attempt used)', async () => {
    const { JobDeferred } = await import('../../../apps/worker/src/queue/index.ts');
    const s = await scenario(() => new JobDeferred('paused for a while', 60));
    expect((await s.deliver()).outcome).toBe('deferred');
    expect(await s.state()).toMatchObject({ status: 'QUEUED', attempts: 0, last_error: 'paused for a while' });
    expect(await s.errors()).toEqual([]);
  });

  test('the job guard returns an attempt only for a deferral (flag set, RUNNING → QUEUED, same token)', async () => {
    const paperId = (await createPaper(pool, ownerId, { working_title: 'guard', article_type: 'research_article' })).id;
    const { job } = await enqueueJob(pool, { paperId, ownerId, intent: 'review', idempotencyKey: randomUUID(), payload: { note: 'g' } });
    const claimed = await claimJob(pool, { jobId: job.id, workerId: 'w', leaseMs: 60_000 });
    expect(claimed).not.toBeNull();
    const tryIn = async (flag: boolean, sql: string) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        if (flag) await c.query("SELECT set_config('pw.defer_run', 'on', true)");
        await c.query(sql, [job.id]);
        await c.query('ROLLBACK');
        return 'ok';
      } catch (e) {
        await c.query('ROLLBACK');
        return (e as Error).message;
      } finally {
        c.release();
      }
    };
    expect(await tryIn(false, "UPDATE jobs SET status = 'QUEUED', attempts = attempts - 1, lease_owner = NULL, lease_expires_at = NULL WHERE id = $1")).toMatch(/only on a claim/);
    expect(await tryIn(true, "UPDATE jobs SET status = 'QUEUED', attempts = attempts - 2, lease_owner = NULL, lease_expires_at = NULL WHERE id = $1")).toMatch(/only on a claim/);
    expect(await tryIn(true, "UPDATE jobs SET status = 'FAILED', attempts = attempts - 1, lease_owner = NULL, lease_expires_at = NULL WHERE id = $1")).toMatch(/only on a claim/);
    expect(await tryIn(true, "UPDATE jobs SET status = 'QUEUED', attempts = attempts - 1, fencing_token = fencing_token + 1, lease_owner = NULL, lease_expires_at = NULL WHERE id = $1")).toMatch(/illegal job transition/);
    expect(await tryIn(true, "UPDATE jobs SET status = 'QUEUED', attempts = attempts - 1, lease_owner = NULL, lease_expires_at = NULL WHERE id = $1")).toBe('ok');
  });
});

