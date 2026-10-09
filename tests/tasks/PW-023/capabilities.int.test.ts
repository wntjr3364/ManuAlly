// PW-023 — the capability matrix is available to the owner through the API (TST-023A display).
import { afterAll, beforeAll, expect, test } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 4 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  await createOwner(pool, { username: 'alice', password: 'correct horse battery' });
});
afterAll(async () => { await app?.close(); await pool?.end(); await db?.drop(); });

test('GET /api/providers/capabilities lists the matrix for a logged-in owner only', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/providers/capabilities' })).statusCode).toBe(401);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: 'alice', password: 'correct horse battery' } });
  const r = await app.inject({ method: 'GET', url: '/api/providers/capabilities', headers: { cookie: String(login.headers['set-cookie']).split(';')[0]! } });
  expect(r.statusCode).toBe(200);
  const body = r.json();
  expect(body.active).toMatchObject({ provider: 'mock', admission: 'approved', label: 'MOCK' });
  expect(body.rows).toHaveLength(9);
  expect(body.rows.find((x: { provider: string; deployment_profile: string; auth_mode: string }) => x.provider === 'codex' && x.deployment_profile === 'PERSONAL_LOCAL' && x.auth_mode === 'chatgpt_login').features.quota_read).toEqual({ state: 'unknown', note: 'documented, not verified' });
  // evidence notes stay server-side details: no paths or secrets, only the fields shown
  expect(JSON.stringify(body)).not.toMatch(/CLAUDE_CONFIG_DIR|OAUTH|token/i);
});
