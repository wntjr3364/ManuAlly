// PW-029 — usage ledger and quota observations (spec 08).
// TST-029A: cumulative (session), turn and context metrics are kept apart in the ledger and the API.
// TST-029B: a redelivered cumulative event is not added twice; a missing reset time stays missing.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { quotaStatus, recordQuota, recordUsage, usageSummary } from '../../../packages/domain/src/usage/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
const H: Record<string, Record<string, string>> = {};
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  for (const u of ['alice', 'bob']) {
    await createOwner(pool, { username: u, password: 'correct horse battery' });
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: u, password: 'correct horse battery' } });
    H[u] = { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken, origin: ORIGIN };
  }
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});
const paper = async (who = 'alice') => (await app.inject({ method: 'POST', url: '/api/papers', headers: H[who], payload: { working_title: 'p', article_type: 'research_article' } })).json().id as string;
const u = (scope: 'message' | 'turn' | 'session', i: number | null, o: number | null, cost: number | null, window: number | null = null) => ({ scope, input_tokens: i, output_tokens: o, cost_usd_estimate: cost, context_window: window });
const S = () => randomUUID();

describe('TST-029A: cumulative, turn and context metrics are kept apart', () => {
  test('a session\'s cumulative reports become deltas; its turn reports are not added on top; context is the last request, not the total', async () => {
    const p = await paper();
    const sid = S();
    const rec = (key: string, data: ReturnType<typeof u>, at: string) => recordUsage(pool, { paperId: p, provider: 'claude_agent', nativeSessionId: sid, eventKey: `${sid}:${key}`, observedAt: at, data });
    await rec('t1', u('turn', 1000, 100, 0.01, 200_000), '2026-10-09T01:00:00Z');
    expect(await rec('s1', u('session', 1000, 100, 0.01), '2026-10-09T01:00:01Z')).toMatchObject({ delta: { input_tokens: 1000, output_tokens: 100, cost_usd: 0.01 } });
    await rec('t2', u('turn', 3000, 200, 0.02, 200_000), '2026-10-09T01:05:00Z');
    // the cumulative report also names the window: it still must not be read as the context size
    expect(await rec('s2', u('session', 4000, 300, 0.03, 200_000), '2026-10-09T01:05:01Z')).toMatchObject({ delta: { input_tokens: 3000, output_tokens: 200, cost_usd: 0.02 } });
    const s = await usageSummary(pool, p);
    // billed = the session's cumulative total, not session + turns (that would be 8000)
    expect(s.billed).toMatchObject({ input_tokens: { value: 4000, unknown: false }, output_tokens: { value: 300, unknown: false }, cost_usd_estimate: { value: 0.03, unknown: false } });
    // context = the last turn's input (3000) against the window — not the cumulative 4000
    expect(s.context).toMatchObject({ window: 200_000, last_input_tokens: 3000, used_percent: 1.5, basis: 'last_reported_message_or_turn' });
    expect(s.by_scope).toEqual({ message: 0, turn: 2, session: 2 });
    // the ledger keeps every report with its scope and raw values
    const rows = (await pool.query('SELECT scope, input_tokens, delta_input_tokens FROM usage_events WHERE paper_id = $1 ORDER BY observed_at', [p])).rows;
    expect(rows.map((r) => [r.scope, Number(r.input_tokens), r.delta_input_tokens === null ? null : Number(r.delta_input_tokens)])).toEqual([['turn', 1000, null], ['session', 1000, 1000], ['turn', 3000, null], ['session', 4000, 3000]]);
  });

  test('without session reports the turns are counted; values not reported are unknown, never 0', async () => {
    const p = await paper();
    await recordUsage(pool, { paperId: p, provider: 'codex', nativeSessionId: 'th-1', eventKey: 'th-1:tu-1', data: u('turn', 500, 50, null) });
    await recordUsage(pool, { paperId: p, provider: 'codex', nativeSessionId: 'th-1', eventKey: 'th-1:tu-2', data: u('turn', 700, null, null) });
    const s = await usageSummary(pool, p);
    expect(s.billed.input_tokens).toEqual({ value: 1200, unknown: false });
    expect(s.billed.output_tokens).toEqual({ value: 50, unknown: true }); // a lower bound
    expect(s.billed.cost_usd_estimate).toEqual({ value: 0, unknown: true });
    expect(s.context).toMatchObject({ basis: 'unknown', used_percent: null }); // no window reported
    const row = (await pool.query("SELECT unknown_fields FROM usage_events WHERE event_key = 'th-1:tu-2'")).rows[0];
    expect(row.unknown_fields.sort()).toEqual(['context_window', 'cost_usd_estimate', 'output_tokens']);
    // a paper without any report: everything unknown
    expect((await usageSummary(pool, await paper())).billed.input_tokens).toEqual({ value: null, unknown: true });
  });

  test('the API gives the owner this paper\'s summary and the quota; another owner gets nothing', async () => {
    const p = await paper();
    await recordUsage(pool, { paperId: p, provider: 'mock', nativeSessionId: null, eventKey: S(), data: u('turn', 10, 5, 0, 1000) });
    const r = await app.inject({ method: 'GET', url: `/api/papers/${p}/usage`, headers: H.alice });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ billed: { input_tokens: { value: 10 } }, context: { used_percent: 1 } });
    expect((await app.inject({ method: 'GET', url: `/api/papers/${p}/usage`, headers: H.bob })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/providers/quota', headers: H.alice })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/providers/quota' })).statusCode).toBe(401);
  });
});

describe('TST-029B: no double counting, no invented reset times', () => {
  test('the same cumulative event delivered again is stored once; a resumed session repeating its total adds nothing', async () => {
    const p = await paper();
    const sid = S();
    const ev = { paperId: p, provider: 'claude_agent' as const, nativeSessionId: sid, data: u('session', 2000, 200, 0.02) };
    expect(await recordUsage(pool, { ...ev, eventKey: `${sid}:r1` })).toMatchObject({ duplicate: false });
    expect(await recordUsage(pool, { ...ev, eventKey: `${sid}:r1` })).toMatchObject({ duplicate: true });
    // after a resume the provider repeats the same cumulative total under a new key: delta 0
    expect(await recordUsage(pool, { ...ev, eventKey: `${sid}:r2` })).toMatchObject({ duplicate: false, delta: { input_tokens: 0, output_tokens: 0, cost_usd: 0 } });
    expect((await usageSummary(pool, p)).billed.input_tokens).toEqual({ value: 2000, unknown: false });
    // concurrent deliveries of one event are stored once
    const k = `${sid}:r3`;
    const both = await Promise.allSettled([recordUsage(pool, { ...ev, eventKey: k, data: u('session', 2500, 250, 0.025) }), recordUsage(pool, { ...ev, eventKey: k, data: u('session', 2500, 250, 0.025) })]);
    expect(both.filter((x) => x.status === 'fulfilled' && !x.value.duplicate)).toHaveLength(1);
    expect((await usageSummary(pool, p)).billed.input_tokens).toEqual({ value: 2500, unknown: false });
    // turn reports are not serialized by the session lock: concurrent copies are still stored once
    const tk = `${sid}:turn-x`;
    const turns = await Promise.all(Array.from({ length: 4 }, () => recordUsage(pool, { paperId: p, provider: 'claude_agent', nativeSessionId: sid, eventKey: tk, data: u('turn', 9, 9, 0) })));
    expect(turns.filter((x) => !x.duplicate)).toHaveLength(1);
  });

  test('a cumulative total that goes down is an anomaly (not a negative cost); a late lower report does not inflate the next one', async () => {
    const p = await paper();
    const sid = S();
    const rec = (k: string, i: number) => recordUsage(pool, { paperId: p, provider: 'codex', nativeSessionId: sid, eventKey: `${sid}:${k}`, data: u('session', i, null, null) });
    await rec('a', 100);
    await rec('b', 200);
    expect(await rec('c', 150)).toMatchObject({ anomaly: 'cumulative_decreased', delta: { input_tokens: null } });
    expect(await rec('d', 250)).toMatchObject({ anomaly: null, delta: { input_tokens: 50 } }); // vs the highest so far (200), not 150
    const s = await usageSummary(pool, p);
    expect(s.billed.input_tokens).toEqual({ value: 250, unknown: false });
    expect(s.billed.anomalies).toBe(1);
  });

  test('a quota without a reset time keeps it empty with the reason; "unknown" is not 0 %; observations are kept as observed', async () => {
    await recordQuota(pool, { provider: 'claude_agent', authProfileId: 'claude-main', bucket: 'five_hour', eventKey: 'q1', observedAt: '2026-10-09T02:00:00Z', data: { status: 'warning', used_percent: 82.5, resets_at: '2026-10-09T05:00:00Z', raw_resets_at: null, unknown_reason: null } });
    await recordQuota(pool, { provider: 'claude_agent', authProfileId: 'claude-main', bucket: 'seven_day', eventKey: 'q2', observedAt: '2026-10-09T02:00:00Z', data: { status: 'unknown', used_percent: null, resets_at: null, raw_resets_at: null, unknown_reason: null } });
    await recordQuota(pool, { provider: 'codex', authProfileId: 'codex-main', bucket: 'primary', eventKey: 'q3', observedAt: '2026-10-09T02:00:00Z', data: { status: 'rejected', used_percent: 100, resets_at: null, raw_resets_at: 'in a while', unknown_reason: 'reset time in an unverified format' }, retryAfterS: 60, errorKind: 'quota' });
    expect((await recordQuota(pool, { provider: 'codex', authProfileId: 'codex-main', bucket: 'primary', eventKey: 'q3', data: { status: 'allowed', used_percent: 0, resets_at: null, raw_resets_at: null, unknown_reason: null } })).duplicate).toBe(true);
    const q = await quotaStatus(pool);
    const by = (b: string) => q.find((r) => r.bucket === b)!;
    expect(by('five_hour')).toMatchObject({ used_percent: 82.5, resets_at: '2026-10-09T05:00:00.000Z', confidence: 'provider_reported' });
    expect(by('seven_day')).toMatchObject({ used_percent: null, resets_at: null, unknown_reason: 'reset time not reported', confidence: 'unknown' });
    expect(by('primary')).toMatchObject({ status: 'rejected', resets_at: null, unknown_reason: 'reset time in an unverified format', retry_after_s: 60, error_kind: 'quota', observed_at: '2026-10-09T02:00:00.000Z' });
    // the database refuses a missing reset without a reason, and changing an observation
    await expect(pool.query("INSERT INTO quota_observations (provider, auth_profile_id, bucket, event_key, status, confidence, observed_at) VALUES ('codex', 'x', 'b', 'q9', 'allowed', 'unknown', now())")).rejects.toThrow(/check/i);
    await expect(pool.query("UPDATE quota_observations SET resets_at = now() WHERE event_key = 'q2'")).rejects.toThrow(/immutable/);
    await expect(pool.query("UPDATE usage_events SET input_tokens = 0")).rejects.toThrow(/immutable/);
  });

  test('invalid reports are refused, not stored as 0', async () => {
    const p = await paper();
    for (const data of [u('turn', -1, 0, 0), u('turn', 1.5, 0, 0), u('turn', 1, 1, -0.1), { ...u('turn', 1, 1, 0), scope: 'total' }, u('turn', 1, 1, 0, 0)]) {
      await expect(recordUsage(pool, { paperId: p, provider: 'codex', nativeSessionId: 'x', eventKey: S(), data: data as never }), JSON.stringify(data)).rejects.toThrow();
    }
    await expect(recordUsage(pool, { paperId: p, provider: 'codex', nativeSessionId: null, eventKey: S(), data: u('session', 1, 1, 0) })).rejects.toThrow(/session id/);
    await expect(recordQuota(pool, { provider: 'codex', authProfileId: 'c', bucket: 'b', eventKey: S(), data: { status: 'allowed', used_percent: 101, resets_at: null, raw_resets_at: null, unknown_reason: null } })).rejects.toThrow(/between 0 and 100/);
    await expect(recordQuota(pool, { provider: 'codex', authProfileId: 'c', bucket: 'b', eventKey: S(), data: { status: 'allowed', used_percent: 1, resets_at: 'soon', raw_resets_at: null, unknown_reason: null } })).rejects.toThrow(/resets_at/);
  });
});
