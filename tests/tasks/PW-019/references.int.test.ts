// PW-019 — references, figures and style through the API (TST-019A / TST-019B, server part).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { createProposal } from '../../../packages/domain/src/proposals/index.ts';
import { parseDocument, snapshotSelection } from '../../../packages/editor-core/src/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
const P = '00000000-0000-4000-8000-0000000000a1';
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
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: u, password: 'correct horse battery' } });
    H[u] = { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken, origin: ORIGIN };
  }
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});
const call = (method: 'GET' | 'POST', url: string, payload?: unknown, who = 'alice') => app.inject({ method, url, headers: H[who], payload: payload as object | undefined });
const paper = async (who = 'alice') => (await call('POST', '/api/papers', { working_title: 'p', article_type: 'research_article' }, who)).json().id as string;
const kim = { title: 'Drought induces ABC1', authors: [{ family: 'Kim', given: 'Ji' }], year: 2020, container: 'Plant J', doi: '10.1234/abc' };
const lee = { title: 'Root growth', authors: [{ family: 'Lee', given: 'Su' }, { family: 'Park' }], year: 2019 };

async function manuscript(paperId: string, content: unknown) {
  const d = (await call('POST', `/api/papers/${paperId}/documents`, { kind: 'manuscript' })).json();
  const r = await call('POST', `/api/papers/${paperId}/documents/${d.document.id}/saves`, { expected_head_revision_id: d.head.id, content_json: content, schema_version: 1, reason: 'manual' });
  expect(r.statusCode, r.body).toBe(201);
  return { documentId: d.document.id as string, head: r.json().id as string };
}
const cite = (id: string) => ({ type: 'citation', attrs: { referenceId: id, locator: null } });
const xref = (id: string) => ({ type: 'figure_ref', attrs: { targetId: id } });

describe('references', () => {
  test('a reference is created from structured fields and listed with its metadata', async () => {
    const p = await paper();
    const r = await call('POST', `/api/papers/${p}/references`, kim);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ title: 'Drought induces ABC1', year: 2020, doi: '10.1234/abc' });
    expect((await call('GET', `/api/papers/${p}/references`)).json()).toHaveLength(1);
    const rev = (await pool.query('SELECT source, csl_json FROM bibliographic_revisions WHERE reference_id = $1', [r.json().id])).rows[0];
    expect(rev).toMatchObject({ source: 'manual', csl_json: { title: 'Drought induces ABC1', DOI: '10.1234/abc' } });
  });

  test('TST-019B: free bibliography text, unknown fields and malformed DOIs are refused', async () => {
    const p = await paper();
    expect((await call('POST', `/api/papers/${p}/references`, { bibliography: 'Kim J (2020) Drought induces ABC1. Plant J.' })).statusCode).toBe(422);
    expect((await call('POST', `/api/papers/${p}/references`, { ...kim, citation_text: 'Kim 2020' })).statusCode).toBe(422);
    expect((await call('POST', `/api/papers/${p}/references`, { ...kim, doi: 'https://doi.org/10.1234/abc' })).statusCode).toBe(422);
    expect((await call('POST', `/api/papers/${p}/references`, { ...kim, authors: 'Kim J' })).statusCode).toBe(422);
    expect((await call('GET', `/api/papers/${p}/references`)).json()).toHaveLength(0);
  });

  test('another owner cannot read or add references to the paper', async () => {
    const p = await paper();
    expect((await call('GET', `/api/papers/${p}/references`, undefined, 'bob')).statusCode).toBe(404);
    expect((await call('POST', `/api/papers/${p}/references`, kim, 'bob')).statusCode).toBe(404);
  });
});

describe('TST-019A: labels follow the document, the style and the figure order', () => {
  test('changing the style and the figure order renumbers the stored document consistently', async () => {
    const p = await paper();
    const k = (await call('POST', `/api/papers/${p}/references`, kim)).json();
    const l = (await call('POST', `/api/papers/${p}/references`, lee)).json();
    const f1 = (await call('POST', `/api/papers/${p}/figures`, { kind: 'figure', title: 'Induction' })).json();
    const f2 = (await call('POST', `/api/papers/${p}/figures`, { kind: 'figure', title: 'Survival' })).json();
    const t1 = (await call('POST', `/api/papers/${p}/figures`, { kind: 'table', title: 'Primers' })).json();
    expect([f1.position, f2.position, t1.position]).toEqual([1, 2, 1]);
    const content = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P }, content: [{ type: 'text', text: 'As shown ' }, cite(l.id), { type: 'text', text: ' and ' }, cite(k.id), { type: 'text', text: ' (' }, xref(f2.id), { type: 'text', text: ', ' }, xref(t1.id), { type: 'text', text: ').' }] }] };
    const { documentId } = await manuscript(p, content);
    const render = async () => (await call('GET', `/api/papers/${p}/documents/${documentId}/references-render`)).json();
    let r = await render();
    expect(r).toMatchObject({ style: 'numeric', citations: ['[1]', '[2]'], figures: ['Figure 2', 'Table 1'], unresolved_citations: [], unresolved_figures: [] });
    expect(r.bibliography.map((b: { text: string }) => b.text)).toEqual(['Lee, S., & Park (2019). Root growth.', 'Kim, J. (2020). Drought induces ABC1. Plant J. https://doi.org/10.1234/abc']);
    expect((await call('POST', `/api/papers/${p}/citation-style`, { style: 'author_year' })).json()).toEqual({ style: 'author_year' });
    r = await render();
    expect(r.citations).toEqual(['(Lee & Park 2019)', '(Kim 2020)']);
    expect(r.bibliography.map((b: { id: string }) => b.id)).toEqual([k.id, l.id]);
    const reordered = await call('POST', `/api/papers/${p}/figures/order`, { kind: 'figure', ids: [f2.id, f1.id] });
    expect(reordered.statusCode, reordered.body).toBe(200);
    expect((await render()).figures).toEqual(['Figure 1', 'Table 1']);
    expect((await call('POST', `/api/papers/${p}/figures/order`, { kind: 'figure', ids: [f2.id] })).statusCode).toBe(409);
    expect((await call('POST', `/api/papers/${p}/citation-style`, { style: 'vancouver-ish' })).statusCode).toBe(422);
  });

  test('TST-019B: a citation to a reference this paper does not have is never numbered or put in the bibliography', async () => {
    const p = await paper();
    const k = (await call('POST', `/api/papers/${p}/references`, kim)).json();
    const other = await paper();
    const foreign = (await call('POST', `/api/papers/${other}/references`, lee)).json(); // another paper's reference
    const ghost = randomUUID();
    const content = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P }, content: [cite(ghost), { type: 'text', text: ' x ' }, cite(k.id), cite(foreign.id), xref(randomUUID())] }] };
    const { documentId } = await manuscript(p, content);
    const r = (await call('GET', `/api/papers/${p}/documents/${documentId}/references-render`)).json();
    expect(r.citations).toEqual(['[?]', '[1]', '[?]']);
    expect(r.unresolved_citations).toEqual([ghost, foreign.id]);
    expect(r.bibliography.map((b: { id: string }) => b.id)).toEqual([k.id]);
    expect(r.figures).toEqual(['[그림/표 없음]']);
  });

  test('TST-019B: an AI proposal cannot add or swap a citation (it is CHECK_FAILED)', async () => {
    const p = await paper();
    const k = (await call('POST', `/api/papers/${p}/references`, kim)).json();
    const content = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P }, content: [{ type: 'text', text: 'ABC1 is induced by drought.' }] }] };
    const { documentId, head } = await manuscript(p, content);
    const selection = await snapshotSelection(parseDocument(content, 1), { blockId: P, from: 0, to: 26 });
    const h = (await call('POST', `/api/papers/${p}/documents/${documentId}/selection-handles`, { base_revision_id: head, selection })).json();
    const prop = await createProposal(pool, { paperId: p, handleId: h.id, intent: 'grammar', replacement: [{ type: 'text', text: 'ABC1 is induced by drought ' }, { type: 'citation', reference_id: k.id }], origin: 'worker:test' });
    expect(prop.status).toBe('CHECK_FAILED');
    expect(prop.checks.find((c) => c.check === 'citations')).toMatchObject({ result: 'fail' });
  });

  test('figures are archived, not deleted; their identity cannot change', async () => {
    const p = await paper();
    const f = (await call('POST', `/api/papers/${p}/figures`, { kind: 'figure', title: 'A' })).json();
    await expect(pool.query('DELETE FROM figure_objects WHERE id = $1', [f.id])).rejects.toThrow(/immutable/);
    await expect(pool.query("UPDATE figure_objects SET kind = 'table' WHERE id = $1", [f.id])).rejects.toThrow(/immutable/);
    expect((await call('POST', `/api/papers/${p}/figures`, { kind: 'chart', title: 'A' })).statusCode).toBe(422);
  });
});
