// PW-061 TST-061A (safe stop of AI, spec 12 "비상 중단"): while AI is paused a job is not started and uses no
// attempt; a result produced while the pause came is not applied; non-AI work and manual edits go on; every
// change of the control is logged.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { enqueueJob } from '../../../packages/domain/src/jobs/index.ts';
import { processDelivery, type JobHandler } from '../../../apps/worker/src/queue/index.ts';
import { aiPause, withAiPause } from '../../../apps/worker/src/ai-pause/index.ts';
import { setAiPause } from '../../../infra/deploy/pwctl.ts';

let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let paperId: string;
let ownerId: string;
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 4 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  ownerId = (await createOwner(pool, { username: 'olive', password: 'correct horse battery' })).id;
  paperId = (await pool.query("INSERT INTO paper_projects (owner_id, working_title, article_type) VALUES ($1, 'P', 'research_article') RETURNING id", [ownerId])).rows[0].id;
});
afterAll(async () => { await pool?.end(); await db?.drop(); });

const job = async (intent = 'propose_profile') => (await enqueueJob(pool, { paperId, ownerId, intent, idempotencyKey: randomUUID(), payload: { x: 1 } })).job;
const state = async (id: string) => (await pool.query<{ status: string; attempts: number; last_error: string | null; result: unknown }>('SELECT status, attempts, last_error, result FROM jobs WHERE id = $1', [id])).rows[0]!;

describe('TST-061A: the AI pause', () => {
  test('the control starts unpaused; pausing needs a reason; every change is logged', async () => {
    expect(await aiPause(pool)).toEqual({ paused: false, reason: null });
    await expect(setAiPause(pool, true, '  ')).rejects.toThrow(/reason/);
    await setAiPause(pool, true, 'provider update');
    expect(await aiPause(pool)).toEqual({ paused: true, reason: 'provider update' });
    await setAiPause(pool, false, 'update checked');
    expect(await aiPause(pool)).toEqual({ paused: false, reason: null });
    const log = (await pool.query('SELECT control, reason, actor FROM ops_control_log ORDER BY id')).rows;
    expect(log).toEqual([{ control: 'ai_pause', reason: 'provider update', actor: 'operator' }, { control: 'ai_resume', reason: 'update checked', actor: 'operator' }]);
    await expect(pool.query('UPDATE ops_control_log SET reason = $1', ['x'])).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM ops_controls')).rejects.toThrow(/immutable/);
  });

  test('paused: an AI job is not started and uses no attempt; after the pause it runs', async () => {
    let calls = 0;
    const handlers = withAiPause(pool, { propose_profile: (async () => { calls++; return { result: { done: true } }; }) as JobHandler }, { recheckS: 1 });
    await setAiPause(pool, true, 'maintenance');
    const j = await job();
    const r = await processDelivery(pool, { job_id: j.id, paper_id: paperId, intent: 'propose_profile' }, { workerId: 't', leaseMs: 30_000, handlers });
    expect(r.outcome).toBe('deferred');
    expect(calls).toBe(0);
    const s = await state(j.id);
    expect(s.status).toBe('QUEUED');
    expect(s.attempts).toBe(0);
    expect(s.last_error).toMatch(/AI is paused by the operator \(maintenance\).*\[ai_paused\]/);
    await setAiPause(pool, false, 'done');
    const r2 = await processDelivery(pool, { job_id: j.id, paper_id: paperId, intent: 'propose_profile' }, { workerId: 't', leaseMs: 30_000, handlers });
    expect(r2.outcome).toBe('completed');
    expect(calls).toBe(1);
    expect((await state(j.id)).status).toBe('SUCCEEDED');
  });

  test('a pause that comes while a job runs: its result is not applied, and the job runs again later', async () => {
    let applied = 0;
    const handlers = withAiPause(pool, {
      propose_profile: (async () => {
        await setAiPause(pool, true, 'stop now'); // the operator pauses while the call is in flight
        return { apply: async () => { applied++; }, result: { done: true } };
      }) as JobHandler,
    }, { recheckS: 1 });
    const j = await job();
    const r = await processDelivery(pool, { job_id: j.id, paper_id: paperId, intent: 'propose_profile' }, { workerId: 't', leaseMs: 30_000, handlers });
    expect(r.outcome).toBe('deferred');
    expect(applied).toBe(0);
    const s = await state(j.id);
    expect(s.status).toBe('QUEUED');
    expect(s.result).toBeNull();
    expect(s.last_error).toMatch(/paused while this job ran \(stop now\); its result was not applied/);
    await setAiPause(pool, false, 'ok');
  });

  test('without the control row (an unprepared database) AI counts as paused, never as running unchecked', async () => {
    const fake = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
    expect(await aiPause(fake)).toEqual({ paused: true, reason: 'operations controls are missing' });
  });
});
