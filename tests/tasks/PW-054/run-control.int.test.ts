// PW-054 — a run's control state as the server stores it (spec 08 "웹 상태"): the job's status and reason,
// the last checkpoint, the provider, the measured/estimated/unknown context, the quota waits with a known
// or unknown reset, the auto-resume permission, the last classified error, and what the owner may do (stop,
// resume, allow auto-resume). Resume is the owner's act and only queues the job again: what it makes is a
// proposal; applying it to the manuscript stays the owner's act.
// TST-054A: while an AI job waits, the manuscript can be edited and the material read; the state shown is the
//   database's.
// TST-054B: unknown usage is never 0 or a precise percentage; an auto-resumed run never applies anything.
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
import { processDelivery, type JobHandler } from '../../../apps/worker/src/queue/index.ts';
import { writerHandlers, createMockWriter, type Writer } from '../../../apps/worker/src/writer/index.ts';
import { withAdmission } from '../../../apps/worker/src/admission/index.ts';
import { wakeDueWaits, withQuotaWaits } from '../../../apps/worker/src/quota-scheduler/index.ts';
import { withCircuitBreaker, withErrorHandling } from '../../../apps/worker/src/errors/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
const H: Record<string, Record<string, string>> = {};
let ownerId: string;
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  for (const u of ['alice', 'bob']) {
    const o = await createOwner(pool, { username: u, password: 'correct horse battery' });
    if (u === 'alice') ownerId = o.id;
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
const docOf = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text }] }] });

async function world() {
  const p = (await call('POST', '/api/papers', { working_title: 'control paper', article_type: 'research_article' })).json();
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
  const o = (await call('POST', `/api/papers/${p.id}/outline/revisions`, { parent_revision_id: null, story_revision_id: s.id, nodes: [{ node_id: nodeId, parent_node_id: null, section: 'Results', role: 'result', paragraph_goal: 'Root induction under drought', claim_ids: [c.id], evidence_ids: [e.id], requires_evidence: false, allowed_interpretation: '', exclusions: [], transition: '', word_budget_min: null, word_budget_max: null }] })).json();
  await call('POST', `/api/papers/${p.id}/outline/revisions/${o.id}/approve`, { intent: 'approve_outline', content_hash: o.content_hash });
  const d = (await call('POST', `/api/papers/${p.id}/documents`, { kind: 'manuscript' })).json();
  const r = await call('POST', `/api/papers/${p.id}/writer/requests`, { mode: 'draft', outline_revision_id: o.id, node_id: nodeId, document_id: d.document.id, base_revision_id: d.head.id, idempotency_key: randomUUID() });
  expect(r.statusCode, r.body).toBe(201);
  return { paperId: p.id as string, documentId: d.document.id as string, headId: d.head.id as string, jobId: r.json().job.id as string };
}
type W = Awaited<ReturnType<typeof world>>;

let profile = 0;
// the worker's composition (apps/worker/src/main.ts) around the Writer, with its own provider login
const asInMain = (writer: Writer, authProfileId: string): Record<string, JobHandler> => {
  const o = { provider: 'claude_agent', authProfileId };
  return withCircuitBreaker(pool, withAdmission(pool, withQuotaWaits(pool, withErrorHandling(pool, writerHandlers(pool, writer), o), { jitterMs: () => 0 }), { provider: 'mock', authMode: 'none', estimateUsd: () => null }), o);
};
const deliver = (w: W, handlers: Record<string, JobHandler>) => processDelivery(pool, { job_id: w.jobId, paper_id: w.paperId, intent: 'draft_paragraph' }, { workerId: 'w', leaseMs: 60_000, handlers });
const limited: Writer = { ...createMockWriter(), async write() { throw Object.assign(new Error('Claude AI usage limit reached'), { status: 429, error: { type: 'rate_limit_error' } }); } };
// a job waiting for its quota, with no reset time known
async function waiting() {
  const w = await world();
  const auth = `ctl-${++profile}`;
  await deliver(w, asInMain(limited, auth));
  expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [w.jobId])).rows[0].status).toBe('WAITING_QUOTA');
  return { ...w, auth };
}
const control = (w: W, who = 'alice') => call('GET', `/api/papers/${w.paperId}/jobs/${w.jobId}/control`, undefined, who);
const head = async (w: W) => (await pool.query('SELECT head_revision_id FROM documents WHERE id = $1', [w.documentId])).rows[0].head_revision_id as string;

describe('TST-054A: the state shown is the database\'s; the manuscript and the material stay usable while AI waits', () => {
  test('a job waiting for its quota: status, reason, checkpoint, provider, unknown reset and context, permissions and actions', async () => {
    const w = await waiting();
    const r = await control(w);
    expect(r.statusCode, r.body).toBe(200);
    const c = r.json();
    const row = (await pool.query('SELECT status, attempts, last_error FROM jobs WHERE id = $1', [w.jobId])).rows[0];
    expect(c.job).toMatchObject({ id: w.jobId, intent: 'draft_paragraph', status: row.status, attempts: row.attempts, last_error: row.last_error });
    expect(c.checkpoint).toMatchObject({ seq: 1, boundary: 'before_call', pending_step: 'provider_call', provider: 'mock' });
    expect(c.last_error).toMatchObject({ class: 'quota', action: 'wait_for_reset', provider: 'claude_agent' });
    expect(c.quota_waits).toEqual([expect.objectContaining({ attempt: 1, provider: 'claude_agent', reset_known: false, state: 'waiting', wake_at: expect.any(String) })]);
    // nothing about the context was observed: unknown, not zero
    expect(c.context).toEqual({ tokens: null, window: null, source: 'unknown', observed_at: null });
    expect(c.auto_resume).toEqual({ state: 'not_allowed', expires_at: null });
    expect(c.actions).toEqual({ cancel: true, resume: true, auto_resume: true });
    // no lease or fencing details leave the server
    expect(JSON.stringify(c)).not.toMatch(/fencing|lease_owner|lease_expires/);
  });

  test('while the job waits the owner edits the manuscript and reads the material', async () => {
    const w = await waiting();
    const saved = await call('POST', `/api/papers/${w.paperId}/documents/${w.documentId}/saves`, { schema_version: 1, reason: 'autosave', expected_head_revision_id: w.headId, content_json: docOf('Written by hand while the AI waits.') });
    expect(saved.statusCode, saved.body).toBe(201);
    for (const url of [`/api/papers/${w.paperId}/evidence`, `/api/papers/${w.paperId}/references`, `/api/papers/${w.paperId}/documents/${w.documentId}`]) {
      const r = await call('GET', url);
      expect(r.statusCode, `${url} ${r.body}`).toBe(200);
    }
    expect((await control(w)).json().job.status).toBe('WAITING_QUOTA');
  });

  test('resume is the owner\'s act: the waiting job is queued again, its open wait closed; nothing else changes', async () => {
    const w = await waiting();
    expect((await call('POST', `/api/papers/${w.paperId}/jobs/${w.jobId}/resume`, {})).statusCode).toBe(422);
    expect((await call('POST', `/api/papers/${w.paperId}/jobs/${w.jobId}/resume`, { intent: 'resume_job' }, 'bob')).statusCode).toBe(404);
    const unpublished = async () => (await pool.query('SELECT count(*)::int AS n FROM job_outbox WHERE job_id = $1 AND published_at IS NULL', [w.jobId])).rows[0].n as number;
    const before = await unpublished();
    const r = await call('POST', `/api/papers/${w.paperId}/jobs/${w.jobId}/resume`, { intent: 'resume_job' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ id: w.jobId, status: 'QUEUED' });
    expect((await pool.query('SELECT state, reason FROM quota_waits WHERE job_id = $1', [w.jobId])).rows).toEqual([{ state: 'closed', reason: 'resumed by the owner' }]);
    // dispatched again (a new outbox message)
    expect(await unpublished()).toBe(before + 1);
    // the audit names the owner
    expect((await pool.query("SELECT actor FROM audit_events WHERE entity_id = $1 ORDER BY id DESC LIMIT 1", [w.jobId])).rows[0]?.actor).toBe(`owner:${ownerId}`);
    // a queued job is not resumed again
    expect((await call('POST', `/api/papers/${w.paperId}/jobs/${w.jobId}/resume`, { intent: 'resume_job' })).statusCode).toBe(409);
    expect((await control(w)).json().actions).toMatchObject({ resume: false, cancel: true });
    // the run that follows makes a proposal; the manuscript is untouched
    expect((await deliver(w, asInMain(createMockWriter(), w.auth))).outcome).toBe('completed');
    expect((await pool.query('SELECT status FROM paragraph_proposals WHERE job_id = $1', [w.jobId])).rows).toEqual([{ status: 'PENDING' }]);
    expect(await head(w)).toBe(w.headId);
    expect((await call('POST', `/api/papers/${w.paperId}/jobs/${w.jobId}/resume`, { intent: 'resume_job' })).statusCode).toBe(409);
    expect((await control(w)).json().actions).toEqual({ cancel: false, resume: false, auto_resume: false });
  });

  test('a cancelled job is not resumed', async () => {
    const w = await waiting();
    expect((await call('POST', `/api/papers/${w.paperId}/jobs/${w.jobId}/cancel`)).statusCode).toBe(200);
    expect((await call('POST', `/api/papers/${w.paperId}/jobs/${w.jobId}/resume`, { intent: 'resume_job' })).statusCode).toBe(409);
    expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [w.jobId])).rows[0].status).toBe('CANCELLED');
  });

  test('another owner\'s job, or an unknown job, has no control state', async () => {
    const w = await waiting();
    expect((await control(w, 'bob')).statusCode).toBe(404);
    expect((await call('GET', `/api/papers/${w.paperId}/jobs/${randomUUID()}/control`)).statusCode).toBe(404);
    expect((await call('GET', `/api/papers/${w.paperId}/jobs/not-a-uuid/control`)).statusCode).toBe(404);
    // the same owner's other paper does not reach this job (nor resume it)
    const other = (await call('POST', '/api/papers', { working_title: 'other paper', article_type: 'research_article' })).json();
    expect((await call('GET', `/api/papers/${other.id}/jobs/${w.jobId}/control`)).statusCode).toBe(404);
    expect((await call('POST', `/api/papers/${other.id}/jobs/${w.jobId}/resume`, { intent: 'resume_job' })).statusCode).toBe(404);
  });
});

describe('TST-054B: unknown is not 0; auto-resume is not an approval', () => {
  test('a measured or estimated context is shown with its source; a reading the provider gave is never mixed with an estimate', async () => {
    const w = await waiting();
    const cp = (await pool.query('SELECT id, fencing_token FROM job_checkpoints WHERE job_id = $1 ORDER BY seq DESC LIMIT 1', [w.jobId])).rows[0];
    await pool.query(`INSERT INTO context_switches (paper_id, job_id, seq, fencing_token, kind, from_session, context_window, context_tokens, context_source, occupancy, checkpoint_id)
      VALUES ($1, $2, 1, $3, 'checkpoint_review', 's1', 200000, 141000, 'estimated', 0.705, $4)`, [w.paperId, w.jobId, cp.fencing_token, cp.id]);
    expect((await control(w)).json().context).toMatchObject({ tokens: 141000, window: 200000, source: 'estimated', observed_at: expect.any(String) });
  });

  test('an auto-resumed run only makes a proposal: the manuscript is not changed and nothing is applied', async () => {
    const w = await waiting();
    const g = await call('POST', `/api/papers/${w.paperId}/jobs/${w.jobId}/auto-resume`, { intent: 'allow_auto_resume', hours: 6 });
    expect(g.statusCode, g.body).toBe(201);
    expect((await control(w)).json().auto_resume).toEqual({ state: 'allowed', expires_at: expect.any(String) });
    // the paper allows its material to go to this provider (else the wake hands the job to the owner)
    await pool.query("UPDATE paper_projects SET external_send_policy = 'allow_selected', allowed_providers = '{claude_agent}' WHERE id = $1", [w.paperId]);
    const decisions = await wakeDueWaits(pool, { now: new Date(Date.now() + 3 * 3600_000), probe: async () => 'allowed', jitterMs: () => 0 });
    expect(decisions.find((d) => d.job_id === w.jobId)).toMatchObject({ decision: 'resumed' });
    expect((await deliver(w, asInMain(createMockWriter(), w.auth))).outcome).toBe('completed');
    expect((await pool.query('SELECT status FROM paragraph_proposals WHERE job_id = $1', [w.jobId])).rows).toEqual([{ status: 'PENDING' }]);
    expect(await head(w)).toBe(w.headId);
    expect((await pool.query('SELECT count(*)::int AS n FROM document_revisions WHERE document_id = $1', [w.documentId])).rows[0].n).toBe(1);
  });
});

// PW-054 review m1: the owner's resume and the quota scheduler take the same locks in the same order (the
// job's open wait, then the job), so a resume during a wake-up waits instead of failing with a deadlock
describe('PW-054 review fixes', () => {
  test('m1: a resume while the scheduler holds the wait and then takes the job does not deadlock', async () => {
    const w = await waiting();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT id FROM quota_waits WHERE job_id = $1 AND state = 'waiting' FOR UPDATE", [w.jobId]);
      const resumed = call('POST', `/api/papers/${w.paperId}/jobs/${w.jobId}/resume`, { intent: 'resume_job' });
      await new Promise((r) => setTimeout(r, 300)); // the resume now waits for the wait row
      await c.query("SET LOCAL lock_timeout = '5s'");
      await c.query('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [w.jobId]);
      await c.query('COMMIT');
      const r = await resumed;
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().status).toBe('QUEUED');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  });

  test('m2: the last classified error says which state it led to, so an older run\'s next step is not shown for a newer stop', async () => {
    const w = await waiting();
    const c = (await control(w)).json();
    expect(c.last_error).toMatchObject({ class: 'quota', next_state: 'WAITING_QUOTA' });
  });
});

