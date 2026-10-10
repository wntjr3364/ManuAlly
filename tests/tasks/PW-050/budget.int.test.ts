// PW-050 — cost reservation and budget guard (spec 08 "Budget", "오류 종류별 동작": hard budget →
// WAITING_BUDGET). Before every run the worker admits it (fenced): a run that would cost money needs a
// known estimate within the owner's budgets (app, paper, provider, per run), reserved atomically; a
// subscription login (quota-limited, not charged per call) and the MOCK need none. After the run the
// reservation is settled from the usage ledger without counting anything twice. Exhausted limits never
// lead to another API, an extra payment, a reset credit or endless retries.
// TST-050A: only runs within the approved budget are admitted; per-turn and cumulative usage settle once.
// TST-050B: at a limit: no API switch, no extra payment, no reset credit, no endless retries.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { claimJob, enqueueJob } from '../../../packages/domain/src/jobs/index.ts';
import { recordUsage } from '../../../packages/domain/src/usage/index.ts';
import { listReservations, settleReservation, useJobLimit } from '../../../packages/domain/src/budget/index.ts';
import { admitRun, withAdmission, type CostClassOf } from '../../../apps/worker/src/admission/index.ts';
import { processDelivery, JobOutcomeError } from '../../../apps/worker/src/queue/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
const H: Record<string, Record<string, string>> = {};
const ids: Record<string, string> = {};
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  for (const u of ['alice', 'bob', 'carol']) {
    ids[u] = (await createOwner(pool, { username: u, password: 'correct horse battery' })).id;
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: u, password: 'correct horse battery' } });
    H[u] = { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken, origin: ORIGIN };
  }
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, headers: H[who], payload: payload as object | undefined });

// a paper of alice's and a claimed job on it
async function paper(who = 'alice') {
  return (await call(who, 'POST', '/api/papers', { working_title: 'budget paper', article_type: 'research_article' })).json().id as string;
}
async function runningJob(paperId: string, who = 'alice') {
  const { job } = await enqueueJob(pool, { paperId, ownerId: ids[who]!, intent: 'review', idempotencyKey: randomUUID(), payload: { note: 'x' } });
  const c = (await claimJob(pool, { jobId: job.id, workerId: 'w1', leaseMs: 60_000 }))!;
  return { job: c.job, fencingToken: c.fencingToken };
}
const setBudget = (body: Record<string, unknown>, who = 'alice') => call(who, 'POST', '/api/budgets', { intent: 'set_budget', ...body });
// a pay-per-use provider for these tests (in v1 no allowed login is charged per call; the guard must hold
// for one the owner might approve later)
const metered: CostClassOf = (provider, authMode) => ((provider === 'codex' || provider === 'claude_agent') && authMode === 'metered_test' ? 'metered' : provider === 'claude_agent' && authMode === 'subscription_cli_login' ? 'subscription_included' : provider === 'mock' ? 'free' : 'unknown');
const admit = (paperId: string, j: { job: { id: string }; fencingToken: number }, o: Partial<Parameters<typeof admitRun>[1]> = {}) =>
  admitRun(pool, { paperId, jobId: j.job.id, fencingToken: j.fencingToken, provider: 'codex', authMode: 'metered_test', estimateUsd: 0.4, costClassOf: metered, ...o });

describe('TST-050A: only runs within the approved budget are admitted; usage settles once', () => {
  test('the MOCK and a subscription login need no money budget; a pay-per-use run needs a known estimate within one', async () => {
    const p = await paper();
    const free = await admit(p, await runningJob(p), { provider: 'mock', authMode: 'none', estimateUsd: null });
    expect(free).toMatchObject({ cost_class: 'free', estimate_usd: null });
    const sub = await admit(p, await runningJob(p), { provider: 'claude_agent', authMode: 'subscription_cli_login', estimateUsd: null });
    expect(sub).toMatchObject({ cost_class: 'subscription_included', paid_overage: false, reset_credit: false });
    // a pay-per-use run without a budget: blocked by default
    await expect(admit(p, await runningJob(p))).rejects.toMatchObject({ next: 'WAITING_BUDGET', message: expect.stringMatching(/no budget/) });
    // with an unknown estimate: blocked
    expect((await setBudget({ scope: 'paper', paper_id: p, limit_usd: 1 })).statusCode).toBe(201);
    await expect(admit(p, await runningJob(p), { estimateUsd: null })).rejects.toMatchObject({ next: 'WAITING_BUDGET', message: expect.stringMatching(/cost is not known/) });
  });

  test('reservations count against the budget until settled; settling the actual cost frees the rest', async () => {
    const p = await paper();
    await setBudget({ scope: 'paper', paper_id: p, limit_usd: 1 });
    const r1 = await admit(p, await runningJob(p));
    await admit(p, await runningJob(p));
    // 0.4 + 0.4 reserved: another 0.4 does not fit in 1.00
    await expect(admit(p, await runningJob(p))).rejects.toMatchObject({ next: 'WAITING_BUDGET', message: expect.stringMatching(/budget/) });
    // the first run cost 0.10 in the end
    await recordUsage(pool, { paperId: p, jobId: r1.job_id, provider: 'codex', nativeSessionId: 's1', eventKey: randomUUID(), data: { scope: 'turn', input_tokens: 100, output_tokens: 10, cost_usd_estimate: 0.1, context_window: null } });
    expect(await settleReservation(pool, { reservationId: r1.id })).toMatchObject({ state: 'settled', settled_usd: '0.1000', settled_unknown: false });
    // 0.10 + 0.40 + 0.40 fits
    await admit(p, await runningJob(p));
  });

  test('a run limit, a provider budget and an app budget each bound the run', async () => {
    // (owner-wide budgets: carol's own, so other tests are not affected)
    const p = await paper('carol');
    await setBudget({ scope: 'paper', paper_id: p, limit_usd: 10, run_limit_usd: 0.3 }, 'carol');
    await expect(admit(p, await runningJob(p, 'carol'))).rejects.toMatchObject({ message: expect.stringMatching(/per run/) });
    const q = await paper('carol');
    await setBudget({ scope: 'paper', paper_id: q, limit_usd: 10 }, 'carol');
    await setBudget({ scope: 'provider', provider: 'codex', limit_usd: 0.5 }, 'carol');
    // spending on another provider does not count against the codex budget
    await admit(q, await runningJob(q, 'carol'), { provider: 'claude_agent' });
    await admit(q, await runningJob(q, 'carol'));
    await expect(admit(q, await runningJob(q, 'carol'))).rejects.toMatchObject({ message: expect.stringMatching(/codex/) });
    // other owners are not affected
    const b = await paper('bob');
    await setBudget({ scope: 'paper', paper_id: b, limit_usd: 10 }, 'bob');
    await admit(b, await runningJob(b, 'bob'));
    // an app budget of 0 stops every pay-per-use run of the owner
    await setBudget({ scope: 'provider', provider: 'codex', limit_usd: 100 }, 'carol');
    await setBudget({ scope: 'app', limit_usd: 0 }, 'carol');
    await expect(admit(q, await runningJob(q, 'carol'))).rejects.toMatchObject({ message: expect.stringMatching(/app/) });
  });

  test('settlement counts a run once: its turn costs (Claude-like), or its cumulative session reports by their deltas (Codex-like); never message rows or a duplicate', async () => {
    const p = await paper();
    await setBudget({ scope: 'paper', paper_id: p, limit_usd: 10 });
    const k1 = randomUUID();
    const k2 = randomUUID();
    const u = (jobId: string, scope: 'message' | 'turn' | 'session', session: string, cost: number | null, key: string = randomUUID()) =>
      recordUsage(pool, { paperId: p, jobId, provider: 'codex', nativeSessionId: session, eventKey: key, data: { scope, input_tokens: 100, output_tokens: 10, cost_usd_estimate: cost, context_window: null } });
    // turn reports: two turns, message rows in between (no cost), one turn reported twice (same key)
    const j1 = await runningJob(p);
    const r1 = await admit(p, j1);
    await u(j1.job.id, 'message', 'A', null); await u(j1.job.id, 'turn', 'A', 0.05, k1); await u(j1.job.id, 'message', 'A', 0.5); await u(j1.job.id, 'turn', 'A', 0.07, k2); await u(j1.job.id, 'turn', 'A', 0.07, k2);
    expect(await settleReservation(pool, { reservationId: r1.id })).toMatchObject({ settled_usd: '0.1200', settled_unknown: false });
    // cumulative session totals 0.10 then 0.25 (and its turn report of the same requests): 0.25 once
    const j2 = await runningJob(p);
    const r2 = await admit(p, j2);
    await u(j2.job.id, 'session', 'B', 0.1); await u(j2.job.id, 'turn', 'B', 0.15); await u(j2.job.id, 'session', 'B', 0.25);
    expect(await settleReservation(pool, { reservationId: r2.id })).toMatchObject({ settled_usd: '0.2500', settled_unknown: false });
    // settling again changes nothing
    await expect(settleReservation(pool, { reservationId: r1.id })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('a later run of the same job settles only its own reports', async () => {
    const p = await paper();
    await setBudget({ scope: 'paper', paper_id: p, limit_usd: 10 });
    const { job } = await enqueueJob(pool, { paperId: p, ownerId: ids.alice!, intent: 'review', idempotencyKey: randomUUID(), payload: { note: 'two runs' } });
    let c = (await claimJob(pool, { jobId: job.id, workerId: 'w1', leaseMs: 60_000 }))!;
    const r1 = await admit(p, { job: c.job, fencingToken: c.fencingToken });
    await recordUsage(pool, { paperId: p, jobId: job.id, provider: 'codex', nativeSessionId: 'A', eventKey: randomUUID(), data: { scope: 'turn', input_tokens: 1, output_tokens: 1, cost_usd_estimate: 0.3, context_window: null } });
    await pool.query("UPDATE jobs SET status = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1", [job.id]);
    c = (await claimJob(pool, { jobId: job.id, workerId: 'w1', leaseMs: 60_000 }))!;
    const r2 = await admit(p, { job: c.job, fencingToken: c.fencingToken });
    await recordUsage(pool, { paperId: p, jobId: job.id, provider: 'codex', nativeSessionId: 'B', eventKey: randomUUID(), data: { scope: 'turn', input_tokens: 1, output_tokens: 1, cost_usd_estimate: 0.02, context_window: null } });
    expect(await settleReservation(pool, { reservationId: r2.id })).toMatchObject({ settled_usd: '0.0200' });
    // the first run, settled late, counts only what came before the second began
    expect(await settleReservation(pool, { reservationId: r1.id })).toMatchObject({ settled_usd: '0.3000' });
  });

  test('a cost that was not reported is UNKNOWN: the reservation keeps counting', async () => {
    const p = await paper();
    await setBudget({ scope: 'paper', paper_id: p, limit_usd: 1 });
    const j = await runningJob(p);
    const r = await admit(p, j, { estimateUsd: 0.6 });
    await recordUsage(pool, { paperId: p, jobId: j.job.id, provider: 'codex', nativeSessionId: 'A', eventKey: randomUUID(), data: { scope: 'turn', input_tokens: 100, output_tokens: 10, cost_usd_estimate: null, context_window: null } });
    expect(await settleReservation(pool, { reservationId: r.id })).toMatchObject({ settled_unknown: true });
    // still counted at its reservation: 0.6 + 0.6 > 1
    await expect(admit(p, await runningJob(p), { estimateUsd: 0.6 })).rejects.toMatchObject({ next: 'WAITING_BUDGET' });
  });
});

describe('TST-050B: at a limit — no API switch, no extra payment, no reset credit, no endless retries', () => {
  test('extra payment, a reset credit or an API key are never admitted', async () => {
    const p = await paper();
    await setBudget({ scope: 'paper', paper_id: p, limit_usd: 100 });
    for (const o of [{ paidOverage: true }, { resetCredit: true }]) {
      await expect(admit(p, await runningJob(p), { provider: 'claude_agent', authMode: 'subscription_cli_login', estimateUsd: null, ...o })).rejects.toMatchObject({ next: 'WAITING_USER' });
    }
    await expect(admit(p, await runningJob(p), { provider: 'claude_agent', authMode: 'api_key' })).rejects.toMatchObject({ next: 'WAITING_USER', message: expect.stringMatching(/API key/) });
    // a login whose cost class is not known is not run
    await expect(admit(p, await runningJob(p), { provider: 'codex', authMode: 'something_new', estimateUsd: 0.01 })).rejects.toMatchObject({ next: 'WAITING_BUDGET' });
  });

  test('a job keeps its provider and login; its runs are bounded', async () => {
    const p = await paper();
    const { job } = await enqueueJob(pool, { paperId: p, ownerId: ids.alice!, intent: 'review', idempotencyKey: randomUUID(), payload: { note: 'y' } });
    const claimAgain = async () => {
      await pool.query("UPDATE jobs SET status = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND status = 'RUNNING'", [job.id]);
      const c = (await claimJob(pool, { jobId: job.id, workerId: 'w1', leaseMs: 60_000 }))!;
      return { job: c.job, fencingToken: c.fencingToken };
    };
    const sub = { provider: 'claude_agent', authMode: 'subscription_cli_login', estimateUsd: null } as const;
    await admit(p, await claimAgain(), sub);
    // another provider for the same job: not switched on its own
    await expect(admit(p, await claimAgain(), { provider: 'codex', authMode: 'metered_test' })).rejects.toMatchObject({ next: 'WAITING_USER', message: expect.stringMatching(/provider/) });
  });

  test('at most five runs per job, whatever made them run again', async () => {
    const p = await paper();
    const { job } = await enqueueJob(pool, { paperId: p, ownerId: ids.alice!, intent: 'review', idempotencyKey: randomUUID(), payload: { note: 'z' } });
    const sub = { provider: 'mock', authMode: 'none', estimateUsd: null } as const;
    let last: unknown = null;
    for (let i = 0; i < 6; i++) {
      await pool.query("UPDATE jobs SET status = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND status = 'RUNNING'", [job.id]);
      // (the job guard limits claims too; here the admission bound is what is tested)
      const c = await claimJob(pool, { jobId: job.id, workerId: 'w1', leaseMs: 60_000 });
      if (!c) break;
      last = await admit(p, { job: c.job, fencingToken: c.fencingToken }, sub).catch((e) => e);
    }
    expect(last).toBeInstanceOf(JobOutcomeError);
    expect((last as JobOutcomeError).message).toMatch(/runs/);
    expect((await listReservations(pool, p, job.id)).length).toBe(5);
  });

  test('a budget stop is WAITING_BUDGET and stays there: the handler is not run, nothing resumes it', async () => {
    const p = await paper();
    const { job } = await enqueueJob(pool, { paperId: p, ownerId: ids.alice!, intent: 'review', idempotencyKey: randomUUID(), payload: { note: 'w' } });
    let ran = 0;
    const handlers = withAdmission(pool, { review: async () => { ran++; return { result: {} }; } }, { provider: 'codex', authMode: 'metered_test', estimateUsd: () => 0.4, costClassOf: metered });
    expect((await processDelivery(pool, { job_id: job.id, paper_id: p, intent: 'review' }, { workerId: 'w1', leaseMs: 60_000, handlers })).outcome).toBe('failed');
    expect(ran).toBe(0);
    expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [job.id])).rows[0].status).toBe('WAITING_BUDGET');
    // a delivery of a waiting job is skipped
    expect((await processDelivery(pool, { job_id: job.id, paper_id: p, intent: 'review' }, { workerId: 'w1', leaseMs: 60_000, handlers })).outcome).toBe('skipped');
  });

  test('the wrapper settles after the run, also when it failed', async () => {
    const p = await paper();
    await setBudget({ scope: 'paper', paper_id: p, limit_usd: 10 });
    const { job } = await enqueueJob(pool, { paperId: p, ownerId: ids.alice!, intent: 'review', idempotencyKey: randomUUID(), payload: { note: 'v' } });
    const handlers = withAdmission(pool, { review: async (j) => {
      await recordUsage(pool, { paperId: p, jobId: j.id, provider: 'codex', nativeSessionId: 'S', eventKey: randomUUID(), data: { scope: 'turn', input_tokens: 1, output_tokens: 1, cost_usd_estimate: 0.02, context_window: null } });
      throw new JobOutcomeError('the provider failed', 'FAILED');
    } }, { provider: 'codex', authMode: 'metered_test', estimateUsd: () => 0.4, costClassOf: metered });
    await processDelivery(pool, { job_id: job.id, paper_id: p, intent: 'review' }, { workerId: 'w1', leaseMs: 60_000, handlers });
    expect((await listReservations(pool, p, job.id)).map((r) => [r.state, r.settled_usd])).toEqual([['settled', '0.0200']]);
  });

  test('repairs and searches per job are bounded', async () => {
    const p = await paper();
    const j = await runningJob(p);
    expect(await useJobLimit(pool, { jobId: j.job.id, kind: 'repair' })).toBe(1);
    await expect(useJobLimit(pool, { jobId: j.job.id, kind: 'repair' })).rejects.toMatchObject({ code: 'CONFLICT' });
    for (let i = 1; i <= 3; i++) expect(await useJobLimit(pool, { jobId: j.job.id, kind: 'search' })).toBe(i);
    await expect(useJobLimit(pool, { jobId: j.job.id, kind: 'search' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('budgets are the owner\'s act; only the current run reserves', async () => {
    const p = await paper();
    expect((await setBudget({ scope: 'paper', paper_id: p, limit_usd: -1 })).statusCode).toBe(422);
    expect((await setBudget({ scope: 'paper', paper_id: p, limit_usd: 5 }, 'bob')).statusCode).toBe(404);
    expect((await call('alice', 'POST', '/api/budgets', { scope: 'app', limit_usd: 5 })).statusCode).toBe(422);
    const j = await runningJob(p);
    await expect(admit(p, { ...j, fencingToken: j.fencingToken - 1 }, { provider: 'mock', authMode: 'none', estimateUsd: null })).rejects.toMatchObject({ code: 'CONFLICT' });
    const st = (await call('alice', 'GET', `/api/papers/${p}/budget`)).json();
    expect(st).toMatchObject({ paper: { limit_usd: null }, reserved_usd: '0.0000', settled_usd: '0.0000' });
  });
});
