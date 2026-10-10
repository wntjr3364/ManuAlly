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
import { cancelJob, enqueueJob } from '../../../packages/domain/src/jobs/index.ts';
import { processDelivery, type JobHandler } from '../../../apps/worker/src/queue/index.ts';
import { withQuotaWaits } from '../../../apps/worker/src/quota-scheduler/index.ts';
import { withErrorHandling, CIRCUIT } from '../../../apps/worker/src/errors/index.ts';

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
    const handlers = withErrorHandling(pool, { review: (async () => { calls++; throw httpErr(529, 'overloaded_error'); }) as JobHandler }, { provider: 'claude_agent', authProfileId: auth });
    for (let i = 0; i < CIRCUIT.threshold; i++) {
      const { paperId, job } = await mk();
      await processDelivery(pool, { job_id: job.id, paper_id: paperId, intent: 'review' }, { workerId: 'w', leaseMs: 60_000, handlers });
    }
    expect(calls).toBe(CIRCUIT.threshold);
    const { paperId, job } = await mk();
    expect((await processDelivery(pool, { job_id: job.id, paper_id: paperId, intent: 'review' }, { workerId: 'w', leaseMs: 60_000, handlers })).outcome).toBe('failed');
    expect(calls).toBe(CIRCUIT.threshold);
    expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [job.id])).rows[0].status).toBe('QUEUED');
    expect((await pool.query('SELECT class, retried FROM run_errors WHERE job_id = $1', [job.id])).rows).toEqual([{ class: 'circuit_open', retried: true }]);
    // another login of the same provider is not affected
    const other = withErrorHandling(pool, { review: (async () => { calls++; return { result: {} }; }) as JobHandler }, { provider: 'claude_agent', authProfileId: `${auth}-b` });
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
});
