// PW-015 — TST-015B (server side): an editor save that is resent because its answer was lost is
// recognised as the save that already happened; anything else that moved the head stays a conflict.
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
const REF = '00000000-0000-4000-8000-0000000000f1';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
const H: Record<string, Record<string, string>> = {};
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 4 });
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

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', attrs: { id: B1 }, content: [
    { type: 'text', text },
    { type: 'text', text: ' x', marks: [{ type: 'italic' }] },
    { type: 'text', text: '2', marks: [{ type: 'superscript' }] },
    { type: 'citation', attrs: { referenceId: REF, locator: null } },
  ] }],
});

async function setup(owner = 'alice') {
  const p = (await app.inject({ method: 'POST', url: '/api/papers', headers: H[owner], payload: { working_title: 'p', article_type: 'research_article' } })).json();
  const d = (await app.inject({ method: 'POST', url: `/api/papers/${p.id}/documents`, headers: H[owner], payload: { kind: 'manuscript' } })).json();
  const url = `/api/papers/${p.id}/documents/${d.document.id}/saves`;
  const save = (body: Record<string, unknown>, who = owner) => app.inject({ method: 'POST', url, headers: H[who], payload: { schema_version: 1, reason: 'autosave', ...body } });
  return { p, d, url, save };
}

describe('editor saves', () => {
  test('a new save is stored (201) with its reason; the identical request sent again is answered as already stored (200)', async () => {
    const { d, save } = await setup();
    const body = { expected_head_revision_id: d.head.id, content_json: doc('한글 본문') };
    const first = await save(body);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ reason: 'autosave', parent_revision_id: d.head.id, replayed: false });
    const again = await save(body);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ id: first.json().id, replayed: true });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM document_revisions WHERE document_id = $1', [d.document.id]);
    expect(rows[0].n).toBe(2); // initial + one save, not two
  });

  test('a different text from the same old head is a conflict, not a replay', async () => {
    const { d, save } = await setup();
    expect((await save({ expected_head_revision_id: d.head.id, content_json: doc('A') })).statusCode).toBe(201);
    const other = await save({ expected_head_revision_id: d.head.id, content_json: doc('B') });
    expect(other.statusCode).toBe(409);
  });

  test('the same text saved after something else moved on is a conflict', async () => {
    const { d, save } = await setup();
    const a = (await save({ expected_head_revision_id: d.head.id, content_json: doc('A') })).json();
    expect((await save({ expected_head_revision_id: a.id, content_json: doc('B') })).statusCode).toBe(201);
    expect((await save({ expected_head_revision_id: d.head.id, content_json: doc('A') })).statusCode).toBe(409);
  });

  test('the same text on a head that does not follow the expected head is a conflict (A → B → A again)', async () => {
    const { d, save } = await setup();
    const a = (await save({ expected_head_revision_id: d.head.id, content_json: doc('A') })).json();
    const b = (await save({ expected_head_revision_id: a.id, content_json: doc('B') })).json();
    expect((await save({ expected_head_revision_id: b.id, content_json: doc('A') })).statusCode).toBe(201);
    expect((await save({ expected_head_revision_id: d.head.id, content_json: doc('A') })).statusCode).toBe(409);
  });

  test('a matching head created by a restore is not treated as the editor\'s save', async () => {
    const { p, d, save } = await setup();
    const a = (await save({ expected_head_revision_id: d.head.id, content_json: doc('A') })).json();
    const b = (await save({ expected_head_revision_id: a.id, content_json: doc('B') })).json();
    const restored = await app.inject({ method: 'POST', url: `/api/papers/${p.id}/documents/${d.document.id}/restore`, headers: H.alice, payload: { revision_id: a.id, expected_head_revision_id: b.id } });
    expect(restored.statusCode).toBe(201);
    expect((await save({ expected_head_revision_id: b.id, content_json: doc('A') })).statusCode).toBe(409);
  });

  test('a manual save is recorded as manual; other reasons are refused', async () => {
    const { d, save } = await setup();
    const m = await save({ expected_head_revision_id: d.head.id, content_json: doc('A'), reason: 'manual' });
    expect(m.statusCode).toBe(201);
    expect(m.json().reason).toBe('manual');
    for (const reason of ['restore', 'ai_apply', 'import', undefined]) {
      const r = await save({ expected_head_revision_id: m.json().id, content_json: doc('B'), reason });
      expect(r.statusCode, String(reason)).toBe(422);
    }
  });

  test('invalid content is refused with the editor-core reasons, also on a resend', async () => {
    const { d, save } = await setup();
    const bad = { expected_head_revision_id: d.head.id, content_json: { type: 'doc', content: [{ type: 'html_block' }] } };
    for (let i = 0; i < 2; i++) {
      const r = await save(bad);
      expect(r.statusCode).toBe(422);
      expect(r.json().errors.map((e: { code: string }) => e.code)).toContain('RAW_HTML');
    }
  });

  test('another owner can neither save nor learn about the paper', async () => {
    const { d, save } = await setup();
    const r = await save({ expected_head_revision_id: d.head.id, content_json: doc('A') }, 'bob');
    expect(r.statusCode).toBe(404);
  });

  test('a save without the CSRF token is refused', async () => {
    const { d, url } = await setup();
    const noCsrf = { ...H.alice! };
    delete noCsrf['x-pw-csrf'];
    const r = await app.inject({ method: 'POST', url, headers: noCsrf, payload: { expected_head_revision_id: d.head.id, content_json: doc('A'), schema_version: 1, reason: 'autosave' } });
    expect(r.statusCode).toBe(403);
  });
});
