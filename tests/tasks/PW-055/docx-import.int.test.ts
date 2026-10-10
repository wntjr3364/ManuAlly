// PW-055 — DOCX import through the API: the original is stored as received and can be downloaded again; the
// preview and loss report come before anything changes; tracked changes need the owner's choice; applying
// makes a new manuscript or a new version (the current text stays); nothing is deleted or called a round trip.
// TST-055A: the owner checks the conversion losses, then imports into a new document or a new revision.
// TST-055B: lost tracked changes or citation fields never delete the original or claim a full round trip.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { makeDocx, p, r, richDocx } from './fixture.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
const H: Record<string, Record<string, string>> = {};
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 6 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  for (const u of ['alice', 'bob']) {
    await createOwner(pool, { username: u, password: 'correct horse battery' });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: u, password: 'correct horse battery' } });
    H[u] = { cookie: String(res.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': res.json().csrfToken, origin: ORIGIN };
  }
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});

const call = (method: 'GET' | 'POST', url: string, payload?: unknown, who = 'alice') => app.inject({ method, url, headers: H[who], payload: payload as object | undefined });
const paper = async () => (await call('POST', '/api/papers', { working_title: 'docx paper', article_type: 'research_article' })).json().id as string;
const upload = (paperId: string, bytes: Buffer, extra: Record<string, unknown> = {}, who = 'alice') =>
  call('POST', `/api/papers/${paperId}/imports`, { format: 'docx', filename: 'paper.docx', content_base64: bytes.toString('base64'), ...extra }, who);

describe('TST-055A: preview and losses first, then a new manuscript or a new version', () => {
  test('a .docx gives a preview and a loss report; nothing changes until it is applied; applied, it is a new manuscript', async () => {
    const id = await paper();
    const res = await upload(id, richDocx(), { tracked_changes: 'accept' });
    expect(res.statusCode, res.body).toBe(201);
    const imp = res.json();
    expect(imp).toMatchObject({ format: 'docx', filename: 'paper.docx', parser_version: 'pw-docx-import-1', applied: null });
    expect(imp.report).toMatchObject({ round_trip: 'not_supported', tracked_changes: { insertions: 1, deletions: 1, choice: 'accept' } });
    expect(imp.report.losses.map((l: { kind: string }) => l.kind)).toEqual(expect.arrayContaining(['tracked_change', 'comment', 'citation_field', 'equation', 'table_layout', 'image', 'footnote', 'link']));
    expect((await pool.query("SELECT count(*)::int AS n FROM documents WHERE paper_id = $1", [id])).rows[0].n).toBe(0);
    const applied = await call('POST', `/api/papers/${id}/imports/${imp.id}/apply`, { mode: 'new_manuscript' });
    expect(applied.statusCode, applied.body).toBe(201);
    const head = (await pool.query("SELECT r.content_json FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.paper_id = $1", [id])).rows[0].content_json;
    expect(head).toEqual(imp.preview);
    expect((await call('GET', `/api/papers/${id}/imports/${imp.id}`)).json().applied).toMatchObject({ mode: 'new_manuscript' });
  });

  test('into an existing manuscript: only as a new version, confirmed, from the head the owner saw; the old text stays', async () => {
    const id = await paper();
    const d = (await call('POST', `/api/papers/${id}/documents`, { kind: 'manuscript' })).json();
    const imp = (await upload(id, makeDocx(p(r('Imported text.'))))).json();
    expect((await call('POST', `/api/papers/${id}/imports/${imp.id}/apply`, { mode: 'replace_manuscript', document_id: d.document.id, expected_head_revision_id: d.head.id })).statusCode).toBe(422);
    const ok = await call('POST', `/api/papers/${id}/imports/${imp.id}/apply`, { mode: 'replace_manuscript', document_id: d.document.id, expected_head_revision_id: d.head.id, confirm_replace: true });
    expect(ok.statusCode, ok.body).toBe(201);
    const revs = (await pool.query('SELECT id, reason FROM document_revisions WHERE document_id = $1 ORDER BY created_at', [d.document.id])).rows;
    expect(revs.map((x) => x.reason)).toEqual(['initial', 'import']);
    expect(revs[0].id).toBe(d.head.id);
    // applied once only
    expect((await call('POST', `/api/papers/${id}/imports/${imp.id}/apply`, { mode: 'replace_manuscript', document_id: d.document.id, expected_head_revision_id: ok.json().revision.id, confirm_replace: true })).statusCode).toBe(409);
  });
});

describe('TST-055B: the original is kept; tracked changes need a choice; no round trip is claimed', () => {
  test('unresolved tracked changes: refused with the counts until the owner chooses; nothing is stored before', async () => {
    const id = await paper();
    const res = await upload(id, richDocx());
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ field: 'tracked_changes', reason: 'TRACKED_CHANGES_CHOICE', insertions: 1, deletions: 1 });
    expect((await pool.query('SELECT count(*)::int AS n FROM import_sources WHERE paper_id = $1', [id])).rows[0].n).toBe(0);
    const rej = (await upload(id, richDocx(), { tracked_changes: 'reject' })).json();
    expect(JSON.stringify(rej.preview)).toContain('barely');
    expect(rej.report.tracked_changes.choice).toBe('reject');
    expect((await upload(id, richDocx(), { tracked_changes: 'maybe' })).statusCode).toBe(422);
  });

  test('the original file is stored as received, downloads byte for byte, and is never deleted or changed — also after applying', async () => {
    const id = await paper();
    const bytes = richDocx();
    const imp = (await upload(id, bytes, { tracked_changes: 'accept' })).json();
    expect(imp.source_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    await call('POST', `/api/papers/${id}/imports/${imp.id}/apply`, { mode: 'new_manuscript' });
    const dl = await call('GET', `/api/papers/${id}/imports/${imp.id}/original`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(String(dl.headers['content-disposition'])).toContain('attachment');
    expect(Buffer.compare(dl.rawPayload, bytes)).toBe(0);
    await expect(pool.query('DELETE FROM import_sources WHERE id = $1', [imp.id])).rejects.toThrow(/immutable/);
    await expect(pool.query("UPDATE import_sources SET source_bytes = '\\x00' WHERE id = $1", [imp.id])).rejects.toThrow(/immutable/);
    // another owner reaches neither the import nor its file
    expect((await call('GET', `/api/papers/${id}/imports/${imp.id}/original`, undefined, 'bob')).statusCode).toBe(404);
  });

  test('not a .docx, an old .doc, a hostile ZIP or an over-large file is refused and nothing is stored', async () => {
    const id = await paper();
    const cases: [Buffer, string][] = [
      [Buffer.from('plain text'), 'NOT_DOCX'],
      [Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]), 'LEGACY_DOC'],
      [makeDocx(p(r('x')), { extra: { 'word/media/big.bin': Buffer.alloc(60 * 1024 * 1024) } }), 'TOO_LARGE'],
      [Buffer.alloc(10 * 1024 * 1024 + 1), 'TOO_LARGE'],
    ];
    for (const [b, reason] of cases) {
      const res = await upload(id, b);
      expect(res.statusCode, reason).toBe(422);
      expect(res.json().reason).toBe(reason);
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM import_sources WHERE paper_id = $1', [id])).rows[0].n).toBe(0);
  });

  test('text imports still work as before and their original downloads too', async () => {
    const id = await paper();
    const t = await call('POST', `/api/papers/${id}/imports`, { format: 'markdown', filename: 'a.md', text: '# A\n\nB' });
    expect(t.statusCode, t.body).toBe(201);
    const dl = await call('GET', `/api/papers/${id}/imports/${t.json().id}/original`);
    expect(dl.body).toBe('# A\n\nB');
  });
});
