// PW-018 — comment threads through the API (TST-018A / TST-018B, server part).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { parseDocument, snapshotSelection } from '../../../packages/editor-core/src/index.ts';
import { createProposal } from '../../../packages/domain/src/proposals/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
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

const para = (id: string, t: string) => ({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text: t }] });
const docOf = (...b: unknown[]) => ({ type: 'doc', content: b });
const first = docOf(para(A, 'Roots grew. Expression rose in roots. Leaves were small.'), para(B, 'Other paragraph.'));

async function setup() {
  const p = (await app.inject({ method: 'POST', url: '/api/papers', headers: H.alice, payload: { working_title: 'p', article_type: 'research_article' } })).json();
  const d = (await app.inject({ method: 'POST', url: `/api/papers/${p.id}/documents`, headers: H.alice, payload: { kind: 'manuscript' } })).json();
  const s = { paperId: p.id as string, documentId: d.document.id as string, head: d.head.id as string };
  await save(s, first);
  return s;
}
async function save(s: { paperId: string; documentId: string; head: string }, content: unknown) {
  const r = await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/documents/${s.documentId}/saves`, headers: H.alice, payload: { expected_head_revision_id: s.head, content_json: content, schema_version: 1, reason: 'autosave' } });
  expect(r.statusCode, r.body).toBe(201);
  s.head = r.json().id;
}
async function selection(content: unknown, blockId: string, quote: string) {
  const doc = parseDocument(content, 1);
  let from = -1;
  doc.forEach((n) => { if (n.attrs.id === blockId) from = n.textContent.indexOf(quote); });
  return snapshotSelection(doc, { blockId, from, to: from + quote.length });
}
const comment = async (s: { paperId: string; documentId: string; head: string }, quote: string, body = 'Is this measured?', who = 'alice') =>
  app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/documents/${s.documentId}/comments`, headers: H[who], payload: { base_revision_id: s.head, selection: await selection(first, A, quote), body } });
const list = async (s: { paperId: string; documentId: string }) => (await app.inject({ method: 'GET', url: `/api/papers/${s.paperId}/documents/${s.documentId}/comments`, headers: H.alice })).json();

describe('comment threads', () => {
  test('a comment starts on a verified selection and is attached where it was made', async () => {
    const s = await setup();
    const r = await comment(s, 'Expression rose in roots.');
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ state: 'OPEN', anchor: { block_id: A, quote: 'Expression rose in roots.', prefix: 'Roots grew. ' }, resolved: { state: 'ATTACHED', from: 12, moved: false }, messages: [{ body: 'Is this measured?' }] });
    const sel = await selection(first, A, 'Expression');
    const bad = await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/documents/${s.documentId}/comments`, headers: H.alice, payload: { base_revision_id: s.head, selection: { ...sel, selected_slice_hash: 'c'.repeat(64) }, body: 'x' } });
    expect(bad.statusCode).toBe(409);
    expect((await comment(s, 'Expression', '   ')).statusCode).toBe(422);
  });

  test('TST-018A: after the paragraph moves and a small edit, the comment stays on its text', async () => {
    const s = await setup();
    await comment(s, 'Expression rose in roots.');
    await save(s, docOf(para(B, 'Other paragraph.'), para(A, 'Roots grew quickly. Expression rose in roots. Leaves were small.')));
    const { head_revision_id, threads } = await list(s);
    expect(head_revision_id).toBe(s.head);
    expect(threads[0].resolved).toEqual({ state: 'ATTACHED', block_id: A, from: 20, to: 45, moved: true });
  });

  test('TST-018B: deleted text or several equal candidates make the comment ORPHANED, never moved elsewhere', async () => {
    const s = await setup();
    await comment(s, 'Expression rose in roots.');
    await save(s, docOf(para(A, 'Roots grew. Leaves were small.'), para(B, 'Expression rose in roots.')));
    expect((await list(s)).threads[0].resolved).toEqual({ state: 'ORPHANED', reason: 'TEXT_CHANGED' });
    await save(s, docOf(para(A, 'Roots grew. Expression rose in roots. Leaves were small. Roots grew. Expression rose in roots. Leaves were small.')));
    expect((await list(s)).threads[0].resolved).toEqual({ state: 'ORPHANED', reason: 'AMBIGUOUS' });
    await save(s, docOf(para(B, 'Roots grew. Expression rose in roots. Leaves were small.')));
    expect((await list(s)).threads[0].resolved).toEqual({ state: 'ORPHANED', reason: 'BLOCK_MISSING' });
  });

  test('an orphaned comment can be attached again by the owner; the old anchor is kept', async () => {
    const s = await setup();
    const t = (await comment(s, 'Expression rose in roots.')).json();
    const next = docOf(para(A, 'Roots grew. Expression clearly rose in roots. Leaves were small.'));
    await save(s, next);
    expect((await list(s)).threads[0].resolved.state).toBe('ORPHANED');
    const r = await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/comments/${t.id}/anchor`, headers: H.alice, payload: { base_revision_id: s.head, selection: await selection(next, A, 'Expression clearly rose in roots.') } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().resolved).toMatchObject({ state: 'ATTACHED', from: 12 });
    expect((await pool.query('SELECT count(*)::int AS n FROM comment_anchors WHERE thread_id = $1', [t.id])).rows[0].n).toBe(2);
  });

  test('replies, resolve and reopen are the owner\'s; rejecting an AI proposal keeps the comment', async () => {
    const s = await setup();
    const t = (await comment(s, 'Expression rose in roots.')).json();
    const reply = await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/comments/${t.id}/messages`, headers: H.alice, payload: { body: 'Yes, qPCR.' } });
    expect(reply.json().messages.map((m: { body: string }) => m.body)).toEqual(['Is this measured?', 'Yes, qPCR.']);
    expect((await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/comments/${t.id}/resolve`, headers: H.alice })).json().state).toBe('RESOLVED');
    expect((await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/comments/${t.id}/resolve`, headers: H.alice })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/comments/${t.id}/reopen`, headers: H.alice })).json().state).toBe('OPEN');
    // an AI proposal on the same text is rejected: the comment is untouched
    const h = (await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/documents/${s.documentId}/selection-handles`, headers: H.alice, payload: { base_revision_id: s.head, selection: await selection(first, A, 'Expression rose in roots.') } })).json();
    const p = await createProposal(pool, { paperId: s.paperId, handleId: h.id, intent: 'concise', replacement: [{ type: 'text', text: 'Expression rose.' }], origin: 'worker:test' });
    await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/proposals/${p.id}/reject`, headers: H.alice });
    const after = (await list(s)).threads[0];
    expect(after).toMatchObject({ state: 'OPEN', resolved: { state: 'ATTACHED' } });
    expect(after.messages).toHaveLength(2);
    const audit = (await pool.query("SELECT to_state FROM audit_events WHERE entity_id = $1 ORDER BY id", [t.id])).rows.map((x) => x.to_state);
    expect(audit).toEqual(['OPEN', 'RESOLVED', 'OPEN']);
  });

  test('messages and anchors cannot be changed; a thread changes only its state; other owners see nothing', async () => {
    const s = await setup();
    const t = (await comment(s, 'Expression rose in roots.')).json();
    await expect(pool.query('UPDATE comment_messages SET body = $2 WHERE thread_id = $1', [t.id, 'edited'])).rejects.toThrow(/immutable/);
    await expect(pool.query('UPDATE comment_anchors SET quote = $2 WHERE thread_id = $1', [t.id, 'x'])).rejects.toThrow(/immutable/);
    await expect(pool.query('UPDATE comment_threads SET document_id = document_id, created_by = $2 WHERE id = $1', [t.id, (await pool.query("SELECT id FROM owners WHERE username = 'bob'")).rows[0].id])).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM comment_threads WHERE id = $1', [t.id])).rejects.toThrow(/immutable/);
    expect((await app.inject({ method: 'GET', url: `/api/papers/${s.paperId}/documents/${s.documentId}/comments`, headers: H.bob })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/comments/${t.id}/messages`, headers: H.bob, payload: { body: 'hi' } })).statusCode).toBe(404);
  });
});
