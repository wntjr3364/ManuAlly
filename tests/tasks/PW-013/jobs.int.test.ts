// PW-013 — TST-013A / TST-013B (real PostgreSQL + pg-boss)
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { createPaper } from '../../../packages/domain/src/papers/index.ts';
import { inTransaction, type Queryable } from '../../../packages/domain/src/shared/db.ts';
import { cancelJob, claimJob, completeJob, enqueueJob, getJob } from '../../../packages/domain/src/jobs/index.ts';
import { PgBossQueue, processDelivery, relayOutbox, type JobMessage } from '../../../apps/worker/src/queue/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let ownerId: string;
const queues: PgBossQueue[] = [];

beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 10 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  ownerId = (await createOwner(pool, { username: 'alice', password: 'correct horse battery' })).id;
  // canonical effect of the synthetic job: one row per applied job (test-only table)
  await pool.query('CREATE TABLE test_job_effects (job_id uuid NOT NULL, fencing_token bigint NOT NULL, applied_at timestamptz DEFAULT clock_timestamp())');
}, 60_000);
afterAll(async () => {
  for (const q of queues) await q.stop().catch(() => {});
  await pool?.end();
  await db?.drop();
});

async function newQueue() {
  const q = new PgBossQueue({ connectionString: db.url, schema: 'pgboss' });
  queues.push(q);
  await q.start();
  return q;
}
const paper = async () => createPaper(pool, ownerId, { working_title: 'p', article_type: 'research_article' });
const enqueue = (paperId: string, key = randomUUID(), payload: Record<string, unknown> = { node_id: randomUUID() }) =>
  enqueueJob(pool, { paperId, ownerId, intent: 'draft_paragraph', idempotencyKey: key, payload });
const effects = async (jobId: string) => (await pool.query('SELECT fencing_token FROM test_job_effects WHERE job_id = $1', [jobId])).rows;
// the synthetic handler: its only canonical write is one effect row, applied under the fencing check
const handler = async () => ({ apply: async (tx: Queryable, job: { id: string }, token: number) => { await tx.query('INSERT INTO test_job_effects (job_id, fencing_token) VALUES ($1, $2)', [job.id, token]); } });

describe('TST-013A: a committed job reaches the queue after a restart, and one intent is one job', () => {
  test('enqueue commits job + outbox; a fresh relay and worker after a "restart" deliver and run it', async () => {
    const p = await paper();
    const { job, created } = await enqueue(p.id);
    expect(created).toBe(true);
    expect(job.status).toBe('QUEUED');
    // the process that enqueued dies before publishing anything: nothing in memory survives
    const q = await newQueue();
    expect(await relayOutbox(pool, (m) => q.publish(m))).toMatchObject({ published: 1, failed: 0 });
    const delivered = await q.receive(10);
    expect(delivered.map((m) => m.job_id)).toContain(job.id);
    const r = await processDelivery(pool, delivered.find((m) => m.job_id === job.id)!, { workerId: 'w1', leaseMs: 30_000, handlers: { draft_paragraph: handler } });
    expect(r.outcome).toBe('completed');
    expect((await getJob(pool, p.id, job.id))!.status).toBe('SUCCEEDED');
    expect(await effects(job.id)).toHaveLength(1);
    expect(await relayOutbox(pool, (m) => q.publish(m))).toMatchObject({ published: 0 });
  }, 60_000);

  test('the same intent (idempotency key) is registered once, also under concurrency; a different payload under the same key is refused', async () => {
    const p = await paper();
    const key = randomUUID();
    const payload = { node_id: randomUUID() };
    const results = await Promise.all(Array.from({ length: 6 }, () => enqueue(p.id, key, payload)));
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM job_outbox WHERE job_id = $1', [results[0]!.job.id]);
    expect(rows[0].n).toBe(1);
    await expect(enqueue(p.id, key, { node_id: randomUUID() })).rejects.toThrow(/idempotency/);
  });

  test("an enqueue inside a caller's transaction disappears with it when the transaction rolls back", async () => {
    const p = await paper();
    const key = randomUUID();
    await expect(inTransaction(pool, async (tx) => {
      await enqueueJob(tx, { paperId: p.id, ownerId, intent: 'draft_paragraph', idempotencyKey: key, payload: {} });
      throw new Error('canonical write failed');
    })).rejects.toThrow(/canonical write failed/);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM jobs WHERE paper_id = $1', [p.id]);
    expect(rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM job_outbox o JOIN jobs j ON j.id = o.job_id WHERE j.paper_id = $1', [p.id])).rows[0].n).toBe(0);
  });

  test('unknown intents and malformed keys are refused', async () => {
    const p = await paper();
    await expect(enqueueJob(pool, { paperId: p.id, ownerId, intent: 'run_shell', idempotencyKey: randomUUID(), payload: {} })).rejects.toThrow(/intent/);
    await expect(enqueueJob(pool, { paperId: p.id, ownerId, intent: 'draft_paragraph', idempotencyKey: '', payload: {} })).rejects.toThrow(/idempotency/);
  });
});

describe('TST-013B: publish failures and duplicate messages lose nothing and change canonical state once', () => {
  test('a failed publish keeps the message for a later attempt', async () => {
    const p = await paper();
    const { job } = await enqueue(p.id);
    const q = await newQueue();
    let failedOnce = false;
    const flaky = async (m: JobMessage) => {
      if (m.job_id === job.id && !failedOnce) {
        failedOnce = true;
        throw new Error('queue unavailable');
      }
      return q.publish(m);
    };
    const first = await relayOutbox(pool, flaky);
    expect(first.failed).toBeGreaterThanOrEqual(1);
    const row = (await pool.query('SELECT published_at, attempts, last_error FROM job_outbox WHERE job_id = $1', [job.id])).rows[0];
    expect(row.published_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toMatch(/queue unavailable/);
    await pool.query('UPDATE job_outbox SET available_at = now() WHERE job_id = $1', [job.id]); // skip the backoff wait
    expect((await relayOutbox(pool, flaky)).published).toBeGreaterThanOrEqual(1);
    expect((await pool.query('SELECT published_at FROM job_outbox WHERE job_id = $1', [job.id])).rows[0].published_at).not.toBeNull();
  }, 60_000);

  test('a crash after publishing but before marking re-publishes; the duplicate delivery does not apply twice', async () => {
    const p = await paper();
    const { job } = await enqueue(p.id);
    const q = await newQueue();
    // first relay publishes, then "crashes" before it can record that
    await expect(relayOutbox(pool, (m) => q.publish(m), { afterPublish: () => { throw new Error('process killed'); } })).rejects.toThrow(/killed/);
    expect((await pool.query('SELECT published_at FROM job_outbox WHERE job_id = $1', [job.id])).rows[0].published_at).toBeNull();
    await relayOutbox(pool, (m) => q.publish(m));
    const msgs = (await q.receive(20)).filter((m) => m.job_id === job.id);
    expect(msgs.length).toBe(2); // at-least-once: the queue really holds two messages
    const outcomes = [];
    for (const m of msgs) outcomes.push((await processDelivery(pool, m, { workerId: `w-${randomUUID()}`, leaseMs: 30_000, handlers: { draft_paragraph: handler } })).outcome);
    expect(outcomes.sort()).toEqual(['completed', 'duplicate']);
    expect(await effects(job.id)).toHaveLength(1);
  }, 60_000);

  test('concurrent deliveries of the same job: exactly one worker runs it', async () => {
    const p = await paper();
    const { job } = await enqueue(p.id);
    const msg: JobMessage = { job_id: job.id, paper_id: p.id, intent: 'draft_paragraph' };
    const outcomes = await Promise.all(Array.from({ length: 5 }, (_, i) => processDelivery(pool, msg, { workerId: `w${i}`, leaseMs: 30_000, handlers: { draft_paragraph: handler } })));
    expect(outcomes.filter((o) => o.outcome === 'completed')).toHaveLength(1);
    expect(await effects(job.id)).toHaveLength(1);
  });

  test('a worker whose lease expired cannot commit (fencing token); the new owner commits once', async () => {
    const p = await paper();
    const { job } = await enqueue(p.id);
    const a = await claimJob(pool, { jobId: job.id, workerId: 'slow', leaseMs: 100 });
    expect(a).not.toBeNull();
    expect(await claimJob(pool, { jobId: job.id, workerId: 'eager', leaseMs: 30_000 })).toBeNull(); // lease still live
    await new Promise((r) => setTimeout(r, 250));
    const b = await claimJob(pool, { jobId: job.id, workerId: 'rescuer', leaseMs: 30_000 });
    expect(b!.fencingToken).toBeGreaterThan(a!.fencingToken);
    await completeJob(pool, { jobId: job.id, fencingToken: b!.fencingToken, apply: (tx) => handler().then((h) => h.apply(tx, job, b!.fencingToken)) });
    await expect(completeJob(pool, { jobId: job.id, fencingToken: a!.fencingToken, apply: (tx) => handler().then((h) => h.apply(tx, job, a!.fencingToken)) })).rejects.toThrow(/lease|fencing/);
    expect((await effects(job.id)).map((e) => Number(e.fencing_token))).toEqual([b!.fencingToken]);
  });

  test('a stale worker cannot finish while the new lease holder is still running', async () => {
    const p = await paper();
    const { job } = await enqueue(p.id);
    const a = await claimJob(pool, { jobId: job.id, workerId: 'slow', leaseMs: 100 });
    await new Promise((r) => setTimeout(r, 250));
    const b = await claimJob(pool, { jobId: job.id, workerId: 'rescuer', leaseMs: 30_000 });
    // b is RUNNING and has not finished: a's old token must still be refused
    await expect(completeJob(pool, { jobId: job.id, fencingToken: a!.fencingToken, apply: (tx) => handler().then((h) => h.apply(tx, job, a!.fencingToken)) })).rejects.toThrow(/lease lost/);
    expect(await effects(job.id)).toHaveLength(0);
    expect((await getJob(pool, p.id, job.id))!.status).toBe('RUNNING');
    await completeJob(pool, { jobId: job.id, fencingToken: b!.fencingToken, apply: (tx) => handler().then((h) => h.apply(tx, job, b!.fencingToken)) });
    expect((await effects(job.id)).map((e) => Number(e.fencing_token))).toEqual([b!.fencingToken]);
  });

  test('a failing canonical write rolls back with the completion; the job can be retried', async () => {
    const p = await paper();
    const { job } = await enqueue(p.id);
    const c = await claimJob(pool, { jobId: job.id, workerId: 'w', leaseMs: 30_000 });
    await expect(completeJob(pool, { jobId: job.id, fencingToken: c!.fencingToken, apply: async (tx) => { await tx.query('INSERT INTO test_job_effects (job_id, fencing_token) VALUES ($1, $2)', [job.id, c!.fencingToken]); throw new Error('proposal validation failed'); } })).rejects.toThrow(/proposal validation/);
    expect(await effects(job.id)).toHaveLength(0);
    expect((await getJob(pool, p.id, job.id))!.status).toBe('RUNNING');
  });

  test('a cancelled job is not run when its message arrives', async () => {
    const p = await paper();
    const { job } = await enqueue(p.id);
    await cancelJob(pool, { paperId: p.id, jobId: job.id, ownerId });
    const r = await processDelivery(pool, { job_id: job.id, paper_id: p.id, intent: 'draft_paragraph' }, { workerId: 'w', leaseMs: 30_000, handlers: { draft_paragraph: handler } });
    expect(r.outcome).toBe('skipped');
    expect(await effects(job.id)).toHaveLength(0);
  });

  test('a message whose paper or intent does not match the job is refused', async () => {
    const p = await paper();
    const other = await paper();
    const { job } = await enqueue(p.id);
    for (const msg of [{ job_id: job.id, paper_id: other.id, intent: 'draft_paragraph' }, { job_id: job.id, paper_id: p.id, intent: 'export' }]) {
      expect((await processDelivery(pool, msg as JobMessage, { workerId: 'w', leaseMs: 30_000, handlers: { draft_paragraph: handler } })).outcome).toBe('rejected');
    }
    expect(await effects(job.id)).toHaveLength(0);
  });
});

describe('audit: every job state change is recorded in the same transaction and cannot be edited', () => {
  test('state transitions leave an append-only trail with the actor', async () => {
    const p = await paper();
    const { job } = await enqueue(p.id);
    await processDelivery(pool, { job_id: job.id, paper_id: p.id, intent: 'draft_paragraph' }, { workerId: 'auditor', leaseMs: 30_000, handlers: { draft_paragraph: handler } });
    const { rows } = await pool.query("SELECT from_state, to_state, actor FROM audit_events WHERE entity_type = 'job' AND entity_id = $1 ORDER BY id", [job.id]);
    expect(rows.map((r) => [r.from_state, r.to_state])).toEqual([[null, 'QUEUED'], ['QUEUED', 'RUNNING'], ['RUNNING', 'SUCCEEDED']]);
    expect(rows[0].actor).toBe(`owner:${ownerId}`);
    expect(rows[2].actor).toBe('worker:auditor');
    for (const sql of ["UPDATE audit_events SET actor = 'x' WHERE entity_id = $1", 'DELETE FROM audit_events WHERE entity_id = $1']) {
      await expect(pool.query(sql, [job.id])).rejects.toThrow(/immutable/);
    }
  });

  test('story approvals and evidence verification are audited too', async () => {
    const p = await paper();
    const { rows: s } = await pool.query(
      "INSERT INTO story_revisions (paper_id, brief, story, content_hash, created_by) VALUES ($1, '{}', '{}', repeat('a', 64), $2) RETURNING id",
      [p.id, ownerId],
    );
    await pool.query("UPDATE story_revisions SET status = 'IN_REVIEW' WHERE id = $1", [s[0].id]);
    const audit = (await pool.query("SELECT entity_type, from_state, to_state FROM audit_events WHERE entity_id = $1 ORDER BY id", [s[0].id])).rows;
    expect(audit).toEqual([{ entity_type: 'story_revision', from_state: null, to_state: 'DRAFT' }, { entity_type: 'story_revision', from_state: 'DRAFT', to_state: 'IN_REVIEW' }]);
  });
});

describe('jobs API', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildServer({ pool, allowedOrigins: [ORIGIN] });
    await app.ready();
  });
  afterAll(async () => app?.close());

  test('the owner lists, reads and cancels jobs; other owners see nothing', async () => {
    await createOwner(pool, { username: 'bob', password: 'another long passphrase' });
    const login = async (u: string, pw: string) => {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: u, password: pw } });
      return { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken, origin: ORIGIN };
    };
    const A = await login('alice', 'correct horse battery');
    const B = await login('bob', 'another long passphrase');
    const p = await paper();
    const { job } = await enqueue(p.id);
    const list = await app.inject({ method: 'GET', url: `/api/papers/${p.id}/jobs`, headers: A });
    expect(list.json().map((j: { id: string }) => j.id)).toContain(job.id);
    const one = (await app.inject({ method: 'GET', url: `/api/papers/${p.id}/jobs/${job.id}`, headers: A })).json();
    expect(one).toMatchObject({ id: job.id, status: 'QUEUED', intent: 'draft_paragraph' });
    expect(one.lease_owner).toBeUndefined(); // worker internals are not exposed
    expect((await app.inject({ method: 'GET', url: `/api/papers/${p.id}/jobs/${job.id}`, headers: B })).statusCode).toBe(404);
    const c = await app.inject({ method: 'POST', url: `/api/papers/${p.id}/jobs/${job.id}/cancel`, headers: A, payload: {} });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().status).toBe('CANCELLED');
    expect((await app.inject({ method: 'POST', url: `/api/papers/${p.id}/jobs/${job.id}/cancel`, headers: A, payload: {} })).json().status).toBe('CANCELLED');
  });
});
