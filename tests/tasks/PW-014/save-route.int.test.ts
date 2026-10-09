// PW-014 — the server validates manuscript JSON with the shared editor-core rules before saving.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';

const ORIGIN = 'http://127.0.0.1:5173';
const B1 = '00000000-0000-4000-8000-0000000000b1';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
let H: Record<string, string>;
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 4 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  await createOwner(pool, { username: 'alice', password: 'correct horse battery' });
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: 'alice', password: 'correct horse battery' } });
  H = { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken, origin: ORIGIN };
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});

const para = (id: string, text: string) => ({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] });

describe('manuscript saves are validated with editor-core', () => {
  test('valid and empty documents save; HTML, duplicate block ids and unknown nodes are refused with the reasons', async () => {
    const p = (await app.inject({ method: 'POST', url: '/api/papers', headers: H, payload: { working_title: 'p', article_type: 'research_article' } })).json();
    const d = (await app.inject({ method: 'POST', url: `/api/papers/${p.id}/documents`, headers: H, payload: { kind: 'manuscript' } })).json();
    let head = d.head.id;
    const save = (content_json: unknown, schema_version = 1) => app.inject({ method: 'POST', url: `/api/papers/${p.id}/documents/${d.document.id}/revisions`, headers: H, payload: { expected_head_revision_id: head, content_json, schema_version, reason: 'manual' } });
    for (const [content, code] of [
      [{ type: 'doc', content: [para(B1, 'a'), para(B1, 'b')] }, 'BLOCK_ID_DUPLICATE'],
      [{ type: 'doc', content: [{ type: 'html_block', content: [] }] }, 'RAW_HTML'],
      [{ type: 'doc', content: [para('b-1', 'a')] }, 'BLOCK_ID_INVALID'],
    ] as const) {
      const r = await save(content);
      expect(r.statusCode, code).toBe(422);
      expect(r.json().errors.map((e: { code: string }) => e.code)).toContain(code);
    }
    expect((await save({ type: 'doc', content: [para(B1, 'a')] }, 2)).json().errors[0].code).toMatch(/MIGRATION/);
    const ok = await save({ type: 'doc', content: [para(B1, 'ABC1 rose 2.4-fold')] });
    expect(ok.statusCode, ok.body).toBe(201);
    head = ok.json().id;
    expect((await save({ type: 'doc', content: [] })).statusCode).toBe(201);
  });
});
