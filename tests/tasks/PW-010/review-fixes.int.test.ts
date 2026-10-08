// PW-010 — regression tests for the independent review (A-M1..M3, A-m1, A-m3, A-m5) and PW-009 B-m1
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

const brief = { purpose: 'Test whether ABC1 responds to drought' };
const story = (msg = 'ABC1 is drought-induced') => ({ question: 'Does ABC1 respond to drought?', main_message: msg });
const node = (over: Record<string, unknown> = {}) => ({ node_id: randomUUID(), section: 'Results', role: 'result', paragraph_goal: 'Report induction', evidence_ids: ['ev-1'], requires_evidence: true, ...over });

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
const paper = async () => (await call('POST', '/api/papers', { working_title: 'p', article_type: 'research_article' })).json();
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
const gate = (paperId: string, outlineId: string, nodeId: string) => call('POST', `/api/papers/${paperId}/ai/draft-requests`, { outline_revision_id: outlineId, node_id: nodeId, instruction: 'write' });

async function approvedSetup() {
  const p = await paper();
  const s1 = await storyRev(p.id, null);
  await approveStory(p.id, s1);
  const n1 = node();
  const o1 = await outlineRev(p.id, s1.id, null, [n1]);
  expect((await approveOutline(p.id, o1)).statusCode).toBe(200);
  return { p, s1, o1, n1 };
}

describe('A-M1: an active pointer can never name a revision that is not approved', () => {
  test('superseding the active story or outline behind the pointer is refused at commit', async () => {
    const { p, s1, o1, n1 } = await approvedSetup();
    await expect(pool.query("UPDATE story_revisions SET status = 'SUPERSEDED', superseded_at = now() WHERE id = $1", [s1.id])).rejects.toThrow(/active/);
    await expect(pool.query("UPDATE outline_revisions SET status = 'SUPERSEDED', superseded_at = now() WHERE id = $1", [o1.id])).rejects.toThrow(/active/);
    expect((await gate(p.id, o1.id, n1.node_id)).statusCode).toBe(202);
  });
});

describe('A-M2: an approved outline cannot gain nodes or approvals', () => {
  test('a node or an approval added later by direct SQL is refused', async () => {
    const { p, o1, n1 } = await approvedSetup();
    const extra = randomUUID();
    await expect(pool.query(
      "INSERT INTO outline_nodes (outline_revision_id, paper_id, node_id, position, section, role, paragraph_goal) VALUES ($1, $2, $3, 99, 'Results', 'result', 'never reviewed')",
      [o1.id, p.id, extra],
    )).rejects.toThrow(/immutable/);
    // an approval row may only carry the hash of the revision it approves
    const p2 = await paper();
    const s = await storyRev(p2.id, null);
    await approveStory(p2.id, s);
    const n = node();
    const o = await outlineRev(p2.id, s.id, null, [n]);
    await expect(pool.query(
      "INSERT INTO outline_node_approvals (outline_revision_id, paper_id, node_id, content_hash, approved_by) SELECT $1, $2, $3, repeat('f', 64), owner_id FROM paper_projects WHERE id = $2",
      [o.id, p2.id, n.node_id],
    )).rejects.toThrow(/foreign key/);
    // approvals on an already approved outline are refused
    await expect(pool.query(
      'INSERT INTO outline_node_approvals (outline_revision_id, paper_id, node_id, content_hash, approved_by) SELECT $1, $2, $3, $4, owner_id FROM paper_projects WHERE id = $2',
      [o1.id, p.id, n1.node_id, o1.content_hash],
    )).rejects.toThrow(/duplicate|immutable/);
  });
});

describe('A-M3: text PostgreSQL cannot store is a 422, never a 500 or a silent change', () => {
  test('lone surrogates in story, brief and outline text', async () => {
    const p = await paper();
    for (const s of [{ ...story(), question: 'a\uD800b' }, { ...story(), presentation_order: ['x\uDC00'] }]) {
      const r = await call('POST', `/api/papers/${p.id}/story/revisions`, { parent_revision_id: null, brief, story: s });
      expect(r.statusCode, JSON.stringify(s)).toBe(422);
    }
    const s1 = await storyRev(p.id, null);
    await approveStory(p.id, s1);
    const r = await call('POST', `/api/papers/${p.id}/outline/revisions`, { parent_revision_id: null, story_revision_id: s1.id, nodes: [node({ paragraph_goal: 'g\uD800x' })] });
    expect(r.statusCode).toBe(422);
  });
});

describe('A-m1: the database only accepts revisions that start as drafts with consistent approval columns', () => {
  test('direct inserts as APPROVED/SUPERSEDED and inconsistent transitions are refused', async () => {
    const p = await paper();
    const owner = (await pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [p.id])).rows[0].owner_id;
    for (const status of ['APPROVED', 'SUPERSEDED']) {
      await expect(pool.query(
        "INSERT INTO story_revisions (paper_id, brief, story, content_hash, status, created_by, approved_by, approved_at, superseded_at) VALUES ($1, '{}', '{}', repeat('0', 64), $2, $3, $3, now(), CASE WHEN $2 = 'SUPERSEDED' THEN now() END)",
        [p.id, status, owner],
      ), status).rejects.toThrow(/draft|transition/i);
    }
    const s1 = await storyRev(p.id, null);
    await expect(pool.query("UPDATE story_revisions SET status = 'IN_REVIEW', approved_by = created_by, superseded_at = now() WHERE id = $1", [s1.id])).rejects.toThrow(/transition|check/);
  });
});

describe('A-m3/A-m5: id case, older revisions, idempotency, other papers', () => {
  test('an upper-case parent id is the same revision', async () => {
    const p = await paper();
    const s1 = await storyRev(p.id, null);
    const r = await call('POST', `/api/papers/${p.id}/story/revisions`, { parent_revision_id: s1.id.toUpperCase(), brief, story: story('v2') });
    expect(r.statusCode, r.body).toBe(201);
  });

  test('an older story or outline revision cannot be approved after a newer one; re-approval is idempotent', async () => {
    const p = await paper();
    const s1 = await storyRev(p.id, null);
    const s2 = await storyRev(p.id, s1.id, story('v2'));
    expect((await approveStory(p.id, s2)).statusCode).toBe(200);
    expect((await approveStory(p.id, s1)).statusCode).toBe(409);
    const again = await approveStory(p.id, s2);
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('APPROVED');
    const n = node();
    const o1 = await outlineRev(p.id, s2.id, null, [n]);
    const o2 = await outlineRev(p.id, s2.id, o1.id, [n, node()]);
    expect((await approveOutline(p.id, o2)).statusCode).toBe(200);
    expect((await approveOutline(p.id, o1)).statusCode).toBe(409);
    expect((await approveOutline(p.id, o2)).json().status).toBe('APPROVED');
  });

  test("the gate refuses another paper's active outline", async () => {
    const a = await approvedSetup();
    const b = await approvedSetup();
    const r = await gate(a.p.id, b.o1.id, b.n1.node_id);
    expect(r.statusCode).toBe(409);
    expect(r.json().reasons).toContain('outline_not_active');
  });
});

describe('PW-009 B-m1: a snapshot cannot be opened again by forging created_xid', () => {
  test('created_xid is always the inserting transaction', async () => {
    const p = await paper();
    const { rows } = await pool.query(
      "INSERT INTO paper_snapshots (paper_id, label, created_by, created_xid) SELECT id, 'forged', owner_id, ((pg_current_xact_id()::text::bigint + 5)::text)::xid8 FROM paper_projects WHERE id = $1 RETURNING created_xid::text AS x, pg_current_xact_id()::text AS cur",
      [p.id],
    );
    expect(rows[0].x).toBe(rows[0].cur);
  });
});

describe('re-review m1–m4', () => {
  test('m4: a blank evidence or claim id is not evidence', async () => {
    const p = await paper();
    const s1 = await storyRev(p.id, null);
    await approveStory(p.id, s1);
    for (const over of [{ evidence_ids: [''] }, { evidence_ids: ['  '] }, { claim_ids: [''] }]) {
      const r = await call('POST', `/api/papers/${p.id}/outline/revisions`, { parent_revision_id: null, story_revision_id: s1.id, nodes: [node(over)] });
      expect(r.statusCode, JSON.stringify(over)).toBe(422);
    }
    const o = await outlineRev(p.id, s1.id, null, [node()]);
    await expect(pool.query(
      "INSERT INTO outline_nodes (outline_revision_id, paper_id, node_id, position, section, role, paragraph_goal, evidence_ids, requires_evidence) VALUES ($1, $2, $3, 5, 'R', 'result', 'g', ARRAY[' '], true)",
      [o.id, p.id, randomUUID()],
    )).rejects.toThrow(/check|immutable/);
  });

  test('m3: a gate call that waits behind an approval sees the approved outline', async () => {
    const p = await paper();
    const s1 = await storyRev(p.id, null);
    await approveStory(p.id, s1);
    const n1 = node();
    const o1 = await outlineRev(p.id, s1.id, null, [n1]);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT 1 FROM paper_projects WHERE id = $1 FOR UPDATE', [p.id]);
      await c.query('INSERT INTO outline_node_approvals (outline_revision_id, paper_id, node_id, content_hash, approved_by) SELECT $1, $2, $3, $4, owner_id FROM paper_projects WHERE id = $2', [o1.id, p.id, n1.node_id, o1.content_hash]);
      await c.query("UPDATE outline_revisions SET status = 'APPROVED', approved_by = created_by, approved_at = now() WHERE id = $1", [o1.id]);
      await c.query('UPDATE paper_projects SET active_outline_revision_id = $2 WHERE id = $1', [p.id, o1.id]);
      const pending = gate(p.id, o1.id, n1.node_id);
      await new Promise((r) => setTimeout(r, 300));
      await c.query('COMMIT');
      const r = await pending;
      expect(r.statusCode, r.body).toBe(202);
    } finally {
      c.release();
    }
  });

  test('m1: two sessions cannot leave the active pointer on a superseded revision', async () => {
    const p = await paper();
    const s1 = await storyRev(p.id, null);
    await approveStory(p.id, s1);
    await pool.query('UPDATE paper_projects SET active_story_revision_id = NULL WHERE id = $1', [p.id]);
    const t1 = await pool.connect();
    const t2 = await pool.connect();
    try {
      await t1.query('BEGIN');
      await t1.query("UPDATE story_revisions SET status = 'SUPERSEDED', superseded_at = now() WHERE id = $1", [s1.id]);
      await t1.query('SET CONSTRAINTS ALL IMMEDIATE');
      await t2.query('BEGIN');
      await t2.query('UPDATE paper_projects SET active_story_revision_id = $2 WHERE id = $1', [p.id, s1.id]).catch(() => {});
      const commit2 = t2.query('COMMIT').then(() => 'committed', (e: Error) => e.message);
      await new Promise((r) => setTimeout(r, 300));
      await t1.query('COMMIT');
      expect(await commit2).toMatch(/not approved|active/);
      const { rows } = await pool.query('SELECT active_story_revision_id FROM paper_projects WHERE id = $1', [p.id]);
      expect(rows[0].active_story_revision_id).toBeNull();
    } finally {
      await t2.query('ROLLBACK').catch(() => {});
      t1.release();
      t2.release();
    }
  });

  test('m2: a commit-time rule violation is a 409, not a 500', async () => {
    const { inTransaction } = await import('../../../packages/domain/src/shared/db.ts');
    const p = await paper();
    const s1 = await storyRev(p.id, null);
    await approveStory(p.id, s1);
    const err = await inTransaction(pool, async (tx) => {
      await tx.query("UPDATE story_revisions SET status = 'SUPERSEDED', superseded_at = now() WHERE id = $1", [s1.id]);
    }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('CONFLICT');
  });
});
