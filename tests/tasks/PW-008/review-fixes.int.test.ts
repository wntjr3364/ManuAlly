// PW-008 — regression tests for the independent review findings (TST-008A/B hardening)
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner, DUMMY_HASH } from '../../../apps/api/src/auth/owners.ts';
import { hashPassword } from '../../../apps/api/src/auth/passwords.ts';

const ORIGIN = 'http://127.0.0.1:5173';
const dbs: { url: string; drop: () => Promise<void> }[] = [];
const pools: pg.Pool[] = [];
const apps: FastifyInstance[] = [];

async function fresh(opts: { max?: number } = {}) {
  const db = await createTempDatabase();
  dbs.push(db);
  const pool = new pg.Pool({ connectionString: db.url, max: 8 });
  pools.push(pool);
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  const app = buildServer({ pool, allowedOrigins: [ORIGIN], loginRateLimit: { max: opts.max ?? 3, windowMs: 60_000 } });
  apps.push(app);
  await app.ready();
  return { app, pool };
}
afterAll(async () => {
  for (const a of apps) await a.close();
  for (const p of pools) await p.end();
  for (const d of dbs) await d.drop();
});

let app: FastifyInstance;
let pool: pg.Pool;
beforeAll(async () => {
  ({ app, pool } = await fresh());
  await createOwner(pool, { username: 'alice', password: 'correct horse battery' });
});

describe('review M1: login timing does not reveal whether a username exists', () => {
  test('the dummy hash has the same shape as a real one, so scrypt runs for unknown users', async () => {
    expect(DUMMY_HASH.split('$').length).toBe((await hashPassword('x'.repeat(12))).split('$').length);
  });

  test('unknown and known usernames take comparable time', async () => {
    const time = async (username: string) => {
      const t = performance.now();
      await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, remoteAddress: `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, payload: { username, password: 'wrong password!!' } });
      return performance.now() - t;
    };
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 5; i++) {
      known.push(await time('alice'));
      unknown.push(await time('nobody-here'));
    }
    expect(median(unknown)).toBeGreaterThan(median(known) * 0.4);
  });
});

describe('review M2: concurrent wrong passwords cannot exceed the rate limit', () => {
  test('20 parallel attempts with max 3 → at most 3 reach password checking', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, remoteAddress: '10.2.2.2', payload: { username: 'alice', password: 'wrong password!!' } })));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(3);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(17);
  });
});

describe('review M3: concurrent setup creates exactly one owner', () => {
  test('4 parallel setups on an empty database → one 201, three 409', async () => {
    const f = await fresh();
    const res = await Promise.all(['a1', 'a2', 'a3', 'a4'].map((u) => f.app.inject({ method: 'POST', url: '/api/setup', headers: { origin: ORIGIN }, payload: { username: `owner-${u}`, password: 'correct horse battery' } })));
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409]);
    expect((await f.pool.query('SELECT count(*)::int AS n FROM owners')).rows[0].n).toBe(1);
  });
});

describe('review M4: authentication is decided by the matched route, not the raw URL', () => {
  test('percent-encoded prefixes get the same checks as plain ones', async () => {
    const login = await app.inject({ method: 'POST', url: '/%61pi/auth/login', payload: { username: 'alice', password: 'correct horse battery' } });
    expect(login.statusCode).toBe(403);
    expect(login.headers['set-cookie']).toBeUndefined();
    for (const [method, url] of [['GET', '/%61pi/papers'], ['GET', '/api/%70apers'], ['POST', '/%61pi/auth/logout']] as const) {
      const res = await app.inject({ method, url, headers: { origin: ORIGIN }, payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  test('routes are private unless declared public', async () => {
    const f = await fresh();
    const app2 = buildServer({ pool: f.pool, allowedOrigins: [ORIGIN] });
    apps.push(app2);
    app2.get('/api/new-feature', async () => ({ secret: true }));
    await app2.ready();
    expect((await app2.inject({ method: 'GET', url: '/api/new-feature' })).statusCode).toBe(401);
  });

  test('paper routes must use :paperId as the paper parameter', async () => {
    const f = await fresh();
    const app3 = buildServer({ pool: f.pool, allowedOrigins: [ORIGIN] });
    apps.push(app3);
    await expect((async () => {
      app3.get('/api/papers/:id/leak', async () => ({}));
      await app3.ready();
    })()).rejects.toThrow(/:paperId/);
  });
});

describe('review M5: errors never leak internals', () => {
  test('NUL bytes are a 422, malformed cookies a 401, unexpected errors a generic 500', async () => {
    const s = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, remoteAddress: '10.5.5.5', payload: { username: 'alice', password: 'correct horse battery' } });
    const cookie = String(s.headers['set-cookie']).split(';')[0]!;
    const h = { cookie, 'x-pw-csrf': s.json().csrfToken, origin: ORIGIN };
    const nul = await app.inject({ method: 'POST', url: '/api/papers', headers: h, payload: { working_title: 'a\u0000b', article_type: 'research_article' } });
    expect(nul.statusCode).toBe(422);
    expect(nul.body).not.toMatch(/22021|UTF8|byte sequence/);
    const bad = await app.inject({ method: 'GET', url: '/api/papers', headers: { cookie: 'pw_session=%E0%A4%A' } });
    expect(bad.statusCode).toBe(401);
    const f = await fresh();
    const app4 = buildServer({ pool: f.pool, allowedOrigins: [ORIGIN] });
    apps.push(app4);
    app4.get('/api/boom', { config: { public: true } }, async () => { throw new Error('relation "secret_table" does not exist'); });
    await app4.ready();
    const boom = await app4.inject({ method: 'GET', url: '/api/boom' });
    expect(boom.statusCode).toBe(500);
    expect(boom.body).not.toContain('secret_table');
  });
});

describe('review minors', () => {
  test('the CSRF token is stable for a session, so several tabs keep working', async () => {
    const s = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, remoteAddress: '10.6.6.6', payload: { username: 'alice', password: 'correct horse battery' } });
    const cookie = String(s.headers['set-cookie']).split(';')[0]!;
    const t1 = (await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } })).json().csrfToken;
    const t2 = (await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } })).json().csrfToken;
    expect(t1).toBe(t2);
    expect(t1).toBe(s.json().csrfToken);
  });

  test('archiving an archived paper changes nothing; papers record allowed_providers', async () => {
    const s = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, remoteAddress: '10.7.7.7', payload: { username: 'alice', password: 'correct horse battery' } });
    const h = { cookie: String(s.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': s.json().csrfToken, origin: ORIGIN };
    const p = (await app.inject({ method: 'POST', url: '/api/papers', headers: h, payload: { working_title: 't', article_type: 'research_article' } })).json();
    expect(p.allowed_providers).toEqual([]);
    const a1 = (await app.inject({ method: 'POST', url: `/api/papers/${p.id}/archive`, headers: h, payload: {} })).json();
    const a2 = (await app.inject({ method: 'POST', url: `/api/papers/${p.id}/archive`, headers: h, payload: {} })).json();
    expect(a2.version).toBe(a1.version);
    expect(a2.archived_at).toBe(a1.archived_at);
  });
});
