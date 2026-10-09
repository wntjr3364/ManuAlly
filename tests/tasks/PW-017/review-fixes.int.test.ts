// PW-017 independent review regressions: the checks see the whole paragraph (a replacement next to a
// number cannot change it), a wrong expected revision does not kill a proposal, and "approved outline"
// means the same as the draft gate (no rewrite while the outline awaits impact review).
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
let H: Record<string, string>;
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 6 });
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

const call = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, headers: H, payload: payload as object | undefined });
const TEXT = 'Mice received 2.5 mg of drug daily.';
const content = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P }, content: [{ type: 'text', text: TEXT }] }] };

async function setup() {
  const p = (await call('POST', '/api/papers', { working_title: 'p', article_type: 'research_article' })).json();
  const d = (await call('POST', `/api/papers/${p.id}/documents`, { kind: 'manuscript' })).json();
  const saved = (await call('POST', `/api/papers/${p.id}/documents/${d.document.id}/saves`, { expected_head_revision_id: d.head.id, content_json: content, schema_version: 1, reason: 'manual' })).json();
  return { paperId: p.id as string, documentId: d.document.id as string, head: saved.id as string };
}
async function handle(s: { paperId: string; documentId: string; head: string }, from: number, to: number) {
  const selection = await snapshotSelection(parseDocument(content, 1), { blockId: P, from, to });
  const r = await call('POST', `/api/papers/${s.paperId}/documents/${s.documentId}/selection-handles`, { base_revision_id: s.head, selection });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
const propose = (s: { paperId: string }, handleId: string, replacement: unknown[], intent = 'grammar') =>
  createProposal(pool, { paperId: s.paperId, handleId, intent, replacement, origin: 'worker:test' });
const key = () => randomUUID().replaceAll('-', '');

describe('review MAJOR: a replacement next to a number cannot change the number', () => {
  test('removing the "." of 2.5 (which would read 25 mg) is CHECK_FAILED', async () => {
    const s = await setup();
    const dot = TEXT.indexOf('2.5') + 1;
    const p = await propose(s, await handle(s, dot, dot + 1), []);
    expect(p.status).toBe('CHECK_FAILED');
    expect(p.checks.find((c) => c.check === 'numbers')).toMatchObject({ result: 'fail', details: expect.stringContaining('25 mg') });
  });

  test('changing the "m" of mg to µ (2.5 µg) is CHECK_FAILED', async () => {
    const s = await setup();
    const m = TEXT.indexOf('mg');
    const p = await propose(s, await handle(s, m, m + 1), [{ type: 'text', text: 'µ' }]);
    expect(p.status).toBe('CHECK_FAILED');
  });

  test('a wider selection that keeps every quantity still passes', async () => {
    const s = await setup();
    const p = await propose(s, await handle(s, 0, 'Mice received'.length), [{ type: 'text', text: 'The mice were given' }]);
    expect(p.status).toBe('PENDING');
  });
});

describe('review MINOR-1: a wrong expected revision is refused without changing the proposal', () => {
  test('the proposal stays PENDING and the right apply then succeeds', async () => {
    const s = await setup();
    const p = await propose(s, await handle(s, 0, 4), [{ type: 'text', text: 'Rats' }]);
    const wrong = await call('POST', `/api/papers/${s.paperId}/proposals/${p.id}/apply`, { proposal_hash: p.proposal_hash, expected_revision_id: randomUUID(), idempotency_key: key() });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().reason).toBe('EXPECTED_REVISION_MISMATCH');
    expect((await pool.query('SELECT status FROM edit_proposals WHERE id = $1', [p.id])).rows[0].status).toBe('PENDING');
    const ok = await call('POST', `/api/papers/${s.paperId}/proposals/${p.id}/apply`, { proposal_hash: p.proposal_hash, expected_revision_id: p.base_revision_id, idempotency_key: key() });
    expect(ok.statusCode, ok.body).toBe(201);
  });
});

describe('review MINOR-3: academic rewrite needs the outline the draft gate accepts', () => {
  const brief = { purpose: 'Test whether ABC1 responds to drought', audience: 'plant stress biologists', known_facts: ['ABC1 induced 2.4-fold'], missing_material: [], avoid_claims: [] };
  const story = (msg: string) => ({ question: 'Does ABC1 respond to drought?', main_message: msg, novelty: 'none yet', evidence_links: [], competing_explanations: [], presentation_order: ['induction'], limitations: ['single genotype'] });
  const node = () => ({ node_id: randomUUID(), parent_node_id: null, section: 'Results', role: 'result', paragraph_goal: 'Report dosing', claim_ids: [], evidence_ids: [], requires_evidence: false, allowed_interpretation: 'observation only', exclusions: [], transition: '', word_budget_min: 40, word_budget_max: 80 });

  test('rewrite is allowed under an approved outline and refused again once a new story awaits impact review', async () => {
    const s = await setup();
    const s1 = (await call('POST', `/api/papers/${s.paperId}/story/revisions`, { parent_revision_id: null, brief, story: story('ABC1 is drought-induced') })).json();
    expect((await call('POST', `/api/papers/${s.paperId}/story/revisions/${s1.id}/approve`, { intent: 'approve_story', content_hash: s1.content_hash })).statusCode).toBe(200);
    const o1 = (await call('POST', `/api/papers/${s.paperId}/outline/revisions`, { parent_revision_id: null, story_revision_id: s1.id, nodes: [node()] })).json();
    expect((await call('POST', `/api/papers/${s.paperId}/outline/revisions/${o1.id}/approve`, { intent: 'approve_outline', content_hash: o1.content_hash })).json().status).toBe('APPROVED');
    const h = await handle(s, 0, 4);
    const ok = await propose(s, h, [{ type: 'text', text: 'Rats' }], 'rewrite');
    expect(ok).toMatchObject({ mode: 'approved_outline', outline_revision_id: o1.id });
    // a new story is approved: the outline must go through impact review before rewrites again
    const s2 = (await call('POST', `/api/papers/${s.paperId}/story/revisions`, { parent_revision_id: s1.id, brief, story: story('ABC1 is strongly drought-induced') })).json();
    expect((await call('POST', `/api/papers/${s.paperId}/story/revisions/${s2.id}/approve`, { intent: 'approve_story', content_hash: s2.content_hash })).statusCode).toBe(200);
    await expect(propose(s, h, [{ type: 'text', text: 'Rats' }], 'rewrite')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await propose(s, h, [{ type: 'text', text: 'Rats' }], 'grammar')).toMatchObject({ mode: 'preapproval', outline_revision_id: null });
  });
});
