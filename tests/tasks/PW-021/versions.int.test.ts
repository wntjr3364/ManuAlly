// PW-021 — undo of an applied AI edit and version history (REQ-021-A), and imports that never replace the
// manuscript unannounced nor remove history (REQ-021-B). Every head change is a new revision.
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
const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
let H: Record<string, string>;
let other: Record<string, string>;

async function login(username: string) {
  await createOwner(pool, { username, password: 'correct horse battery' });
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username, password: 'correct horse battery' } });
  return { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken, origin: ORIGIN };
}
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 6 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  H = await login('alice');
  other = await login('mallory');
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});

const call = (method: 'GET' | 'POST', url: string, payload?: unknown, headers = H) => app.inject({ method, url, headers, payload: payload as object | undefined });
const para = (id: string, text: string) => ({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] });
const doc = (a: string, b: string) => ({ type: 'doc', content: [para(P1, a), para(P2, b)] });
const key = () => randomUUID().replaceAll('-', '');

async function paper() {
  return (await call('POST', '/api/papers', { working_title: 'p', article_type: 'research_article' })).json().id as string;
}
async function manuscript(paperId: string, content = doc('It was very very clear.', 'Second stays.')) {
  const d = (await call('POST', `/api/papers/${paperId}/documents`, { kind: 'manuscript' })).json();
  const saved = (await call('POST', `/api/papers/${paperId}/documents/${d.document.id}/saves`, { expected_head_revision_id: d.head.id, content_json: content, schema_version: 1, reason: 'manual' })).json();
  return { documentId: d.document.id as string, head: saved.id as string, content };
}
const save = async (paperId: string, documentId: string, expected: string, content: unknown) =>
  (await call('POST', `/api/papers/${paperId}/documents/${documentId}/saves`, { expected_head_revision_id: expected, content_json: content, schema_version: 1, reason: 'manual' })).json().id as string;
async function appliedEdit(paperId: string, m: { documentId: string; head: string; content: unknown }) {
  const text = 'It was very very clear.';
  const from = text.indexOf('very very ');
  const selection = await snapshotSelection(parseDocument(m.content, 1), { blockId: P1, from, to: from + 'very very '.length });
  const h = (await call('POST', `/api/papers/${paperId}/documents/${m.documentId}/selection-handles`, { base_revision_id: m.head, selection })).json();
  const p = await createProposal(pool, { paperId, handleId: h.id, intent: 'concise', replacement: [], origin: 'worker:test' });
  const r = await call('POST', `/api/papers/${paperId}/proposals/${p.id}/apply`, { proposal_hash: p.proposal_hash, expected_revision_id: m.head, idempotency_key: key() });
  expect(r.statusCode, r.body).toBe(201);
  return { proposalId: p.id, applied: r.json().revision.id as string };
}
const headOf = async (documentId: string) => (await pool.query('SELECT r.id, r.reason, r.content_json FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.id = $1', [documentId])).rows[0];
const revCount = async (documentId: string) => (await pool.query('SELECT count(*)::int AS n FROM document_revisions WHERE document_id = $1', [documentId])).rows[0].n as number;
const auditCount = async (paperId: string) => (await pool.query('SELECT count(*)::int AS n FROM audit_events WHERE paper_id = $1', [paperId])).rows[0].n as number;
const firstText = (content: { content: { content: { text: string }[] }[] }) => content.content[0]!.content.map((c) => c.text).join('');

describe('TST-021A: undo an applied AI edit; compare and restore versions', () => {
  test('undo puts the paragraph back as a new revision and keeps later edits elsewhere', async () => {
    const p = await paper();
    const m = await manuscript(p);
    const e = await appliedEdit(p, m);
    // a later edit in another paragraph
    const later = await save(p, m.documentId, e.applied, doc('It was clear.', 'Second was edited later.'));
    const list = (await call('GET', `/api/papers/${p}/documents/${m.documentId}/applied-edits`)).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ proposal_id: e.proposalId, applied_revision_id: e.applied, undo_revision_id: null, can_undo: true });
    const before = await revCount(m.documentId);
    const r = await call('POST', `/api/papers/${p}/proposals/${e.proposalId}/undo`, { expected_head_revision_id: later });
    expect(r.statusCode, r.body).toBe(201);
    const head = await headOf(m.documentId);
    expect(head).toMatchObject({ id: r.json().revision.id, reason: 'undo' });
    expect(firstText(head.content_json)).toBe('It was very very clear.');
    expect(head.content_json.content[1].content[0].text).toBe('Second was edited later.');
    expect(await revCount(m.documentId)).toBe(before + 1);
    expect((await call('GET', `/api/papers/${p}/documents/${m.documentId}/applied-edits`)).json()[0]).toMatchObject({ undo_revision_id: head.id, can_undo: false });
    // once only
    const again = await call('POST', `/api/papers/${p}/proposals/${e.proposalId}/undo`, { expected_head_revision_id: head.id });
    expect(again.statusCode).toBe(409);
    expect(again.json().reason).toBe('ALREADY_UNDONE');
  });

  test('undo is refused when the paragraph changed after the edit, or the head is not the expected one', async () => {
    const p = await paper();
    const m = await manuscript(p);
    const e = await appliedEdit(p, m);
    const n = await revCount(m.documentId);
    expect((await call('POST', `/api/papers/${p}/proposals/${e.proposalId}/undo`, { expected_head_revision_id: m.head })).statusCode).toBe(409); // stale head
    const changed = await save(p, m.documentId, e.applied, doc('It was clear, indeed.', 'Second stays.'));
    const r = await call('POST', `/api/papers/${p}/proposals/${e.proposalId}/undo`, { expected_head_revision_id: changed });
    expect(r.statusCode).toBe(409);
    expect(r.json().reason).toBe('CHANGED_SINCE_APPLY');
    expect((await call('GET', `/api/papers/${p}/documents/${m.documentId}/applied-edits`)).json()[0]).toMatchObject({ can_undo: false });
    expect(await revCount(m.documentId)).toBe(n + 1); // only the manual save
    expect((await call('POST', `/api/papers/${p}/proposals/${e.proposalId}/undo`, { expected_head_revision_id: changed }, other)).statusCode).toBe(404);
  });

  test('a pending (not applied) proposal cannot be undone', async () => {
    const p = await paper();
    const m = await manuscript(p);
    const selection = await snapshotSelection(parseDocument(m.content, 1), { blockId: P1, from: 0, to: 2 });
    const h = (await call('POST', `/api/papers/${p}/documents/${m.documentId}/selection-handles`, { base_revision_id: m.head, selection })).json();
    const prop = await createProposal(pool, { paperId: p, handleId: h.id, intent: 'grammar', replacement: [{ type: 'text', text: 'it' }], origin: 'worker:test' });
    const r = await call('POST', `/api/papers/${p}/proposals/${prop.id}/undo`, { expected_head_revision_id: m.head });
    expect(r.statusCode).toBe(409);
    expect(r.json().reason).toBe('NOT_APPLIED');
  });

  test('restore makes a new head from an old revision; history and audit only grow', async () => {
    const p = await paper();
    const m = await manuscript(p);
    const e = await appliedEdit(p, m);
    const revs = (await call('GET', `/api/papers/${p}/documents/${m.documentId}/revisions`)).json();
    expect(revs.map((r: { reason: string }) => r.reason)).toEqual(['ai_apply', 'manual', 'initial']);
    const audits = await auditCount(p);
    const n = await revCount(m.documentId);
    const r = await call('POST', `/api/papers/${p}/documents/${m.documentId}/restore`, { revision_id: m.head, expected_head_revision_id: e.applied });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ reason: 'restore', restored_from_revision_id: m.head, parent_revision_id: e.applied });
    expect(await revCount(m.documentId)).toBe(n + 1);
    expect(await auditCount(p)).toBeGreaterThanOrEqual(audits);
    // every earlier revision is still readable, the applied one included
    for (const id of [m.head, e.applied]) expect((await call('GET', `/api/papers/${p}/documents/${m.documentId}/revisions/${id}`)).statusCode).toBe(200);
    await expect(pool.query('DELETE FROM document_revisions WHERE id = $1', [e.applied])).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM proposal_undos')).rejects.toThrow(/immutable/);
  });
});

describe('TST-021B: imports preview first and never replace the manuscript unannounced', () => {
  const MD = '# Results\n\nCells grew **2.4-fold**.\n\nSee [link](https://example.org).';

  test('an import is stored as received with a preview and loss report; nothing else changes', async () => {
    const p = await paper();
    const m = await manuscript(p);
    const r = await call('POST', `/api/papers/${p}/imports`, { format: 'markdown', filename: 'draft.md', text: MD });
    expect(r.statusCode, r.body).toBe(201);
    const imp = r.json();
    expect(imp).toMatchObject({ format: 'markdown', filename: 'draft.md', byte_size: Buffer.byteLength(MD), report: { blocks: 3, losses: [{ kind: 'link' }] } });
    expect(imp.preview.content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(imp.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await headOf(m.documentId)).id).toBe(m.head);
    const row = (await pool.query('SELECT source_text FROM import_sources WHERE id = $1', [imp.id])).rows[0];
    expect(row.source_text).toBe(MD);
    await expect(pool.query("UPDATE import_sources SET source_text = 'x' WHERE id = $1", [imp.id])).rejects.toThrow(/immutable/);
    expect((await call('GET', `/api/papers/${p}/imports/${imp.id}`)).json().id).toBe(imp.id);
    expect((await call('GET', `/api/papers/${p}/imports/${imp.id}`, undefined, other)).statusCode).toBe(404);
  });

  test('replacing the manuscript needs explicit confirmation and the current head; history is kept', async () => {
    const p = await paper();
    const m = await manuscript(p);
    const imp = (await call('POST', `/api/papers/${p}/imports`, { format: 'markdown', filename: 'draft.md', text: MD })).json();
    const url = `/api/papers/${p}/imports/${imp.id}/apply`;
    const noConfirm = await call('POST', url, { mode: 'replace_manuscript', document_id: m.documentId, expected_head_revision_id: m.head });
    expect(noConfirm.statusCode).toBe(422);
    expect(noConfirm.json().reason).toBe('CONFIRM_REQUIRED');
    expect((await call('POST', url, { mode: 'replace_manuscript', document_id: m.documentId, expected_head_revision_id: randomUUID(), confirm_replace: true })).statusCode).toBe(409);
    expect((await call('POST', url, { mode: 'new_manuscript' })).statusCode).toBe(409); // a manuscript exists already
    expect((await headOf(m.documentId)).id).toBe(m.head);
    const ok = await call('POST', url, { mode: 'replace_manuscript', document_id: m.documentId, expected_head_revision_id: m.head, confirm_replace: true });
    expect(ok.statusCode, ok.body).toBe(201);
    const head = await headOf(m.documentId);
    expect(head).toMatchObject({ id: ok.json().revision.id, reason: 'import' });
    expect(head.content_json.content[0].content[0].text).toBe('Results');
    // the replaced text is still there and can be restored
    const back = await call('POST', `/api/papers/${p}/documents/${m.documentId}/restore`, { revision_id: m.head, expected_head_revision_id: head.id });
    expect(back.statusCode).toBe(201);
    expect(firstText((await headOf(m.documentId)).content_json)).toBe('It was very very clear.');
    // an import is applied once
    const twice = await call('POST', url, { mode: 'replace_manuscript', document_id: m.documentId, expected_head_revision_id: back.json().id, confirm_replace: true });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().reason).toBe('ALREADY_APPLIED');
  });

  test('a paper without a manuscript gets one from the import', async () => {
    const p = await paper();
    const imp = (await call('POST', `/api/papers/${p}/imports`, { format: 'text', text: 'One.\n\nTwo.' })).json();
    const r = await call('POST', `/api/papers/${p}/imports/${imp.id}/apply`, { mode: 'new_manuscript' });
    expect(r.statusCode, r.body).toBe(201);
    const docs = (await call('GET', `/api/papers/${p}/documents`)).json();
    expect(docs.filter((d: { kind: string }) => d.kind === 'manuscript')).toHaveLength(1);
    const head = await headOf(docs[0].id);
    expect(head.reason).toBe('import');
    expect(head.content_json.content.map((b: { content: { text: string }[] }) => b.content[0]!.text)).toEqual(['One.', 'Two.']);
  });

  test('bad imports are refused', async () => {
    const p = await paper();
    expect((await call('POST', `/api/papers/${p}/imports`, { format: 'docx', text: 'x' })).statusCode).toBe(422);
    expect((await call('POST', `/api/papers/${p}/imports`, { format: 'text', text: '   ' })).statusCode).toBe(422);
    expect((await call('POST', `/api/papers/${p}/imports`, { format: 'text', text: 'x', filename: 'a'.repeat(300) })).statusCode).toBe(422);
    const big = await call('POST', `/api/papers/${p}/imports`, { format: 'text', text: 'x'.repeat(900_000) + '\n\n' + 'y'.repeat(200_000) });
    expect([413, 422]).toContain(big.statusCode);
    expect((await pool.query('SELECT count(*)::int AS n FROM import_sources WHERE paper_id = $1', [p])).rows[0].n).toBe(0);
  });
});
