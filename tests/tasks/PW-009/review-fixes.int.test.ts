// PW-009 — regression tests for the independent review (M1–M3, minor 4) and PW-008 re-review minors 1–2
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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
let H: Record<string, string>;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 4 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  alice = (await createOwner(pool, { username: 'alice', password: 'correct horse battery' })).id;
  bob = (await createOwner(pool, { username: 'bob', password: 'another long passphrase' })).id;
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: 'alice', password: 'correct horse battery' } });
  H = { cookie: String(res.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': res.json().csrfToken, origin: ORIGIN };
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});

const call = (method: 'GET' | 'POST', url: string, payload?: unknown, headers = H) => app.inject({ method, url, headers, payload: payload as object | undefined });
const paper = async () => (await call('POST', '/api/papers', { working_title: 'p', article_type: 'research_article' })).json();
async function reference(owner: string) {
  const { rows } = await pool.query('INSERT INTO reference_works (owner_id, doi) VALUES ($1, $2) RETURNING id', [owner, '10.1234/fixture']);
  await pool.query("INSERT INTO bibliographic_revisions (reference_id, csl_json, content_hash, source) VALUES ($1, '{\"title\":\"t\"}', repeat('a', 64), 'manual')", [rows[0].id]);
  return rows[0].id as string;
}

describe('review M1: a snapshot is sealed once its transaction commits', () => {
  test('rows cannot be added to an existing snapshot manifest', async () => {
    const p = await paper();
    const snap = (await call('POST', `/api/papers/${p.id}/snapshots`, { label: 'sealed' })).json();
    const d = (await call('POST', `/api/papers/${p.id}/documents`, { kind: 'notes' })).json();
    await expect(pool.query('INSERT INTO snapshot_document_revisions (snapshot_id, paper_id, document_id, revision_id) VALUES ($1, $2, $3, $4)', [snap.id, p.id, d.document.id, d.head.id])).rejects.toThrow(/immutable/);
    await pool.query("INSERT INTO asset_revisions (paper_id, asset_key, sha256, byte_size, media_type, created_by) VALUES ($1, 'figure-1', repeat('b', 64), 1, 'image/png', $2)", [p.id, alice]);
    const asset = (await pool.query('SELECT id FROM asset_revisions WHERE paper_id = $1', [p.id])).rows[0].id;
    await expect(pool.query('INSERT INTO snapshot_asset_revisions (snapshot_id, paper_id, asset_revision_id) VALUES ($1, $2, $3)', [snap.id, p.id, asset])).rejects.toThrow(/immutable/);
    const got = (await call('GET', `/api/papers/${p.id}/snapshots/${snap.id}`)).json();
    expect(got.documents).toEqual([]);
    expect(got.assets).toEqual([]);
  });

  test('a snapshot still pins references and assets taken in its own transaction', async () => {
    const p = await paper();
    const ref = await reference(alice);
    await pool.query('INSERT INTO project_references (paper_id, reference_id, owner_id) VALUES ($1, $2, $3)', [p.id, ref, alice]);
    await pool.query("INSERT INTO asset_revisions (paper_id, asset_key, sha256, byte_size, media_type, created_by) VALUES ($1, 'figure-1', repeat('c', 64), 1, 'image/png', $2)", [p.id, alice]);
    const snap = (await call('POST', `/api/papers/${p.id}/snapshots`, { label: 'with refs' })).json();
    const got = (await call('GET', `/api/papers/${p.id}/snapshots/${snap.id}`)).json();
    expect(got.references.map((r: { reference_id: string }) => r.reference_id)).toEqual([ref]);
    expect(got.assets).toHaveLength(1);
  });
});

describe("review M2/M3: references belong to the paper's owner and are removed softly", () => {
  test("a paper cannot link another owner's reference", async () => {
    const p = await paper();
    const bobs = await reference(bob);
    await expect(pool.query('INSERT INTO project_references (paper_id, reference_id, owner_id) VALUES ($1, $2, $3)', [p.id, bobs, alice])).rejects.toThrow(/foreign key/);
    await expect(pool.query('INSERT INTO project_references (paper_id, reference_id, owner_id) VALUES ($1, $2, $3)', [p.id, bobs, bob])).rejects.toThrow(/foreign key/);
  });

  test('a snapshotted reference can be removed from the paper; the snapshot keeps it, the next one does not', async () => {
    const p = await paper();
    const ref = await reference(alice);
    await pool.query('INSERT INTO project_references (paper_id, reference_id, owner_id) VALUES ($1, $2, $3)', [p.id, ref, alice]);
    const s1 = (await call('POST', `/api/papers/${p.id}/snapshots`, { label: 'before removal' })).json();
    await expect(pool.query('DELETE FROM project_references WHERE paper_id = $1', [p.id])).rejects.toThrow(/immutable/);
    await pool.query('UPDATE project_references SET removed_at = now() WHERE paper_id = $1', [p.id]);
    await expect(pool.query('UPDATE project_references SET reference_id = $2 WHERE paper_id = $1', [p.id, await reference(alice)])).rejects.toThrow(/immutable/);
    const s2 = (await call('POST', `/api/papers/${p.id}/snapshots`, { label: 'after removal' })).json();
    expect((await call('GET', `/api/papers/${p.id}/snapshots/${s1.id}`)).json().references).toHaveLength(1);
    expect((await call('GET', `/api/papers/${p.id}/snapshots/${s2.id}`)).json().references).toHaveLength(0);
  });
});

describe('review minor 4 and PW-008 minors: bad input is a 4xx, never a 500', () => {
  test('unstorable or pathological content is a 422', async () => {
    const p = await paper();
    const d = (await call('POST', `/api/papers/${p.id}/documents`, { kind: 'manuscript' })).json();
    const DEPTH = 20_000; // built as text: JSON.stringify itself overflows at this depth
    const deepJson = '{"type":"paragraph","content":['.repeat(DEPTH) + '{"type":"text","text":"x"}' + ']}'.repeat(DEPTH);
    const docWith = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
    for (const [payload, label] of [
      [{ content_json: docWith('a\u0000b'), schema_version: 1 }, 'NUL'],
      [{ content_json: docWith('a\uD800b'), schema_version: 1 }, 'lone surrogate'],
      [{ content_json: docWith('ok'), schema_version: 3e9 }, 'schema_version above int4'],
    ] as const) {
      const body = JSON.stringify({ expected_head_revision_id: d.head.id, reason: 'manual', ...payload });
      const res = await app.inject({ method: 'POST', url: `/api/papers/${p.id}/documents/${d.document.id}/revisions`, headers: { ...H, 'content-type': 'application/json' }, payload: body });
      expect(res.statusCode, label).toBeLessThan(500);
      expect(res.statusCode, label).toBeGreaterThanOrEqual(400);
    }
    const deepBody = `{"expected_head_revision_id":"${d.head.id}","reason":"manual","schema_version":1,"content_json":{"type":"doc","content":[${deepJson}]}}`;
    const deepRes = await app.inject({ method: 'POST', url: `/api/papers/${p.id}/documents/${d.document.id}/revisions`, headers: { ...H, 'content-type': 'application/json' }, payload: deepBody });
    expect(deepRes.statusCode, 'deep nesting').toBeGreaterThanOrEqual(400);
    expect(deepRes.statusCode, 'deep nesting').toBeLessThan(500);
    expect((await call('POST', `/api/papers/${p.id}/snapshots`, { label: 'a\u0000b' })).statusCode).toBe(422);
  });

  test('a non-ASCII CSRF header is a 403, and named 4xx kinds survive the error handler', async () => {
    const res = await call('POST', '/api/papers', { working_title: 'x', article_type: 'research_article' }, { ...H, 'x-pw-csrf': 'é'.repeat(43) });
    expect(res.statusCode).toBe(403);
    const big = await app.inject({ method: 'POST', url: '/api/papers', headers: { ...H, 'content-type': 'application/json' }, payload: JSON.stringify({ working_title: 'x'.repeat(1_100_000) }) });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toBe('payload_too_large');
  });
});
