// PW-053 — faults injected into a Writer job (spec 08 "Durable job", "오류 종류별 동작"; spec 12 "장애 모드"):
// a worker process killed (SIGKILL) during the provider call and inside its commit, a full disk (the
// database's and the worker's), the document changed and an approval withdrawn while the job was down, and a
// cancel during a crash. Real processes and a temporary PostgreSQL; synthetic data; the MOCK writer.
// TST-053A: the job resumes from its checkpoint; an answer is kept only as a validated, stored proposal.
// TST-053B: recovery never overwrites a newer document, never reports a failed save as success, and never
//   revives a cancelled job.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { approveClaim, createClaim, createEvidence, createFactCandidates, linkClaimEvidence, reviewEvidence, reviewFact } from '../../../packages/domain/src/evidence/index.ts';
import { recoverJobs } from '../../../packages/domain/src/jobs/index.ts';
import { listCheckpoints, rehydrate } from '../../../packages/domain/src/checkpoints/index.ts';
import { processDelivery, type JobHandler } from '../../../apps/worker/src/queue/index.ts';
import { writerHandlers, createMockWriter, type Writer } from '../../../apps/worker/src/writer/index.ts';
import { reconcileInflight } from '../../../apps/worker/src/recovery/index.ts';
import { withAdmission } from '../../../apps/worker/src/admission/index.ts';
import { withQuotaWaits } from '../../../apps/worker/src/quota-scheduler/index.ts';
import { withCircuitBreaker, withErrorHandling } from '../../../apps/worker/src/errors/index.ts';
import { diskFullOn, holdInsertsOn, untilReleased, waitForHold, writerChild } from '../../faults/inject.ts';

const ORIGIN = 'http://127.0.0.1:5173';
const LEASE_MS = 1000; // the shortest lease (MIN_LEASE_MS)
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
let H: Record<string, string>;
let ownerId: string;
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 10 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  ownerId = (await createOwner(pool, { username: 'alice', password: 'correct horse battery' })).id;
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: 'alice', password: 'correct horse battery' } });
  H = { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken, origin: ORIGIN };
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});

const call = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, headers: H, payload: payload as object | undefined });
const docOf = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text }] }] });

// a paper with an approved story, a verified fact, an approved claim and an approved one-plan outline; a
// manuscript; a draft request for that plan (its job, not yet run)
async function world() {
  const p = (await call('POST', '/api/papers', { working_title: 'fault paper', article_type: 'research_article' })).json();
  const s = (await call('POST', `/api/papers/${p.id}/story/revisions`, { parent_revision_id: null, brief: { purpose: 'Show the result', audience: 'x', known_facts: [], missing_material: [], avoid_claims: [] }, story: { question: 'q', main_message: 'm', novelty: 'n', evidence_links: [], competing_explanations: [], presentation_order: [], limitations: [] } })).json();
  await call('POST', `/api/papers/${p.id}/story/revisions/${s.id}/approve`, { intent: 'approve_story', content_hash: s.content_hash });
  const e = await createEvidence(pool, { paperId: p.id, ownerId, body: { kind: 'experiment', locator: { note: 'run 1' }, label: 'qPCR' } });
  await reviewEvidence(pool, { paperId: p.id, ownerId, id: e.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: e.content_hash } });
  const [f] = await createFactCandidates(pool, { paperId: p.id, ownerId, origin: 'user', single: true, facts: [{ evidence_id: e.id, entity: 'ABC1 roots', metric: 'fold change', value_text: '2.4', unit: 'fold', group: 'drought', comparison: 'control', n: 3, extraction_method: 'manual_entry' }] });
  await reviewFact(pool, { paperId: p.id, ownerId, id: f!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: f!.content_hash } });
  const c = await createClaim(pool, { paperId: p.id, ownerId, body: { kind: 'observation', text: 'ABC1 rises in roots under drought.' } });
  await linkClaimEvidence(pool, { paperId: p.id, ownerId, claimId: c.id, body: { evidence_id: e.id, relation: 'supports' } });
  await approveClaim(pool, { paperId: p.id, ownerId, id: c.id, body: { intent: 'approve_claim', content_hash: c.content_hash } });
  const nodeId = randomUUID();
  const nodes = [{ node_id: nodeId, parent_node_id: null, section: 'Results', role: 'result', paragraph_goal: 'Root induction under drought', claim_ids: [c.id], evidence_ids: [e.id], requires_evidence: false, allowed_interpretation: '', exclusions: [], transition: '', word_budget_min: null, word_budget_max: null }];
  const o = (await call('POST', `/api/papers/${p.id}/outline/revisions`, { parent_revision_id: null, story_revision_id: s.id, nodes })).json();
  await call('POST', `/api/papers/${p.id}/outline/revisions/${o.id}/approve`, { intent: 'approve_outline', content_hash: o.content_hash });
  const d = (await call('POST', `/api/papers/${p.id}/documents`, { kind: 'manuscript' })).json();
  const r = await call('POST', `/api/papers/${p.id}/writer/requests`, { mode: 'draft', outline_revision_id: o.id, node_id: nodeId, document_id: d.document.id, base_revision_id: d.head.id, idempotency_key: randomUUID() });
  expect(r.statusCode, r.body).toBe(201);
  return { paperId: p.id as string, storyId: s.id as string, outline: o as { id: string }, nodes, documentId: d.document.id as string, headId: d.head.id as string, jobId: r.json().job.id as string };
}
type W = Awaited<ReturnType<typeof world>>;

const job = async (w: W) => (await pool.query('SELECT status, attempts, fencing_token::int AS token, last_error, result FROM jobs WHERE id = $1', [w.jobId])).rows[0] as { status: string; attempts: number; token: number; last_error: string | null; result: unknown };
const proposals = async (w: W) => (await pool.query('SELECT id, status FROM paragraph_proposals WHERE job_id = $1', [w.jobId])).rows as { id: string; status: string }[];
const head = async (w: W) => (await pool.query('SELECT head_revision_id FROM documents WHERE id = $1', [w.documentId])).rows[0].head_revision_id as string;
const counting = (calls: { n: number }, inner: Writer = createMockWriter()): Writer => ({ ...inner, async write(c) { calls.n++; return inner.write(c); } });
// the worker's composition (apps/worker/src/main.ts)
const asInMain = (writer: Writer): Record<string, JobHandler> => {
  const o = { provider: 'mock', authProfileId: 'none' };
  return withCircuitBreaker(pool, withAdmission(pool, withQuotaWaits(pool, withErrorHandling(pool, writerHandlers(pool, writer), o)), { provider: 'mock', authMode: 'none', estimateUsd: () => null }), o);
};
const deliver = (w: W, handlers: Record<string, JobHandler>) => processDelivery(pool, { job_id: w.jobId, paper_id: w.paperId, intent: 'draft_paragraph' }, { workerId: 'w-recover', leaseMs: 60_000, handlers });
// waits until the dead worker's lease has run out, then runs the recovery sweep (as the local worker does)
async function afterLeaseExpiry(w: W) {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query('SELECT lease_expires_at < clock_timestamp() AS expired FROM jobs WHERE id = $1', [w.jobId]);
    if (rows[0].expired !== false) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return reconcileInflight(pool, { redispatchAfterMs: 0 });
}
describe('TST-053A: the job resumes from its checkpoint; an answer is kept only as a stored, validated proposal', () => {
  test('a worker killed during the provider call: the job is recovered and the new run resumes from the checkpoint; one proposal', async () => {
    const w = await world();
    const child = writerChild({ dbUrl: db.url, paperId: w.paperId, jobId: w.jobId, mode: 'hang_in_call', leaseMs: LEASE_MS });
    await child.waitFor('IN_CALL');
    await child.kill();
    // the dead run left only its checkpoint before the call
    expect(await job(w)).toMatchObject({ status: 'RUNNING', token: 1 });
    expect(await proposals(w)).toEqual([]);
    expect((await listCheckpoints(pool, w.paperId, w.jobId)).map((c) => [c.boundary, c.fencing_token])).toEqual([['before_call', 1]]);

    await afterLeaseExpiry(w);
    expect(await job(w)).toMatchObject({ status: 'QUEUED' });
    const r = await rehydrate(pool, w.paperId, w.jobId);
    expect(r).toMatchObject({ resumable: true, drift: [], pending_step: 'provider_call', completed_actions: [] });

    const calls = { n: 0 };
    expect((await deliver(w, asInMain(counting(calls)))).outcome).toBe('completed');
    expect(calls.n).toBe(1);
    const stored = await proposals(w);
    expect(stored).toEqual([{ id: expect.any(String), status: 'PENDING' }]);
    const cps = await listCheckpoints(pool, w.paperId, w.jobId);
    expect(cps.at(-1)).toMatchObject({ boundary: 'after_proposal', fencing_token: 2 });
    expect(cps.at(-1)!.state.completed_actions).toEqual([`proposal_stored:${stored[0]!.id}`]);
    // nothing the dead run did counts as done
    expect(cps.filter((c) => c.fencing_token === 1).every((c) => c.state.completed_actions.length === 0)).toBe(true);
    expect(await job(w)).toMatchObject({ status: 'SUCCEEDED', token: 2 });
  });

  test('a worker killed inside the commit that stores the validated answer: nothing is half-stored; a later run stores one proposal', async () => {
    const w = await world();
    const release = await holdInsertsOn(pool, 'paragraph_proposals', 2);
    try {
      const child = writerChild({ dbUrl: db.url, paperId: w.paperId, jobId: w.jobId, mode: 'normal', leaseMs: LEASE_MS });
      await waitForHold(pool);
      await child.kill();
      expect(child.lines.some((l) => l.startsWith('DONE'))).toBe(false);
      await untilReleased(pool);
    } finally {
      await release();
    }
    // the answer was validated (its checkpoint committed on its own), but its proposal and the job's success
    // were one transaction that never committed
    expect(await proposals(w)).toEqual([]);
    expect(await job(w)).toMatchObject({ status: 'RUNNING', result: null });
    const before = await listCheckpoints(pool, w.paperId, w.jobId);
    expect(before.map((c) => c.boundary)).toEqual(['before_call', 'after_validation']);
    expect(before.every((c) => c.state.completed_actions.length === 0)).toBe(true);

    await afterLeaseExpiry(w);
    expect(await rehydrate(pool, w.paperId, w.jobId)).toMatchObject({ resumable: true, pending_step: 'store_proposal', completed_actions: [] });
    // the lost answer is made again (at least once; spec 08 does not promise one provider call) and stored once
    const calls = { n: 0 };
    expect((await deliver(w, asInMain(counting(calls)))).outcome).toBe('completed');
    expect(calls.n).toBe(1);
    expect(await proposals(w)).toHaveLength(1);
    // a late copy of the old message changes nothing
    expect((await deliver(w, asInMain(counting(calls)))).outcome).toBe('duplicate');
    expect(await proposals(w)).toHaveLength(1);
  });
});

describe('TST-053B: no overwrite of a newer document, no failed save shown as success, no revived cancel', () => {
  test('the owner edits the manuscript while the job is down: the recovered proposal never overwrites the newer text', async () => {
    const w = await world();
    const child = writerChild({ dbUrl: db.url, paperId: w.paperId, jobId: w.jobId, mode: 'hang_in_call', leaseMs: LEASE_MS });
    await child.waitFor('IN_CALL');
    await child.kill();
    const OWNER = 'The owner wrote this while the job was down.';
    const saved = await call('POST', `/api/papers/${w.paperId}/documents/${w.documentId}/saves`, { schema_version: 1, reason: 'autosave', expected_head_revision_id: w.headId, content_json: docOf(OWNER) });
    expect(saved.statusCode, saved.body).toBe(201);
    await afterLeaseExpiry(w);
    expect((await deliver(w, asInMain(createMockWriter()))).outcome).toBe('completed');
    const [p] = await proposals(w);
    expect(p).toBeDefined();
    const row = (await pool.query('SELECT proposal_hash, base_revision_id FROM paragraph_proposals WHERE id = $1', [p!.id])).rows[0];
    // the proposal was made for the revision the request named, not the owner's newer one
    expect(row.base_revision_id).toBe(w.headId);
    const applied = await call('POST', `/api/papers/${w.paperId}/writer/proposals/${p!.id}/apply`, { intent: 'apply_paragraph', proposal_hash: row.proposal_hash, expected_revision_id: row.base_revision_id });
    const now = (await pool.query('SELECT r.parent_revision_id, r.content_json FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.id = $1', [w.documentId])).rows[0];
    // the paragraph's place (the end of its section) still holds, so it is added onto the owner's revision —
    // never a rebase of the old base over it: the owner's text stays, and the parent is the owner's save
    expect(applied.statusCode, applied.body).toBe(200);
    expect(now.parent_revision_id).toBe(saved.json().id);
    expect(JSON.stringify(now.content_json)).toContain(OWNER);
  });

  test('the owner edits the paragraph the draft goes after, during the provider call: the answer is stored STALE, the edit stays', async () => {
    const w0 = await world();
    const P = randomUUID();
    const content = (t: string) => ({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: P }, content: [{ type: 'text', text: t }] }] });
    const s1 = await call('POST', `/api/papers/${w0.paperId}/documents/${w0.documentId}/saves`, { schema_version: 1, reason: 'autosave', expected_head_revision_id: w0.headId, content_json: content('First owner paragraph.') });
    expect(s1.statusCode, s1.body).toBe(201);
    const r = await call('POST', `/api/papers/${w0.paperId}/writer/requests`, { mode: 'draft', outline_revision_id: w0.outline.id, node_id: w0.nodes[0]!.node_id, document_id: w0.documentId, base_revision_id: s1.json().id, after_block_id: P, idempotency_key: randomUUID() });
    expect(r.statusCode, r.body).toBe(201);
    const w = { ...w0, jobId: r.json().job.id as string, headId: s1.json().id as string };
    let edited = '';
    const mock = createMockWriter();
    const editing: Writer = { ...mock, async write(c) {
      const s2 = await call('POST', `/api/papers/${w.paperId}/documents/${w.documentId}/saves`, { schema_version: 1, reason: 'autosave', expected_head_revision_id: w.headId, content_json: content('The owner rewrote this paragraph meanwhile.') });
      edited = s2.json().id;
      return mock.write(c);
    } };
    expect((await deliver(w, asInMain(editing))).outcome).toBe('completed');
    const [p] = (await pool.query('SELECT id, status, status_reason, proposal_hash FROM paragraph_proposals WHERE job_id = $1', [w.jobId])).rows;
    expect(p).toMatchObject({ status: 'STALE', status_reason: expect.stringMatching(/manuscript changed/) });
    const applied = await call('POST', `/api/papers/${w.paperId}/writer/proposals/${p.id}/apply`, { intent: 'apply_paragraph', proposal_hash: p.proposal_hash, expected_revision_id: w.headId });
    expect(applied.statusCode, applied.body).toBe(409);
    expect(await head(w)).toBe(edited);
  });

  test('the database is full when the proposal is stored: the job stops (not retried, no new model call) and nothing is reported as done', async () => {
    const w = await world();
    const calls = { n: 0 };
    const release = await diskFullOn(pool, 'paragraph_proposals');
    try {
      const out = await deliver(w, asInMain(counting(calls)));
      expect(out.outcome).toBe('failed');
      // spec 08: disk full → a safe stop with the owner told the result was not stored; a retry would call
      // the provider again for an answer it cannot store
      const j = await job(w);
      expect(j).toMatchObject({ status: 'FAILED', result: null });
      expect(j.last_error).toMatch(/disk is full/i);
      expect(j.last_error).toMatch(/not stored|nothing was half-stored/i);
      expect((await deliver(w, asInMain(counting(calls)))).outcome).toBe('skipped');
    } finally {
      await release();
    }
    expect(calls.n).toBe(1);
    expect(await proposals(w)).toEqual([]);
    expect((await listCheckpoints(pool, w.paperId, w.jobId)).map((c) => c.boundary)).not.toContain('after_proposal');
  });

  test('the database is full when the checkpoint before the call is written: the provider is not called', async () => {
    const w = await world();
    const calls = { n: 0 };
    const release = await diskFullOn(pool, 'job_checkpoints');
    try {
      expect((await deliver(w, asInMain(counting(calls)))).outcome).toBe('failed');
    } finally {
      await release();
    }
    expect(calls.n).toBe(0);
    expect(await job(w)).toMatchObject({ status: 'FAILED' });
    expect((await job(w)).last_error).toMatch(/disk is full/i);
    expect(await proposals(w)).toEqual([]);
  });

  test('the worker\'s own disk is full (ENOSPC): the job stops safely, nothing stored', async () => {
    const w = await world();
    const full: Writer = { ...createMockWriter(), async write() { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); } };
    expect((await deliver(w, asInMain(full))).outcome).toBe('failed');
    expect(await job(w)).toMatchObject({ status: 'FAILED' });
    expect((await job(w)).last_error).toMatch(/disk is full/i);
    expect(await proposals(w)).toEqual([]);
  });

  test('a manuscript save on a full database is refused, never acknowledged; the head stays', async () => {
    const w = await world();
    const release = await diskFullOn(pool, 'document_revisions');
    let r;
    try {
      r = await call('POST', `/api/papers/${w.paperId}/documents/${w.documentId}/saves`, { schema_version: 1, reason: 'autosave', expected_head_revision_id: w.headId, content_json: docOf('must not look saved') });
    } finally {
      await release();
    }
    expect(r.statusCode).toBeGreaterThanOrEqual(500);
    expect(r.json()).toEqual({ error: 'internal' });
    expect(await head(w)).toBe(w.headId);
    expect((await pool.query('SELECT count(*)::int AS n FROM document_revisions WHERE document_id = $1', [w.documentId])).rows[0].n).toBe(1);
    // once space is back the same save is stored
    const again = await call('POST', `/api/papers/${w.paperId}/documents/${w.documentId}/saves`, { schema_version: 1, reason: 'autosave', expected_head_revision_id: w.headId, content_json: docOf('must not look saved') });
    expect(again.statusCode, again.body).toBe(201);
  });

  test('a job cancelled while its worker was crashing is not revived by recovery, redelivery or a later sweep', async () => {
    const w = await world();
    const child = writerChild({ dbUrl: db.url, paperId: w.paperId, jobId: w.jobId, mode: 'hang_in_call', leaseMs: LEASE_MS });
    await child.waitFor('IN_CALL');
    expect((await call('POST', `/api/papers/${w.paperId}/jobs/${w.jobId}/cancel`)).statusCode).toBe(200);
    await child.kill();
    await afterLeaseExpiry(w);
    await recoverJobs(pool, { redispatchAfterMs: 0 });
    const calls = { n: 0 };
    expect((await deliver(w, asInMain(counting(calls)))).outcome).toBe('skipped');
    await reconcileInflight(pool, { redispatchAfterMs: 0 });
    expect(await job(w)).toMatchObject({ status: 'CANCELLED', token: 1 });
    expect(calls.n).toBe(0);
    expect(await proposals(w)).toEqual([]);
    expect((await rehydrate(pool, w.paperId, w.jobId)).reasons).toContain('job_cancelled');
    expect((await listCheckpoints(pool, w.paperId, w.jobId)).every((c) => c.fencing_token === 1)).toBe(true);
  });

  test('a cancel that arrives while the worker is inside its commit, then the worker dies: cancelled, nothing stored', async () => {
    const w = await world();
    const release = await holdInsertsOn(pool, 'paragraph_proposals', 2);
    let cancelled;
    try {
      const child = writerChild({ dbUrl: db.url, paperId: w.paperId, jobId: w.jobId, mode: 'normal', leaseMs: LEASE_MS });
      await waitForHold(pool);
      cancelled = call('POST', `/api/papers/${w.paperId}/jobs/${w.jobId}/cancel`);
      await child.kill();
      await untilReleased(pool);
    } finally {
      await release();
    }
    expect((await cancelled).statusCode).toBe(200);
    await afterLeaseExpiry(w);
    expect(await job(w)).toMatchObject({ status: 'CANCELLED' });
    expect(await proposals(w)).toEqual([]);
  });

  test('the outline approval is replaced while the job is down: the resumed run stops and proposes nothing', async () => {
    const w = await world();
    const child = writerChild({ dbUrl: db.url, paperId: w.paperId, jobId: w.jobId, mode: 'hang_in_call', leaseMs: LEASE_MS });
    await child.waitFor('IN_CALL');
    await child.kill();
    const o2 = (await call('POST', `/api/papers/${w.paperId}/outline/revisions`, { parent_revision_id: w.outline.id, story_revision_id: w.storyId, nodes: w.nodes.map((n) => ({ ...n, paragraph_goal: 'A changed plan' })) })).json();
    expect((await call('POST', `/api/papers/${w.paperId}/outline/revisions/${o2.id}/approve`, { intent: 'approve_outline', content_hash: o2.content_hash })).statusCode).toBe(200);
    await afterLeaseExpiry(w);
    expect((await rehydrate(pool, w.paperId, w.jobId)).resumable).toBe(false);
    const calls = { n: 0 };
    expect((await deliver(w, asInMain(counting(calls)))).outcome).toBe('failed');
    expect(calls.n).toBe(0);
    expect((await job(w)).status).toMatch(/^(FAILED|WAITING_USER)$/);
    expect(await proposals(w)).toEqual([]);
  });

  test('the outline approval is replaced during the provider call: the answer is stored STALE and cannot be applied', async () => {
    const w = await world();
    const mock = createMockWriter();
    const replacing: Writer = { ...mock, async write(c) {
      const o2 = (await call('POST', `/api/papers/${w.paperId}/outline/revisions`, { parent_revision_id: w.outline.id, story_revision_id: w.storyId, nodes: w.nodes.map((n) => ({ ...n, paragraph_goal: 'A changed plan' })) })).json();
      await call('POST', `/api/papers/${w.paperId}/outline/revisions/${o2.id}/approve`, { intent: 'approve_outline', content_hash: o2.content_hash });
      return mock.write(c);
    } };
    expect((await deliver(w, asInMain(replacing))).outcome).toBe('completed');
    const [p] = (await pool.query('SELECT id, status, status_reason, proposal_hash FROM paragraph_proposals WHERE job_id = $1', [w.jobId])).rows;
    expect(p).toMatchObject({ status: 'STALE', status_reason: expect.stringMatching(/plan changed.*outline_not_active/) });
    const applied = await call('POST', `/api/papers/${w.paperId}/writer/proposals/${p.id}/apply`, { intent: 'apply_paragraph', proposal_hash: p.proposal_hash, expected_revision_id: w.headId });
    expect(applied.statusCode, applied.body).toBe(409);
    expect(await head(w)).toBe(w.headId);
  });
});
