// PW-010 — TST-010A / TST-010B (real PostgreSQL)
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
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

const brief = { purpose: 'Test whether ABC1 responds to drought', audience: 'plant stress biologists', known_facts: ['ABC1 induced 2.4-fold'], missing_material: ['photoperiod'], avoid_claims: ['first report'] };
const story = (msg = 'ABC1 is drought-induced; overexpression is associated with survival') => ({ question: 'Does ABC1 respond to drought?', main_message: msg, novelty: 'no systematic review yet', evidence_links: ['fig-1a'], competing_explanations: ['osmotic artefact'], presentation_order: ['induction', 'survival', 'roots'], limitations: ['single genotype'] });
const node = (over: Record<string, unknown> = {}) => ({
  node_id: randomUUID(), parent_node_id: null, section: 'Results', role: 'result', paragraph_goal: 'Report ABC1 induction under drought',
  claim_ids: ['c-induction'], evidence_ids: ['ev-fig1a'], requires_evidence: true, allowed_interpretation: 'observation only',
  exclusions: ['causal language'], transition: 'leads to survival paragraph', word_budget_min: 60, word_budget_max: 120, ...over,
});

beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 6 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  await createOwner(pool, { username: 'alice', password: 'correct horse battery' });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: 'alice', password: 'correct horse battery' } });
  H = { cookie: String(res.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': res.json().csrfToken, origin: ORIGIN };
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});

const call = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, headers: H, payload: payload as object | undefined });
async function paper() {
  return (await call('POST', '/api/papers', { working_title: 'p', article_type: 'research_article' })).json();
}
async function storyRev(paperId: string, parent: string | null, s = story()) {
  const r = await call('POST', `/api/papers/${paperId}/story/revisions`, { parent_revision_id: parent, brief, story: s });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
const approveStory = (paperId: string, rev: { id: string; content_hash: string }) =>
  call('POST', `/api/papers/${paperId}/story/revisions/${rev.id}/approve`, { intent: 'approve_story', content_hash: rev.content_hash });
async function outlineRev(paperId: string, storyRevId: string, parent: string | null, nodes: unknown[]) {
  const r = await call('POST', `/api/papers/${paperId}/outline/revisions`, { parent_revision_id: parent, story_revision_id: storyRevId, nodes });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
const approveOutline = (paperId: string, rev: { id: string; content_hash: string }, nodeIds?: string[]) =>
  call('POST', `/api/papers/${paperId}/outline/revisions/${rev.id}/approve`, { intent: 'approve_outline', content_hash: rev.content_hash, node_ids: nodeIds });
const draftRequest = (paperId: string, outlineRevisionId: string | null, nodeId: string) =>
  call('POST', `/api/papers/${paperId}/ai/draft-requests`, { outline_revision_id: outlineRevisionId, node_id: nodeId, instruction: 'write this paragraph' });

describe('TST-010A: only the exact revision the user names is approved', () => {
  test('story approval needs the exact content hash and an explicit intent; approver comes from the session', async () => {
    const p = await paper();
    const r1 = await storyRev(p.id, null);
    expect(r1.status).toBe('DRAFT');
    expect((await call('POST', `/api/papers/${p.id}/story/revisions/${r1.id}/approve`, { intent: 'approve_story', content_hash: '0'.repeat(64) })).statusCode).toBe(409);
    expect((await call('POST', `/api/papers/${p.id}/story/revisions/${r1.id}/approve`, { content_hash: r1.content_hash })).statusCode).toBe(422);
    const forged = await call('POST', `/api/papers/${p.id}/story/revisions/${r1.id}/approve`, { intent: 'approve_story', content_hash: r1.content_hash, approved_by: randomUUID() });
    expect(forged.statusCode).toBe(422);
    expect(forged.body).toMatch(/approved_by/);
    const ok = await approveStory(p.id, r1);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().status).toBe('APPROVED');
    expect(ok.json().approved_by).toBe((await call('GET', '/api/auth/session')).json().owner.id);
    expect((await call('GET', `/api/papers/${p.id}`)).json().active_story_revision_id).toBe(r1.id);
  });

  test('a new story revision does not retire the approved one until it is approved itself', async () => {
    const p = await paper();
    const r1 = await storyRev(p.id, null);
    await approveStory(p.id, r1);
    const r2 = await storyRev(p.id, r1.id, story('revised message'));
    let s = (await call('GET', `/api/papers/${p.id}/story`)).json();
    expect(s.active.id).toBe(r1.id);
    expect(s.latest.id).toBe(r2.id);
    expect((await approveStory(p.id, r2)).statusCode).toBe(200);
    s = (await call('GET', `/api/papers/${p.id}/story`)).json();
    expect(s.active.id).toBe(r2.id);
    expect(s.revisions.find((x: { id: string }) => x.id === r1.id).status).toBe('SUPERSEDED');
  });

  test('saving a story on a stale parent is a 409; required fields are listed before approval', async () => {
    const p = await paper();
    const r1 = await storyRev(p.id, null);
    await storyRev(p.id, r1.id);
    expect((await call('POST', `/api/papers/${p.id}/story/revisions`, { parent_revision_id: r1.id, brief, story: story() })).statusCode).toBe(409);
    const incomplete = await call('POST', `/api/papers/${p.id}/story/revisions`, { parent_revision_id: null, brief, story: { ...story(), main_message: '' } });
    expect(incomplete.statusCode).toBe(409); // still stale parent (latest exists)
    const p2 = await paper();
    const empty = await storyRev(p2.id, null, { ...story(), main_message: '' });
    const res = await approveStory(p2.id, empty);
    expect(res.statusCode).toBe(422);
    expect(res.json().missing).toContain('story.main_message');
  });

  test('outline nodes can be approved selectively; the revision becomes active when every node is approved', async () => {
    const p = await paper();
    const s1 = await storyRev(p.id, null);
    await approveStory(p.id, s1);
    const n1 = node();
    const n2 = node({ paragraph_goal: 'Report survival difference', claim_ids: ['c-survival'], evidence_ids: ['ev-fig2'] });
    const o1 = await outlineRev(p.id, s1.id, null, [n1, n2]);
    const partial = await approveOutline(p.id, o1, [n1.node_id]);
    expect(partial.statusCode, partial.body).toBe(200);
    expect(partial.json().status).not.toBe('APPROVED');
    let o = (await call('GET', `/api/papers/${p.id}/outline/revisions/${o1.id}`)).json();
    expect(Object.fromEntries(o.nodes.map((n: { node_id: string; status: string }) => [n.node_id, n.status]))).toEqual({ [n1.node_id]: 'APPROVED', [n2.node_id]: 'DRAFT' });
    expect((await call('GET', `/api/papers/${p.id}`)).json().active_outline_revision_id).toBeNull();
    expect((await approveOutline(p.id, o1, [n2.node_id])).json().status).toBe('APPROVED');
    o = (await call('GET', `/api/papers/${p.id}/outline`)).json();
    expect(o.active.id).toBe(o1.id);
  });

  test('a node that needs evidence but has none cannot be approved', async () => {
    const p = await paper();
    const s1 = await storyRev(p.id, null);
    await approveStory(p.id, s1);
    const bare = node({ evidence_ids: [] });
    const o1 = await outlineRev(p.id, s1.id, null, [bare]);
    const res = await approveOutline(p.id, o1);
    expect(res.statusCode).toBe(422);
    expect(res.json().evidence_missing).toEqual([bare.node_id]);
  });

  test('an outline must be built on an approved story of the same paper', async () => {
    const p = await paper();
    const s1 = await storyRev(p.id, null);
    const res = await call('POST', `/api/papers/${p.id}/outline/revisions`, { parent_revision_id: null, story_revision_id: s1.id, nodes: [node()] });
    expect(res.statusCode).toBe(422);
    const other = await paper();
    const so = await storyRev(other.id, null);
    await approveStory(other.id, so);
    const cross = await call('POST', `/api/papers/${p.id}/outline/revisions`, { parent_revision_id: null, story_revision_id: so.id, nodes: [node()] });
    expect(cross.statusCode).toBe(404);
  });
});

describe('TST-010B: AI drafting is gated on the server; manual work is not', () => {
  test('draft requests are refused with a reason at every unapproved step, and accepted once everything is approved', async () => {
    const p = await paper();
    const n1 = node();
    let r = await draftRequest(p.id, null, n1.node_id);
    expect(r.statusCode).toBe(409);
    expect(r.json().reasons).toContain('story_not_approved');
    const s1 = await storyRev(p.id, null);
    await approveStory(p.id, s1);
    const o1 = await outlineRev(p.id, s1.id, null, [n1, node()]);
    r = await draftRequest(p.id, o1.id, n1.node_id);
    expect(r.json().reasons).toEqual(expect.arrayContaining(['outline_not_active', 'node_not_approved']));
    await approveOutline(p.id, o1, [n1.node_id]);
    r = await draftRequest(p.id, o1.id, n1.node_id);
    expect(r.json().reasons).toContain('outline_not_active');
    await approveOutline(p.id, o1);
    r = await draftRequest(p.id, o1.id, n1.node_id);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().gate).toBe('passed');
    expect((await draftRequest(p.id, o1.id, randomUUID())).json().reasons).toContain('node_not_found');
  });

  test('a newly approved story puts the existing outline under impact review', async () => {
    const p = await paper();
    const s1 = await storyRev(p.id, null);
    await approveStory(p.id, s1);
    const n1 = node();
    const o1 = await outlineRev(p.id, s1.id, null, [n1]);
    await approveOutline(p.id, o1);
    expect((await draftRequest(p.id, o1.id, n1.node_id)).statusCode).toBe(202);
    const s2 = await storyRev(p.id, s1.id, story('a different main message'));
    expect((await draftRequest(p.id, o1.id, n1.node_id)).statusCode).toBe(202); // draft story does not change anything yet
    await approveStory(p.id, s2);
    const r = await draftRequest(p.id, o1.id, n1.node_id);
    expect(r.statusCode).toBe(409);
    expect(r.json().reasons).toContain('impact_review_required');
    // the user re-bases the outline on the new story and approves it again
    const o2 = await outlineRev(p.id, s2.id, o1.id, [n1]);
    await approveOutline(p.id, o2);
    expect((await draftRequest(p.id, o2.id, n1.node_id)).statusCode).toBe(202);
  });

  test('manual notes and manuscript text can be saved with no story or outline at all', async () => {
    const p = await paper();
    for (const kind of ['notes', 'manuscript']) {
      const d = (await call('POST', `/api/papers/${p.id}/documents`, { kind })).json();
      const r = await call('POST', `/api/papers/${p.id}/documents/${d.document.id}/revisions`, { expected_head_revision_id: d.head.id, content_json: { type: 'doc', content: [] }, schema_version: 1, reason: 'manual' });
      expect(r.statusCode, kind).toBe(201);
    }
  });

  test('approved story/outline content cannot be changed or deleted, and statuses only move forward, even with direct SQL', async () => {
    const p = await paper();
    const s1 = await storyRev(p.id, null);
    await approveStory(p.id, s1);
    const o1 = await outlineRev(p.id, s1.id, null, [node()]);
    await approveOutline(p.id, o1);
    for (const [sql, params] of [
      [`UPDATE story_revisions SET story = '{"question":"changed"}' WHERE id = $1`, [s1.id]],
      [`UPDATE story_revisions SET status = 'DRAFT' WHERE id = $1`, [s1.id]],
      ['DELETE FROM story_revisions WHERE id = $1', [s1.id]],
      [`UPDATE outline_nodes SET paragraph_goal = 'rewritten' WHERE outline_revision_id = $1`, [o1.id]],
      ['DELETE FROM outline_node_approvals WHERE outline_revision_id = $1', [o1.id]],
      [`UPDATE outline_revisions SET status = 'DRAFT' WHERE id = $1`, [o1.id]],
    ] as const) {
      await expect(pool.query(sql, [...params]), sql).rejects.toThrow(/immutable|transition/);
    }
  });
});

describe('PW-010 hardening', () => {
  test('two concurrent story saves on the same parent cannot both win', async () => {
    const p = await paper();
    const r1 = await storyRev(p.id, null);
    const res = await Promise.all([1, 2].map(() => call('POST', `/api/papers/${p.id}/story/revisions`, { parent_revision_id: r1.id, brief, story: story() })));
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  test('malformed outlines are rejected with the field named', async () => {
    const p = await paper();
    const s1 = await storyRev(p.id, null);
    await approveStory(p.id, s1);
    const a = node();
    const b = node({ parent_node_id: a.node_id });
    for (const nodes of [[], [a, { ...a }], [{ ...a, parent_node_id: b.node_id }, b], [node({ role: 'novel' })], [node({ word_budget_min: 100, word_budget_max: 50 })], [node({ secret: 1 })]]) {
      const r = await call('POST', `/api/papers/${p.id}/outline/revisions`, { parent_revision_id: null, story_revision_id: s1.id, nodes });
      expect(r.statusCode, JSON.stringify(nodes).slice(0, 80)).toBe(422);
      expect(r.json().field).toMatch(/nodes/);
    }
    // a child listed before its parent is fine
    const ok = await call('POST', `/api/papers/${p.id}/outline/revisions`, { parent_revision_id: null, story_revision_id: s1.id, nodes: [b, a] });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().nodes.map((n: { node_id: string }) => n.node_id)).toEqual([b.node_id, a.node_id]);
  });

  test('the database refuses an active pointer to a revision that is not approved', async () => {
    const p = await paper();
    const s1 = await storyRev(p.id, null);
    await expect(pool.query('UPDATE paper_projects SET active_story_revision_id = $2 WHERE id = $1', [p.id, s1.id])).rejects.toThrow(/transition/);
    await expect(pool.query("UPDATE story_revisions SET status = 'APPROVED' WHERE id = $1", [s1.id])).rejects.toThrow(/transition|check/);
  });

  test('a named snapshot pins the active story and outline revisions', async () => {
    const p = await paper();
    const s1 = await storyRev(p.id, null);
    await approveStory(p.id, s1);
    const o1 = await outlineRev(p.id, s1.id, null, [node()]);
    await approveOutline(p.id, o1);
    const snap = (await call('POST', `/api/papers/${p.id}/snapshots`, { label: 'outline approved' })).json();
    const s2 = await storyRev(p.id, s1.id, story('changed later'));
    await approveStory(p.id, s2);
    const got = (await call('GET', `/api/papers/${p.id}/snapshots/${snap.id}`)).json();
    expect(got.story_revision_id).toBe(s1.id);
    expect(got.outline_revision_id).toBe(o1.id);
  });
});
