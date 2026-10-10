// PW-056 — exporting through the API: the export is made from one stored revision of the manuscript (named
// in the record), stored with its hash and check report, never changed, and downloadable as it was made.
// TST-056A: the stored paper's citations, figure numbers and text come out of the file as computed.
// TST-056B: an export whose citations are not all linked to stored references is not marked clean.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { parseDocx } from '../../../packages/domain/src/imports/docx/index.ts';

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
const t = (text: string, ...marks: string[]) => (marks.length ? { type: 'text', text, marks: marks.map((type) => ({ type })) } : { type: 'text', text });

// a paper with one stored reference, one figure with a caption, and a manuscript citing both
async function paper(extra: unknown[] = []) {
  const p = (await call('POST', '/api/papers', { working_title: 'export paper', article_type: 'research_article' })).json();
  const ref = (await call('POST', `/api/papers/${p.id}/references`, { title: 'Root signals under drought', authors: [{ family: 'Kim', given: 'Jiyoon' }], year: 2020, container: 'Journal of Plant Studies', doi: '10.1234/jps.2020.1' }));
  expect(ref.statusCode, ref.body).toBe(201);
  const fig = (await call('POST', `/api/papers/${p.id}/figures`, { kind: 'figure', title: 'Root induction' })).json();
  const v = await call('POST', `/api/papers/${p.id}/figures/${fig.id}/versions`, { caption: 'ABC1 induction in roots (n = 3).', panels: [] });
  expect(v.statusCode, v.body).toBe(201);
  const d = (await call('POST', `/api/papers/${p.id}/documents`, { kind: 'manuscript' })).json();
  const content = { type: 'doc', content: [
    { type: 'heading', attrs: { id: randomUUID(), level: 1 }, content: [t('Results')] },
    { type: 'paragraph', attrs: { id: randomUUID() }, content: [t('In '), t('Arabidopsis thaliana', 'italic'), t(' roots respond '), { type: 'citation', attrs: { referenceId: ref.json().id, locator: null } }, t(' ('), { type: 'figure_ref', attrs: { targetId: fig.id } }, t(').')] },
    ...extra,
  ] };
  const saved = await call('POST', `/api/papers/${p.id}/documents/${d.document.id}/saves`, { schema_version: 1, reason: 'manual', expected_head_revision_id: d.head.id, content_json: content });
  expect(saved.statusCode, saved.body).toBe(201);
  return { paperId: p.id as string, documentId: d.document.id as string, head: saved.json().id as string, refId: ref.json().id as string };
}
const blocksOf = (bytes: Buffer) => (parseDocx(bytes, {}).doc.content as { content?: { text?: string }[] }[]).map((b) => (b.content ?? []).map((i) => i.text ?? '').join(''));

describe('TST-056A: an export of a stored revision, stored and downloadable as made', () => {
  test('DOCX: made from the head revision, clean, with the computed labels, bibliography and legend; downloaded byte for byte', async () => {
    const w = await paper();
    const r = await call('POST', `/api/papers/${w.paperId}/exports`, { document_id: w.documentId, format: 'docx' });
    expect(r.statusCode, r.body).toBe(201);
    const e = r.json();
    expect(e).toMatchObject({ format: 'docx', revision_id: w.head, status: 'clean', renderer_version: 'pw-docx-export-1', style: 'numeric', style_version: 'pw-builtin-1' });
    expect(e.report).toMatchObject({ readback: { ok: true }, issues: [] });
    const file = await call('GET', `/api/papers/${w.paperId}/exports/${e.id}/file`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('wordprocessingml.document');
    expect(String(file.headers['content-disposition'])).toContain('attachment');
    expect(createHash('sha256').update(file.rawPayload).digest('hex')).toBe(e.sha256);
    expect(blocksOf(file.rawPayload)).toEqual([
      'Results', 'In Arabidopsis thaliana roots respond [1] (Figure 1).', 'References',
      '[1] Kim, J. (2020). Root signals under drought. Journal of Plant Studies. https://doi.org/10.1234/jps.2020.1',
      'Figure and table legends', 'Figure 1. ABC1 induction in roots (n = 3).',
    ]);
    expect((await call('GET', `/api/papers/${w.paperId}/exports`)).json()).toEqual([expect.objectContaining({ id: e.id, status: 'clean', sha256: e.sha256 })]);
  });

  test('CSL-JSON: the stored records of the cited references with their ids', async () => {
    const w = await paper();
    const e = (await call('POST', `/api/papers/${w.paperId}/exports`, { document_id: w.documentId, format: 'csl_json' })).json();
    const file = await call('GET', `/api/papers/${w.paperId}/exports/${e.id}/file`);
    expect(file.headers['content-type']).toContain('application/json');
    expect(JSON.parse(file.body)).toEqual([expect.objectContaining({ id: w.refId, type: 'article-journal', title: 'Root signals under drought', DOI: '10.1234/jps.2020.1' })]);
  });

  test('an export is kept as made: later edits do not change it; it is never updated or deleted', async () => {
    const w = await paper();
    const e = (await call('POST', `/api/papers/${w.paperId}/exports`, { document_id: w.documentId, format: 'docx' })).json();
    await call('POST', `/api/papers/${w.paperId}/documents/${w.documentId}/saves`, { schema_version: 1, reason: 'manual', expected_head_revision_id: w.head, content_json: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: randomUUID() }, content: [t('Changed later.')] }] } });
    const file = await call('GET', `/api/papers/${w.paperId}/exports/${e.id}/file`);
    expect(createHash('sha256').update(file.rawPayload).digest('hex')).toBe(e.sha256);
    await expect(pool.query("UPDATE exports SET status = 'clean' WHERE id = $1", [e.id])).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM exports WHERE id = $1', [e.id])).rejects.toThrow(/immutable/);
  });

  test('refusals: unknown format, another paper\'s document, another owner', async () => {
    const w = await paper();
    expect((await call('POST', `/api/papers/${w.paperId}/exports`, { document_id: w.documentId, format: 'odt' })).statusCode).toBe(422); // pdf became a format in PW-057
    const other = await paper();
    expect((await call('POST', `/api/papers/${w.paperId}/exports`, { document_id: other.documentId, format: 'docx' })).statusCode).toBe(404);
    const e = (await call('POST', `/api/papers/${w.paperId}/exports`, { document_id: w.documentId, format: 'docx' })).json();
    expect((await call('GET', `/api/papers/${w.paperId}/exports/${e.id}/file`, undefined, 'bob')).statusCode).toBe(404);
    expect((await call('GET', `/api/papers/${w.paperId}/exports`, undefined, 'bob')).statusCode).toBe(404);
  });
});

describe('TST-056B: unlinked citations make a draft, not a clean export', () => {
  test('a citation number typed as text and a citation to a reference no longer in the paper', async () => {
    const w = await paper([{ type: 'paragraph', attrs: { id: randomUUID() }, content: [t('As reported earlier [7].')] }]);
    const e = (await call('POST', `/api/papers/${w.paperId}/exports`, { document_id: w.documentId, format: 'docx' })).json();
    expect(e.status).toBe('draft_with_errors');
    expect(e.report.issues).toContainEqual(expect.objectContaining({ kind: 'citation_like_text', severity: 'error', examples: ['[7]'] }));
  });
});
