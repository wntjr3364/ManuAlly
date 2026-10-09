// PW-013 — regression tests for the independent review (M1 and minors 1–9)
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { createPaper } from '../../../packages/domain/src/papers/index.ts';
import { inTransaction, type Queryable } from '../../../packages/domain/src/shared/db.ts';
import { MAX_ATTEMPTS, claimJob, completeJob, enqueueJob, failJob, getJob, heartbeatJob, recoverJobs } from '../../../packages/domain/src/jobs/index.ts';
import { JobOutcomeError, PgBossQueue, processDelivery, relayOutbox } from '../../../apps/worker/src/queue/index.ts';

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
  await pool.query('CREATE TABLE test_job_effects (job_id uuid NOT NULL, fencing_token bigint NOT NULL)');
}, 60_000);
afterAll(async () => {
  for (const q of queues) await q.stop().catch(() => {});
  await pool?.end();
  await db?.drop();
});

const paper = async () => createPaper(pool, ownerId, { working_title: 'p', article_type: 'research_article' });
const enqueue = (paperId: string, payload: Record<string, unknown> = { n: randomUUID() }) =>
  enqueueJob(pool, { paperId, ownerId, intent: 'draft_paragraph', idempotencyKey: randomUUID(), payload });
const effects = async (jobId: string) => (await pool.query('SELECT 1 FROM test_job_effects WHERE job_id = $1', [jobId])).rowCount;
const handler = async () => ({ apply: async (tx: Queryable, job: { id: string }, token: number) => { await tx.query('INSERT INTO test_job_effects VALUES ($1, $2)', [job.id, token]); } });
const handlers = { draft_paragraph: handler };
const expireLease = (jobId: string) => pool.query("UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [jobId]);
const pendingOutbox = async (jobId: string) => Number((await pool.query('SELECT count(*) AS n FROM job_outbox WHERE job_id = $1 AND published_at IS NULL', [jobId])).rows[0].n);
async function newQueue() {
  const q = new PgBossQueue({ connectionString: db.url, schema: 'pgboss' });
  queues.push(q);
  await q.start();
  return q;
}
async function deliverAll(q: PgBossQueue) {
  await relayOutbox(pool, (m) => q.publish(m));
  return q.receive(50);
}

describe('review M1: a worker crash never loses a committed job', () => {
  test('crash after receiving the message: recovery re-dispatches and the job completes once', async () => {
    const p = await paper();
    const { job } = await enqueue(p.id);
    const q = await newQueue();
    expect((await deliverAll(q)).some((m) => m.job_id === job.id)).toBe(true); // received, then the worker dies
    expect(await pendingOutbox(job.id)).toBe(0);
    await recoverJobs(pool, { redispatchAfterMs: 0 });
    const again = (await deliverAll(q)).filter((m) => m.job_id === job.id);
    expect(again).toHaveLength(1);
    expect((await processDelivery(pool, again[0]!, { workerId: 'w2', leaseMs: 30_000, handlers })).outcome).toBe('completed');
    expect(await effects(job.id)).toBe(1);
  }, 60_000);

  test('crash after claiming: once the lease expires, recovery re-queues and a new worker completes once', async () => {
    const p = await paper();
    const { job } = await enqueue(p.id);
    const dead = await claimJob(pool, { jobId: job.id, workerId: 'dies', leaseMs: 30_000 });
    expect(dead).not.toBeNull();
    await recoverJobs(pool, { redispatchAfterMs: 0 });
    expect((await getJob(pool, p.id, job.id))!.status).toBe('RUNNING'); // live lease: left alone
    await expireLease(job.id);
    await recoverJobs(pool, { redispatchAfterMs: 0 });
    expect((await getJob(pool, p.id, job.id))!.status).toBe('QUEUED');
    const q = await newQueue();
    const msg = (await deliverAll(q)).find((m) => m.job_id === job.id)!;
    expect((await processDelivery(pool, msg, { workerId: 'w2', leaseMs: 30_000, handlers })).outcome).toBe('completed');
    await expect(completeJob(pool, { jobId: job.id, fencingToken: dead!.fencingToken })).rejects.toThrow(/lease lost/);
    expect(await effects(job.id)).toBe(1);
  }, 60_000);

  test('a job whose lease keeps expiring stops after MAX_ATTEMPTS instead of looping', async () => {
    const p = await paper();
    const { job } = await enqueue(p.id);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await claimJob(pool, { jobId: job.id, workerId: `w${i}`, leaseMs: 30_000 });
      await expireLease(job.id);
      await recoverJobs(pool, { redispatchAfterMs: 0 });
    }
    const j = (await getJob(pool, p.id, job.id))!;
    expect(j.status).toBe('FAILED');
    expect(j.last_error).toMatch(/lease/);
  });
});

describe('review minors 1–2: every QUEUED transition is dispatched; errors map to waiting states', () => {
  test('retry and WAITING_* -> QUEUED both create a dispatch message (with backoff for retry)', async () => {
    const p = await paper();
    const { job } = await enqueue(p.id);
    await relayOutbox(pool, async () => {});
    const c = await claimJob(pool, { jobId: job.id, workerId: 'w', leaseMs: 30_000 });
    await failJob(pool, { jobId: job.id, fencingToken: c!.fencingToken, error: 'temporary', next: 'retry' });
    const row = (await pool.query('SELECT available_at > clock_timestamp() AS later FROM job_outbox WHERE job_id = $1 AND published_at IS NULL', [job.id])).rows;
    expect(row).toEqual([{ later: true }]);
    await relayOutbox(pool, async () => {}); // not due yet: stays pending
    expect(await pendingOutbox(job.id)).toBe(1);
    const c2 = await claimJob(pool, { jobId: job.id, workerId: 'w', leaseMs: 30_000 });
    await failJob(pool, { jobId: job.id, fencingToken: c2!.fencingToken, error: '429', next: 'WAITING_QUOTA' });
    await pool.query("UPDATE job_outbox SET available_at = clock_timestamp() WHERE job_id = $1", [job.id]);
    await relayOutbox(pool, async () => {});
    await pool.query("UPDATE jobs SET status = 'QUEUED' WHERE id = $1", [job.id]); // resumed (P02/P03 scheduler)
    expect(await pendingOutbox(job.id)).toBe(1);
  });

  test('a handler error that names a waiting state parks the job instead of burning retries', async () => {
    const p = await paper();
    const { job } = await enqueue(p.id);
    const quota = async () => { throw new JobOutcomeError('rate limited (429)', 'WAITING_QUOTA'); };
    const r = await processDelivery(pool, { job_id: job.id, paper_id: p.id, intent: 'draft_paragraph' }, { workerId: 'w', leaseMs: 30_000, handlers: { draft_paragraph: quota } });
    expect(r.outcome).toBe('failed');
    expect((await getJob(pool, p.id, job.id))!.status).toBe('WAITING_QUOTA');
  });
});

describe('review minors 3–6: actor, payload and lease input', () => {
  test('completion is attributed to the worker even when apply enqueues a follow-up job', async () => {
    const p = await paper();
    const { job } = await enqueue(p.id);
    const c = await claimJob(pool, { jobId: job.id, workerId: 'wk', leaseMs: 30_000 });
    await completeJob(pool, { jobId: job.id, fencingToken: c!.fencingToken, apply: async (tx) => { await enqueueJob(tx, { paperId: p.id, ownerId, intent: 'review', idempotencyKey: randomUUID(), payload: {} }); } });
    const { rows } = await pool.query("SELECT actor FROM audit_events WHERE entity_id = $1 AND to_state = 'SUCCEEDED'", [job.id]);
    expect(rows[0].actor).toBe('worker:wk');
  });

  test('a job enqueued outside an explicit transaction still gets its dispatch message atomically', async () => {
    const p = await paper();
    const c = await pool.connect();
    try {
      const { job } = await enqueueJob(c, { paperId: p.id, ownerId, intent: 'export', idempotencyKey: randomUUID(), payload: {} });
      expect(await pendingOutbox(job.id)).toBe(1);
    } finally {
      c.release();
    }
  });

  test('payloads must be plain JSON; dates, BigInt, functions and class instances are refused', async () => {
    const p = await paper();
    for (const payload of [{ at: new Date(1) }, { n: 10n }, { f: () => 1 }, { m: new Map() }, { x: Number.NaN }, { y: Infinity }]) {
      await expect(enqueue(p.id, payload as Record<string, unknown>), String(Object.keys(payload))).rejects.toThrow(/payload/);
    }
  });

  test('lease lengths are bounded integers; an owner/paper mismatch is not-found, not a raw FK error', async () => {
    const p = await paper();
    const { job } = await enqueue(p.id);
    for (const leaseMs of [0, -1000, Number.NaN, Infinity, 1.5, 10 * 3_600_000]) {
      await expect(claimJob(pool, { jobId: job.id, workerId: 'w', leaseMs }), String(leaseMs)).rejects.toThrow(/lease/);
    }
    const c = await claimJob(pool, { jobId: job.id, workerId: 'w', leaseMs: 30_000 });
    expect(await heartbeatJob(pool, { jobId: job.id, fencingToken: c!.fencingToken, leaseMs: 30_000 })).toBe(true);
    expect(await heartbeatJob(pool, { jobId: job.id, fencingToken: c!.fencingToken - 1, leaseMs: 30_000 })).toBe(false);
    const bob = (await createOwner(pool, { username: `bob-${randomUUID()}`, password: 'another long passphrase' })).id;
    await expect(enqueueJob(pool, { paperId: p.id, ownerId: bob, intent: 'export', idempotencyKey: randomUUID(), payload: {} })).rejects.toThrow(/not found/);
  });
});

describe('review minors 7–8: job guard and audit coverage', () => {
  test('direct SQL cannot rewrite a running or finished job', async () => {
    const p = await paper();
    const { job } = await enqueue(p.id);
    await claimJob(pool, { jobId: job.id, workerId: 'w', leaseMs: 30_000 });
    for (const sql of [
      'UPDATE jobs SET attempts = 0 WHERE id = $1',
      "UPDATE jobs SET result = '{}' WHERE id = $1",
      'UPDATE jobs SET finished_at = now() WHERE id = $1',
    ]) await expect(pool.query(sql, [job.id]), sql).rejects.toThrow(/transition|immutable|check/);
    await pool.query("UPDATE jobs SET status = 'CANCELLED', finished_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE id = $1", [job.id]);
    await expect(pool.query('UPDATE jobs SET last_error = last_error WHERE id = $1', [job.id])).rejects.toThrow(/immutable/);
    await expect(pool.query("UPDATE jobs SET status = 'FAILED' WHERE id = $1", [job.id])).rejects.toThrow(/transition|immutable/);
  });

  test('per-node outline approvals and active pointer changes are audited', async () => {
    const p = await paper();
    const s = (await pool.query("INSERT INTO story_revisions (paper_id, brief, story, content_hash, created_by) VALUES ($1, '{}', '{}', repeat('a', 64), $2) RETURNING id", [p.id, ownerId])).rows[0].id;
    await inTransaction(pool, async (tx) => {
      await tx.query("UPDATE story_revisions SET status = 'APPROVED', approved_by = $2, approved_at = now() WHERE id = $1", [s, ownerId]);
      await tx.query('UPDATE paper_projects SET active_story_revision_id = $2 WHERE id = $1', [p.id, s]);
    });
    const n = randomUUID();
    const o = await inTransaction(pool, async (tx) => {
      const id = (await tx.query<{ id: string }>("INSERT INTO outline_revisions (paper_id, story_revision_id, content_hash, created_by) VALUES ($1, $2, repeat('b', 64), $3) RETURNING id", [p.id, s, ownerId])).rows[0]!.id;
      await tx.query("INSERT INTO outline_nodes (outline_revision_id, paper_id, node_id, position, section, role, paragraph_goal) VALUES ($1, $2, $3, 0, 'R', 'result', 'g')", [id, p.id, n]);
      return id;
    });
    await pool.query("INSERT INTO outline_node_approvals (outline_revision_id, paper_id, node_id, content_hash, approved_by) VALUES ($1, $2, $3, repeat('b', 64), $4)", [o, p.id, n, ownerId]);
    const actions = (await pool.query('SELECT entity_type, action, to_state FROM audit_events WHERE paper_id = $1 ORDER BY id', [p.id])).rows;
    expect(actions).toEqual(expect.arrayContaining([
      { entity_type: 'paper', action: 'active_story_changed', to_state: s },
      { entity_type: 'outline_node', action: 'approved', to_state: 'APPROVED' },
    ]));
  });
});
