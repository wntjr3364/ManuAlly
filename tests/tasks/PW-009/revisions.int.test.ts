// PW-009 — TST-009A / TST-009B (real PostgreSQL)
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
interface S { cookie: string; csrf: string }
let A: S;
let B: S;
const as = (s: S) => ({ cookie: s.cookie, 'x-pw-csrf': s.csrf, origin: ORIGIN });

async function login(username: string, password: string): Promise<S> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username, password } });
  return { cookie: String(res.headers['set-cookie']).split(';')[0]!, csrf: res.json().csrfToken };
}
// block ids are canonical UUIDs (saves are validated with editor-core since PW-014)
const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: '00000000-0000-4000-8000-0000000000b1' }, content: [{ type: 'text', text }] }] });

beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 6 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  await createOwner(pool, { username: 'alice', password: 'correct horse battery' });
  await createOwner(pool, { username: 'bob', password: 'another long passphrase' });
  A = await login('alice', 'correct horse battery');
  B = await login('bob', 'another long passphrase');
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});

async function newPaper(s: S, title = 'p') {
  return (await app.inject({ method: 'POST', url: '/api/papers', headers: as(s), payload: { working_title: title, article_type: 'research_article' } })).json();
}
async function newDocument(s: S, paperId: string) {
  const res = await app.inject({ method: 'POST', url: `/api/papers/${paperId}/documents`, headers: as(s), payload: { kind: 'manuscript' } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}
async function save(s: S, paperId: string, documentId: string, expectedHead: string, text: string) {
  return app.inject({
    method: 'POST',
    url: `/api/papers/${paperId}/documents/${documentId}/revisions`,
    headers: as(s),
    payload: { expected_head_revision_id: expectedHead, content_json: doc(text), schema_version: 1, reason: 'manual' },
  });
}

describe('TST-009A: restore makes a new revision; snapshots reproduce what they referenced', () => {
  test('restore copies an old revision forward without touching history', async () => {
    const paper = await newPaper(A);
    const d = await newDocument(A, paper.id);
    const r1 = (await save(A, paper.id, d.document.id, d.head.id, 'first')).json();
    const r2 = (await save(A, paper.id, d.document.id, r1.id, 'second')).json();
    const res = await app.inject({ method: 'POST', url: `/api/papers/${paper.id}/documents/${d.document.id}/restore`, headers: as(A), payload: { revision_id: r1.id, expected_head_revision_id: r2.id } });
    expect(res.statusCode, res.body).toBe(201);
    const r3 = res.json();
    expect(r3.id).not.toBe(r1.id);
    expect(r3.parent_revision_id).toBe(r2.id);
    expect(r3.restored_from_revision_id).toBe(r1.id);
    expect(r3.reason).toBe('restore');
    expect(r3.content_json).toEqual(doc('first'));
    expect(r3.content_hash).toBe(r1.content_hash);
    const head = (await app.inject({ method: 'GET', url: `/api/papers/${paper.id}/documents/${d.document.id}`, headers: as(A) })).json();
    expect(head.head.id).toBe(r3.id);
    const hist = (await app.inject({ method: 'GET', url: `/api/papers/${paper.id}/documents/${d.document.id}/revisions`, headers: as(A) })).json();
    expect(hist.map((r: { id: string }) => r.id)).toEqual([r3.id, r2.id, r1.id, d.head.id]);
    const old = (await app.inject({ method: 'GET', url: `/api/papers/${paper.id}/documents/${d.document.id}/revisions/${r2.id}`, headers: as(A) })).json();
    expect(old.content_json).toEqual(doc('second'));
  });

  test('a named snapshot keeps returning the exact revisions it captured', async () => {
    const paper = await newPaper(A);
    const d1 = await newDocument(A, paper.id);
    const d2 = await newDocument(A, paper.id);
    const a1 = (await save(A, paper.id, d1.document.id, d1.head.id, 'manuscript v1')).json();
    const b1 = (await save(A, paper.id, d2.document.id, d2.head.id, 'notes v1')).json();
    const snap = await app.inject({ method: 'POST', url: `/api/papers/${paper.id}/snapshots`, headers: as(A), payload: { label: 'Submitted to J. Fixture' } });
    expect(snap.statusCode, snap.body).toBe(201);
    await save(A, paper.id, d1.document.id, a1.id, 'manuscript v2');
    await save(A, paper.id, d2.document.id, b1.id, 'notes v2');
    const got = (await app.inject({ method: 'GET', url: `/api/papers/${paper.id}/snapshots/${snap.json().id}`, headers: as(A) })).json();
    expect(got.label).toBe('Submitted to J. Fixture');
    const byDoc = Object.fromEntries(got.documents.map((x: { document_id: string; revision: { content_json: unknown; id: string } }) => [x.document_id, x.revision]));
    expect(byDoc[d1.document.id].id).toBe(a1.id);
    expect(byDoc[d1.document.id].content_json).toEqual(doc('manuscript v1'));
    expect(byDoc[d2.document.id].content_json).toEqual(doc('notes v1'));
    const list = (await app.inject({ method: 'GET', url: `/api/papers/${paper.id}/snapshots`, headers: as(A) })).json();
    expect(list.map((s: { id: string }) => s.id)).toContain(snap.json().id);
  });

  test('a stale save is a 409 and two concurrent saves on the same head cannot both win', async () => {
    const paper = await newPaper(A);
    const d = await newDocument(A, paper.id);
    const r1 = (await save(A, paper.id, d.document.id, d.head.id, 'one')).json();
    const stale = await save(A, paper.id, d.document.id, d.head.id, 'based on the old head');
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('conflict');
    const results = await Promise.all([save(A, paper.id, d.document.id, r1.id, 'tab A'), save(A, paper.id, d.document.id, r1.id, 'tab B')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  test('content must be a JSON document of bounded size with a schema version', async () => {
    const paper = await newPaper(A);
    const d = await newDocument(A, paper.id);
    for (const payload of [
      { expected_head_revision_id: d.head.id, content_json: '<p>raw html</p>', schema_version: 1, reason: 'manual' },
      { expected_head_revision_id: d.head.id, content_json: doc('x'), reason: 'manual' },
      { expected_head_revision_id: d.head.id, content_json: doc('x'), schema_version: 1, reason: 'ai_apply_without_proposal' },
    ]) {
      const res = await app.inject({ method: 'POST', url: `/api/papers/${paper.id}/documents/${d.document.id}/revisions`, headers: as(A), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
    }
  });
});

describe('TST-009B: immutability and cross-paper references are enforced by the database and the API', () => {
  test('revisions and snapshots cannot be updated, deleted or truncated, even with direct SQL', async () => {
    const paper = await newPaper(A);
    const d = await newDocument(A, paper.id);
    const r1 = (await save(A, paper.id, d.document.id, d.head.id, 'approved text')).json();
    const snap = (await app.inject({ method: 'POST', url: `/api/papers/${paper.id}/snapshots`, headers: as(A), payload: { label: 's' } })).json();
    for (const sql of [
      [`UPDATE document_revisions SET content_json = '{"type":"doc","content":[]}' WHERE id = $1`, [r1.id]],
      ['DELETE FROM document_revisions WHERE id = $1', [r1.id]],
      ['UPDATE paper_snapshots SET label = $2 WHERE id = $1', [snap.id, 'rewritten']],
      ['DELETE FROM snapshot_document_revisions WHERE snapshot_id = $1', [snap.id]],
      ['TRUNCATE document_revisions CASCADE', []],
    ] as const) {
      await expect(pool.query(sql[0], [...sql[1]]), sql[0]).rejects.toThrow(/immutable/);
    }
    const again = (await app.inject({ method: 'GET', url: `/api/papers/${paper.id}/documents/${d.document.id}/revisions/${r1.id}`, headers: as(A) })).json();
    expect(again.content_json).toEqual(doc('approved text'));
  });

  test("the database rejects links between one paper's entities and another paper's", async () => {
    const p1 = await newPaper(A, 'one');
    const p2 = await newPaper(A, 'two');
    const d1 = await newDocument(A, p1.id);
    const d2 = await newDocument(A, p2.id);
    const s1 = (await app.inject({ method: 'POST', url: `/api/papers/${p1.id}/snapshots`, headers: as(A), payload: { label: 's1' } })).json();
    // snapshot of paper 1 pointing at a revision of paper 2
    await expect(pool.query('INSERT INTO snapshot_document_revisions (snapshot_id, paper_id, document_id, revision_id) VALUES ($1, $2, $3, $4)', [s1.id, p1.id, d2.document.id, d2.head.id])).rejects.toThrow(/foreign key/);
    // revision of paper 1 whose parent is in paper 2
    await expect(pool.query("INSERT INTO document_revisions (paper_id, document_id, parent_revision_id, content_json, schema_version, created_by, reason, content_hash) SELECT $1, $2, $3, '{}', 1, owner_id, 'manual', repeat('0', 64) FROM paper_projects WHERE id = $1", [p1.id, d1.document.id, d2.head.id])).rejects.toThrow(/foreign key/);
    // head pointer of document 1 set to a revision of document 2
    await expect(pool.query('UPDATE documents SET head_revision_id = $2 WHERE id = $1', [d1.document.id, d2.head.id])).rejects.toThrow(/foreign key/);
  });

  test('the API refuses revision ids from another paper or document, and other owners see nothing', async () => {
    const p1 = await newPaper(A, 'one');
    const p2 = await newPaper(A, 'two');
    const d1 = await newDocument(A, p1.id);
    const d2 = await newDocument(A, p2.id);
    const other = (await save(A, p2.id, d2.document.id, d2.head.id, 'paper two text')).json();
    const restore = await app.inject({ method: 'POST', url: `/api/papers/${p1.id}/documents/${d1.document.id}/restore`, headers: as(A), payload: { revision_id: other.id, expected_head_revision_id: d1.head.id } });
    expect(restore.statusCode).toBe(404);
    expect(restore.body).not.toContain('paper two text');
    const cross = await app.inject({ method: 'GET', url: `/api/papers/${p1.id}/documents/${d2.document.id}/revisions/${other.id}`, headers: as(A) });
    expect(cross.statusCode).toBe(404);
    for (const url of [`/api/papers/${p2.id}/documents/${d2.document.id}`, `/api/papers/${p2.id}/documents/${d2.document.id}/revisions/${other.id}`, `/api/papers/${p2.id}/snapshots`]) {
      const res = await app.inject({ method: 'GET', url, headers: as(B) });
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toContain('paper two text');
    }
  });
});
