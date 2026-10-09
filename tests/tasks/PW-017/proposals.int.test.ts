// PW-017 — TST-017A / TST-017B: one user apply changes only the selected range in a new revision;
// stale, duplicate, check-failed and late proposals are refused or answered with the existing result,
// never a silent overwrite.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { createProposal } from '../../../packages/domain/src/proposals/index.ts';
import { parseDocument, snapshotSelection } from '../../../packages/editor-core/src/index.ts';
import { validateEditProposal } from '../../../packages/contracts/src/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const REF = '00000000-0000-4000-8000-0000000000f1';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
const H: Record<string, Record<string, string>> = {};
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
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

const content = {
  type: 'doc',
  content: [
    { type: 'paragraph', attrs: { id: P1 }, content: [{ type: 'text', text: 'Expression rose 2.4-fold in roots ' }, { type: 'citation', attrs: { referenceId: REF, locator: null } }, { type: 'text', text: '. It was very very clear.' }] },
    { type: 'paragraph', attrs: { id: P2 }, content: [{ type: 'text', text: 'Second paragraph stays.' }] },
  ],
};

async function setup(text = content) {
  const p = (await app.inject({ method: 'POST', url: '/api/papers', headers: H.alice, payload: { working_title: 'p', article_type: 'research_article' } })).json();
  const d = (await app.inject({ method: 'POST', url: `/api/papers/${p.id}/documents`, headers: H.alice, payload: { kind: 'manuscript' } })).json();
  const saved = (await app.inject({ method: 'POST', url: `/api/papers/${p.id}/documents/${d.document.id}/saves`, headers: H.alice, payload: { expected_head_revision_id: d.head.id, content_json: text, schema_version: 1, reason: 'manual' } })).json();
  return { paperId: p.id as string, documentId: d.document.id as string, head: saved.id as string };
}
async function handleFor(s: { paperId: string; documentId: string; head: string }, quote: string, blockId = P1, who = 'alice') {
  const doc = parseDocument((await pool.query('SELECT content_json FROM document_revisions WHERE id = $1', [s.head])).rows[0].content_json, 1);
  let from = -1;
  doc.forEach((n) => { if (n.attrs.id === blockId) from = n.textBetween(0, n.content.size, '\n', '￼').indexOf(quote); });
  const selection = await snapshotSelection(doc, { blockId, from, to: from + quote.length });
  return app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/documents/${s.documentId}/selection-handles`, headers: H[who], payload: { base_revision_id: s.head, selection } });
}
const apply = (s: { paperId: string }, p: { id: string; proposal_hash: string; base_revision_id: string }, key: string, over: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/proposals/${p.id}/apply`, headers: H.alice, payload: { proposal_hash: p.proposal_hash, expected_revision_id: p.base_revision_id, idempotency_key: key, ...over } });
const key = () => crypto.randomUUID().replaceAll('-', '');
const head = async (documentId: string) => (await pool.query('SELECT r.* FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.id = $1', [documentId])).rows[0];
const revCount = async (documentId: string) => (await pool.query('SELECT count(*)::int AS n FROM document_revisions WHERE document_id = $1', [documentId])).rows[0].n as number;

describe('selection handles', () => {
  test('the server stores a handle only when it derives the same snapshot from the stored revision', async () => {
    const s = await setup();
    const ok = await handleFor(s, 'very very clear');
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ base_revision_id: s.head, block_id: P1, quote: 'very very clear' });
    const doc = parseDocument(content, 1);
    const sel = await snapshotSelection(doc, { blockId: P1, from: 0, to: 10 });
    const tampered = await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/documents/${s.documentId}/selection-handles`, headers: H.alice, payload: { base_revision_id: s.head, selection: { ...sel, expected_block_hash: 'a'.repeat(64) } } });
    expect(tampered.statusCode).toBe(409);
    expect(tampered.json().reason).toBe('SELECTION_MISMATCH');
    const split = await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/documents/${s.documentId}/selection-handles`, headers: H.alice, payload: { base_revision_id: s.head, selection: { ...sel, to: 200 } } });
    expect(split.statusCode).toBe(422);
    expect((await handleFor(s, 'very', P1, 'bob')).statusCode).toBe(404);
  });
});

describe('TST-017A: apply', () => {
  test('one apply puts only the selected range into a new revision', async () => {
    const s = await setup();
    const h = (await handleFor(s, 'very very clear')).json();
    const p = await createProposal(pool, { paperId: s.paperId, handleId: h.id, intent: 'concise', replacement: [{ type: 'text', text: 'clear' }], explanation: 'removed repetition', origin: 'worker:test' });
    expect(p).toMatchObject({ status: 'PENDING', mode: 'preapproval', outline_revision_id: null });
    expect(validateEditProposal(p.proposal)).toMatchObject({ ok: true });
    const preview = (await app.inject({ method: 'GET', url: `/api/papers/${s.paperId}/proposals/${p.id}`, headers: H.alice })).json();
    expect(preview.after_block.content.at(-1).text).toBe('. It was clear.');
    const r = await apply(s, p, key());
    expect(r.statusCode, r.body).toBe(201);
    const after = await head(s.documentId);
    expect(after).toMatchObject({ id: r.json().revision.id, parent_revision_id: s.head, reason: 'ai_apply' });
    const expected = structuredClone(content);
    expected.content[0]!.content[2] = { type: 'text', text: '. It was clear.' };
    expect(after.content_json).toEqual(expected); // the other paragraph and the citation are untouched
    expect(r.json().proposal).toMatchObject({ status: 'APPLIED', applied_revision_id: after.id });
    const audit = (await pool.query("SELECT action, to_state, actor FROM audit_events WHERE entity_id = $1 ORDER BY id", [p.id])).rows;
    expect(audit.map((x) => x.to_state)).toEqual(['PENDING', 'APPLIED']);
    expect(audit[1].actor).toMatch(/^owner:/);
  });
});

describe('TST-017B: nothing is overwritten silently', () => {
  test('a resent apply returns the same result; another apply of the same proposal is refused with that result', async () => {
    const s = await setup();
    const h = (await handleFor(s, 'very very clear')).json();
    const p = await createProposal(pool, { paperId: s.paperId, handleId: h.id, intent: 'concise', replacement: [{ type: 'text', text: 'clear' }], origin: 'worker:test' });
    const k = key();
    const first = await apply(s, p, k);
    const again = await apply(s, p, k);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, revision: { id: first.json().revision.id } });
    const other = await apply(s, p, key());
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ reason: 'ALREADY_APPLIED', applied_revision_id: first.json().revision.id });
    expect(await revCount(s.documentId)).toBe(3); // initial, saved, applied once
  });

  test('two applies at the same time: exactly one succeeds', async () => {
    const s = await setup();
    const h = (await handleFor(s, 'very very clear')).json();
    const p = await createProposal(pool, { paperId: s.paperId, handleId: h.id, intent: 'concise', replacement: [{ type: 'text', text: 'clear' }], origin: 'worker:test' });
    const rs = await Promise.all([apply(s, p, key()), apply(s, p, key()), apply(s, p, key())]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    expect(await revCount(s.documentId)).toBe(3);
  });

  test('two different proposals on the same revision applied at the same time: one wins, the other is STALE', async () => {
    const s = await setup();
    const h1 = (await handleFor(s, 'very very clear')).json();
    const h2 = (await handleFor(s, 'Second paragraph stays.', P2)).json();
    const p1 = await createProposal(pool, { paperId: s.paperId, handleId: h1.id, intent: 'concise', replacement: [{ type: 'text', text: 'clear' }], origin: 'worker:test' });
    const p2 = await createProposal(pool, { paperId: s.paperId, handleId: h2.id, intent: 'grammar', replacement: [{ type: 'text', text: 'The second paragraph stays.' }], origin: 'worker:test' });
    const rs = await Promise.all([apply(s, p1, key()), apply(s, p2, key())]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(rs.find((r) => r.statusCode === 409)!.json().reason).toBe('STALE');
    const winner = rs.find((r) => r.statusCode === 201)!.json().revision.id;
    expect((await head(s.documentId)).id).toBe(winner);
    expect(await revCount(s.documentId)).toBe(3); // no second child of the same base
  });

  test('a proposal whose base is no longer the head becomes STALE; the newer text is kept', async () => {
    const s = await setup();
    const h = (await handleFor(s, 'very very clear')).json();
    const p = await createProposal(pool, { paperId: s.paperId, handleId: h.id, intent: 'concise', replacement: [{ type: 'text', text: 'clear' }], origin: 'worker:test' });
    const edited = structuredClone(content);
    edited.content[1]!.content[0] = { type: 'text', text: 'Second paragraph edited meanwhile.' };
    const saved = (await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/documents/${s.documentId}/saves`, headers: H.alice, payload: { expected_head_revision_id: s.head, content_json: edited, schema_version: 1, reason: 'autosave' } })).json();
    const r = await apply(s, p, key());
    expect(r.statusCode).toBe(409);
    expect(r.json().reason).toBe('STALE');
    expect((await head(s.documentId)).id).toBe(saved.id);
    expect((await pool.query('SELECT status FROM edit_proposals WHERE id = $1', [p.id])).rows[0].status).toBe('STALE');
    expect((await apply(s, p, key())).json().reason).toBe('STALE');
  });

  test('an apply naming another revision or a changed proposal is refused', async () => {
    const s = await setup();
    const h = (await handleFor(s, 'very very clear')).json();
    const p = await createProposal(pool, { paperId: s.paperId, handleId: h.id, intent: 'concise', replacement: [{ type: 'text', text: 'clear' }], origin: 'worker:test' });
    expect((await apply(s, p, key(), { proposal_hash: 'b'.repeat(64) })).json().reason).toBe('PROPOSAL_CHANGED');
    const wrongRev = await apply(s, p, key(), { expected_revision_id: crypto.randomUUID() });
    expect(wrongRev.statusCode).toBe(409);
    expect(await revCount(s.documentId)).toBe(2);
  });

  test('a late answer (made after the manuscript changed) is stored as STALE and cannot be applied', async () => {
    const s = await setup();
    const h = (await handleFor(s, 'very very clear')).json();
    const edited = structuredClone(content);
    edited.content[1]!.content[0] = { type: 'text', text: 'Changed before the answer.' };
    await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/documents/${s.documentId}/saves`, headers: H.alice, payload: { expected_head_revision_id: s.head, content_json: edited, schema_version: 1, reason: 'autosave' } });
    const p = await createProposal(pool, { paperId: s.paperId, handleId: h.id, intent: 'grammar', replacement: [{ type: 'text', text: 'clear' }], origin: 'worker:test' });
    expect(p.status).toBe('STALE');
    expect((await apply(s, p, key())).json().reason).toBe('STALE');
  });

  test('a replacement that changes a number or a citation is CHECK_FAILED and can never be applied', async () => {
    const s = await setup();
    const h = (await handleFor(s, 'rose 2.4-fold in roots ')).json();
    const p = await createProposal(pool, { paperId: s.paperId, handleId: h.id, intent: 'grammar', replacement: [{ type: 'text', text: 'rose 2.5-fold in roots ' }], origin: 'worker:test' });
    expect(p.status).toBe('CHECK_FAILED');
    expect(p.checks.find((c) => c.check === 'numbers')).toMatchObject({ result: 'fail' });
    expect((await apply(s, p, key())).json().reason).toBe('CHECK_FAILED');
    const hc = (await handleFor(s, 'roots ￼')).json();
    const pc = await createProposal(pool, { paperId: s.paperId, handleId: hc.id, intent: 'grammar', replacement: [{ type: 'text', text: 'roots' }], origin: 'worker:test' });
    expect(pc.status).toBe('CHECK_FAILED');
    expect(await revCount(s.documentId)).toBe(2);
  });

  test('before outline approval an academic rewrite is refused (RFC-003); a rejected proposal cannot be applied', async () => {
    const s = await setup();
    const h = (await handleFor(s, 'very very clear')).json();
    await expect(createProposal(pool, { paperId: s.paperId, handleId: h.id, intent: 'rewrite', replacement: [{ type: 'text', text: 'evident' }], origin: 'worker:test' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const p = await createProposal(pool, { paperId: s.paperId, handleId: h.id, intent: 'concise', replacement: [{ type: 'text', text: 'clear' }], origin: 'worker:test' });
    expect((await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/proposals/${p.id}/reject`, headers: H.alice })).json().status).toBe('REJECTED');
    expect((await apply(s, p, key())).json().reason).toBe('REJECTED');
  });

  test('the database refuses changing a proposal\'s content or reopening it', async () => {
    const s = await setup();
    const h = (await handleFor(s, 'very very clear')).json();
    const p = await createProposal(pool, { paperId: s.paperId, handleId: h.id, intent: 'concise', replacement: [{ type: 'text', text: 'clear' }], origin: 'worker:test' });
    await expect(pool.query("UPDATE edit_proposals SET replacement = '[]' WHERE id = $1", [p.id])).rejects.toThrow(/immutable/);
    await apply(s, p, key());
    await expect(pool.query("UPDATE edit_proposals SET status = 'PENDING', applied_revision_id = NULL, decided_by = NULL WHERE id = $1", [p.id])).rejects.toThrow(/cannot become/);
    await expect(pool.query('UPDATE selection_handles SET quote = $2 WHERE id = $1', [h.id, 'x'])).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM proposal_applies')).rejects.toThrow(/immutable/);
  });

  test('another owner cannot read, apply or reject', async () => {
    const s = await setup();
    const h = (await handleFor(s, 'very very clear')).json();
    const p = await createProposal(pool, { paperId: s.paperId, handleId: h.id, intent: 'concise', replacement: [{ type: 'text', text: 'clear' }], origin: 'worker:test' });
    for (const r of [
      await app.inject({ method: 'GET', url: `/api/papers/${s.paperId}/proposals/${p.id}`, headers: H.bob }),
      await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/proposals/${p.id}/apply`, headers: H.bob, payload: { proposal_hash: p.proposal_hash, expected_revision_id: p.base_revision_id, idempotency_key: key() } }),
      await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/proposals/${p.id}/reject`, headers: H.bob }),
    ]) expect(r.statusCode).toBe(404);
  });
});
