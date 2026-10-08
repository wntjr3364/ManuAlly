// PW-008 — TST-008A / TST-008B (real PostgreSQL)
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { getPaper } from '../../../packages/domain/src/papers/index.ts';
import type { FastifyInstance } from 'fastify';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;

interface Session { cookie: string; csrf: string; ownerId: string }

async function login(username: string, password: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username, password } });
  expect(res.statusCode, res.body).toBe(200);
  const setCookie = String(res.headers['set-cookie']);
  return { cookie: setCookie.split(';')[0]!, csrf: res.json().csrfToken, ownerId: res.json().owner.id };
}
const as = (s: Session) => ({ cookie: s.cookie, 'x-pw-csrf': s.csrf, origin: ORIGIN });

let A: Session;
let B: Session;

beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 4 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN], loginRateLimit: { max: 5, windowMs: 60_000 } });
  await app.ready();
  // first owner through the one-time setup endpoint; a second test owner directly (multi-owner exists only for IDOR tests)
  const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: { origin: ORIGIN }, payload: { username: 'alice', password: 'correct horse battery' } });
  expect(setup.statusCode, setup.body).toBe(201);
  await createOwner(pool, { username: 'bob', password: 'another long passphrase' });
  A = await login('alice', 'correct horse battery');
  B = await login('bob', 'another long passphrase');
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});

async function createPaper(s: Session, title: string) {
  const res = await app.inject({ method: 'POST', url: '/api/papers', headers: as(s), payload: { working_title: title, article_type: 'research_article' } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

describe('TST-008A: owner session and independent paper projects', () => {
  test('setup works once; afterwards it is closed', async () => {
    const again = await app.inject({ method: 'POST', url: '/api/setup', headers: { origin: ORIGIN }, payload: { username: 'mallory', password: 'whatever passphrase' } });
    expect(again.statusCode).toBe(409);
  });

  test('session cookie is HttpOnly + SameSite=Strict; the token is stored only as a hash', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: 'alice', password: 'correct horse battery' } });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const token = decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1', [token]);
    expect(rows[0].n).toBe(0);
    const { rows: pw } = await pool.query("SELECT password_hash FROM owners WHERE username = 'alice'");
    expect(pw[0].password_hash).toMatch(/^scrypt\$/);
  });

  test('wrong password is 401 and repeated failures are rate limited', async () => {
    const bad = () => app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN, 'x-forwarded-for': '10.9.9.9' }, remoteAddress: '10.9.9.9', payload: { username: 'alice', password: 'nope' } });
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await bad()).statusCode);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  test('two papers are created and edited independently; stale edits conflict; archive hides but keeps', async () => {
    const p1 = await createPaper(A, 'Paper one');
    const p2 = await createPaper(A, 'Paper two');
    expect(p1.id).not.toBe(p2.id);
    expect(p1.owner_id).toBe(A.ownerId);
    const list = (await app.inject({ method: 'GET', url: '/api/papers', headers: as(A) })).json();
    expect(list.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([p1.id, p2.id]));

    const upd = await app.inject({ method: 'PATCH', url: `/api/papers/${p1.id}`, headers: as(A), payload: { expected_version: p1.version, working_title: 'Paper one (renamed)' } });
    expect(upd.statusCode, upd.body).toBe(200);
    expect(upd.json().version).toBe(p1.version + 1);
    const stale = await app.inject({ method: 'PATCH', url: `/api/papers/${p1.id}`, headers: as(A), payload: { expected_version: p1.version, working_title: 'lost update' } });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: `/api/papers/${p2.id}`, headers: as(A) })).json().working_title).toBe('Paper two');

    const arch = await app.inject({ method: 'POST', url: `/api/papers/${p2.id}/archive`, headers: as(A), payload: {} });
    expect(arch.statusCode).toBe(200);
    const active = (await app.inject({ method: 'GET', url: '/api/papers', headers: as(A) })).json();
    expect(active.map((p: { id: string }) => p.id)).not.toContain(p2.id);
    const all = (await app.inject({ method: 'GET', url: '/api/papers?include=archived', headers: as(A) })).json();
    expect(all.find((p: { id: string }) => p.id === p2.id).status).toBe('archived');
    expect((await app.inject({ method: 'DELETE', url: `/api/papers/${p2.id}`, headers: as(A) })).statusCode).toBe(404);
  });

  test('invalid input is a 422 with the field named', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/papers', headers: as(A), payload: { working_title: '', article_type: 'novel' } });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/working_title|article_type/);
  });

  test('state-changing requests need the CSRF token and an allowed Origin', async () => {
    const noCsrf = await app.inject({ method: 'POST', url: '/api/papers', headers: { cookie: A.cookie, origin: ORIGIN }, payload: { working_title: 'x', article_type: 'research_article' } });
    expect(noCsrf.statusCode).toBe(403);
    const badOrigin = await app.inject({ method: 'POST', url: '/api/papers', headers: { ...as(A), origin: 'https://evil.example' }, payload: { working_title: 'x', article_type: 'research_article' } });
    expect(badOrigin.statusCode).toBe(403);
    const otherCsrf = await app.inject({ method: 'POST', url: '/api/papers', headers: { ...as(A), 'x-pw-csrf': B.csrf }, payload: { working_title: 'x', article_type: 'research_article' } });
    expect(otherCsrf.statusCode).toBe(403);
  });

  test('logout revokes the session', async () => {
    const s = await login('bob', 'another long passphrase');
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: as(s), payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/papers', headers: as(s) })).statusCode).toBe(401);
  });
});

describe('TST-008B: another owner gets nothing back', () => {
  test("owner B cannot read, list, edit or archive owner A's paper, and learns nothing about it", async () => {
    const secret = await createPaper(A, 'Unpublished virome results — SECRET-TITLE');
    for (const req of [
      { method: 'GET' as const, url: `/api/papers/${secret.id}` },
      { method: 'PATCH' as const, url: `/api/papers/${secret.id}`, payload: { expected_version: secret.version, working_title: 'pwned' } },
      { method: 'POST' as const, url: `/api/papers/${secret.id}/archive`, payload: {} },
      { method: 'POST' as const, url: `/api/papers/${secret.id}/unarchive`, payload: {} },
    ]) {
      const res = await app.inject({ ...req, headers: as(B) });
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(404);
      expect(res.body).not.toContain('SECRET-TITLE');
    }
    const listB = (await app.inject({ method: 'GET', url: '/api/papers?include=archived', headers: as(B) })).body;
    expect(listB).not.toContain(secret.id);
    expect((await app.inject({ method: 'GET', url: `/api/papers/${secret.id}`, headers: as(A) })).json().working_title).toContain('SECRET-TITLE');
    // domain layer: the owner id is part of every lookup
    expect(await getPaper(pool, B.ownerId, secret.id)).toBeNull();
  });

  test('every registered paper-scoped route (present and future: SSE, blobs, search …) is owner-checked', async () => {
    const victim = await createPaper(A, 'victim');
    const routes = app.paperScopedRoutes();
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      const url = r.url.replace(':paperId', victim.id).replace(/:(\w+)/g, '00000000-0000-4000-8000-000000000000');
      const method = r.method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
      const asB = await app.inject({ method, url, headers: as(B), payload: method === 'GET' ? undefined : {} });
      expect(asB.statusCode, `${r.method} ${r.url} as other owner`).toBe(404);
      const anon = await app.inject({ method, url, headers: { origin: ORIGIN }, payload: method === 'GET' ? undefined : {} });
      expect(anon.statusCode, `${r.method} ${r.url} anonymous`).toBe(401);
    }
  });

  test('a paper-scoped route registered without the owner check stops the server from starting', async () => {
    const bad = buildServer({ pool, allowedOrigins: [ORIGIN] });
    await expect((async () => {
      bad.get('/api/papers/:paperId/leak', async () => ({ leaked: true }));
      await bad.ready();
    })()).rejects.toThrow(/paper-scoped/);
    await bad.close().catch(() => {});
  });

  test('malformed or unknown paper ids are 404, not 500', async () => {
    for (const id of ['not-a-uuid', '00000000-0000-4000-8000-000000000000', "1' OR '1'='1"]) {
      expect((await app.inject({ method: 'GET', url: `/api/papers/${encodeURIComponent(id)}`, headers: as(A) })).statusCode, id).toBe(404);
    }
  });
});
