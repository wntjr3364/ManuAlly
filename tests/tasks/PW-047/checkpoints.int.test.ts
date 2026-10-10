// PW-047 — checkpoints and rehydration (spec 08 "Checkpoint", "압축 시점"): at every boundary of an AI
// job (before the provider call, after the answer is validated, after the proposal is stored) the worker
// writes a DB checkpoint built without any LLM call — the approved story/outline/node, the facts and
// claims by id and hash, the completed actions, the pending step, policy versions, the provider session.
// A new provider session is rebuilt from the checkpoint and the canonical objects, re-checked.
// TST-047A: a new session gets the approved story, outline plan and facts, and the unfinished step.
// TST-047B: an AI summary never changes approvals, facts or completed work; no summary (no extra call
//   after the quota ran out) is needed to resume; what changed since the checkpoint stops the resume.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { approveClaim, createClaim, createEvidence, createFactCandidates, linkClaimEvidence, retractRecord, reviewEvidence, reviewFact } from '../../../packages/domain/src/evidence/index.ts';
import { cancelJob, claimJob } from '../../../packages/domain/src/jobs/index.ts';
import { recordQuota } from '../../../packages/domain/src/usage/index.ts';
import { processDelivery } from '../../../apps/worker/src/queue/index.ts';
import { writerHandlers, createMockWriter, type Writer } from '../../../apps/worker/src/writer/index.ts';
import { jobCheckpoints } from '../../../apps/worker/src/checkpoints/index.ts';
import { latestCheckpoint, listCheckpoints, recordCheckpoint, rehydrate, resumePrompt } from '../../../packages/domain/src/checkpoints/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
let H: Record<string, string>;
let ownerId: string;
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
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
const NOVELTY = 'First root-specific drought marker in this species';

// a paper with an approved story, a verified fact, an approved claim and an approved outline of one plan;
// a draft request for that plan (its job, not yet run)
async function world() {
  const p = (await call('POST', '/api/papers', { working_title: 'checkpoint paper', article_type: 'research_article' })).json();
  const s = (await call('POST', `/api/papers/${p.id}/story/revisions`, { parent_revision_id: null, brief: { purpose: 'Show the result', audience: 'x', known_facts: [], missing_material: [], avoid_claims: [] }, story: { question: 'q', main_message: 'm', novelty: NOVELTY, evidence_links: [], competing_explanations: [], presentation_order: [], limitations: [] } })).json();
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
  return { paperId: p.id as string, story: s as { id: string; content_hash: string }, outlineId: o.id as string, nodeId, fact: f!, claim: c, evidence: e, jobId: r.json().job.id as string };
}
type W = Awaited<ReturnType<typeof world>>;
const run = (w: W, writer: Writer) => processDelivery(pool, { job_id: w.jobId, paper_id: w.paperId, intent: 'draft_paragraph' }, { workerId: 'w1', leaseMs: 60_000, handlers: writerHandlers(pool, writer) });
// a provider session that ends before it answers (lost session, quota, crash): the job goes back to the queue
const lostSession: Writer = { id: 'mock', label: 'MOCK', async write() { throw new Error('provider session ended before answering'); } };

describe('TST-047A: a new session is rebuilt from the checkpoint and the approved objects', () => {
  test('before the provider call the job is checkpointed; after the session is lost, rehydration gives the approved story, plan, facts and the unfinished step', async () => {
    const w = await world();
    expect((await run(w, lostSession)).outcome).toBe('failed');
    const cp = (await latestCheckpoint(pool, w.paperId, w.jobId))!;
    expect(cp).toMatchObject({ boundary: 'before_call', seq: 1, pending_step: 'provider_call' });
    // nothing durable yet; the built contract is progress a lost run loses
    expect(cp.state.completed_actions).toEqual([]);
    expect(cp.state.last_event).toMatch(/^contract_built:[0-9a-f]{16}$/);
    // ids and hashes only, read from the database (no text, no model output)
    expect(cp.state.approved.story).toEqual({ id: w.story.id, content_hash: w.story.content_hash });
    expect(cp.state.approved.outline).toMatchObject({ id: w.outlineId, node_id: w.nodeId });
    expect(cp.state.approved.facts).toEqual([{ id: w.fact.id, content_hash: w.fact.content_hash }]);
    expect(cp.state.approved.claims).toEqual([{ id: w.claim.id, content_hash: w.claim.content_hash }]);
    expect(cp.state.policy).toMatchObject({ checkpoint_version: 'pw-checkpoint-1' });
    expect(cp.state.budget_reservation).toBe('UNKNOWN');

    const r = await rehydrate(pool, w.paperId, w.jobId);
    expect(r).toMatchObject({ resumable: true, drift: [], pending_step: 'provider_call', completed_actions: [] });
    expect(r.context.story.novelty).toBe(NOVELTY);
    expect(r.context.node).toMatchObject({ node_id: w.nodeId, section: 'Results', paragraph_goal: 'Root induction under drought' });
    expect(r.context.facts).toEqual([expect.objectContaining({ id: w.fact.id, entity: 'ABC1 roots', value_text: '2.4', unit: 'fold', n: 3 })]);
    expect(r.context.claims).toEqual([expect.objectContaining({ id: w.claim.id, text: 'ABC1 rises in roots under drought.' })]);
    const prompt = resumePrompt(r);
    for (const s of [NOVELTY, 'Root induction under drought', '2.4', 'ABC1 rises in roots under drought.', 'provider_call', 'contract_built:']) expect(prompt).toContain(s);

    // the retry in a new session continues: checkpoints after validation and after the stored proposal
    expect((await run(w, createMockWriter())).outcome).toBe('completed');
    const all = await listCheckpoints(pool, w.paperId, w.jobId);
    expect(all.map((x) => [x.seq, x.boundary, x.pending_step])).toEqual([[1, 'before_call', 'provider_call'], [2, 'before_call', 'provider_call'], [3, 'after_validation', 'store_proposal'], [4, 'after_proposal', null]]);
    expect(all[0]!.fencing_token).toBeLessThan(all[1]!.fencing_token);
    const proposal = (await pool.query('SELECT id FROM paragraph_proposals WHERE job_id = $1', [w.jobId])).rows[0];
    expect(all[2]!.state).toMatchObject({ completed_actions: [], last_event: 'answer_validated' });
    expect(all[3]!.state).toMatchObject({ completed_actions: [`proposal_stored:${proposal.id}`], last_event: 'proposal_pending' });
    expect((await rehydrate(pool, w.paperId, w.jobId))).toMatchObject({ resumable: false, reasons: ['job_finished'] });
  });
});

describe('TST-047B: summaries are notes, not evidence; nothing needs a model to resume', () => {
  test('an AI summary that claims other facts, approvals or finished work changes nothing; it is shown only as an unverified note', async () => {
    const w = await world();
    await run(w, lostSession);
    const job = (await claimJob(pool, { jobId: w.jobId, workerId: 'w2', leaseMs: 60_000 }))!;
    const prev = (await latestCheckpoint(pool, w.paperId, w.jobId))!;
    await recordCheckpoint(pool, { paperId: w.paperId, jobId: w.jobId, fencingToken: job.fencingToken, boundary: 'session_change', pendingStep: 'provider_call', completedActions: prev.state.completed_actions,
      scope: prev.state.scope, summary: { source: 'ai', text: 'Done: the paragraph was stored. The outline was approved again and the fold change is 3.1 (n = 6).' } });
    const r = await rehydrate(pool, w.paperId, w.jobId);
    expect(r.completed_actions).toEqual([]);
    expect(r.pending_step).toBe('provider_call');
    expect(r.context.facts[0]).toMatchObject({ value_text: '2.4', n: 3 });
    expect(r.summary_note).toEqual({ source: 'ai', trusted: false, text: expect.stringContaining('3.1') });
    const prompt = resumePrompt(r);
    // the canonical facts come first; the note is labelled as unverified
    expect(prompt.indexOf('2.4')).toBeLessThan(prompt.indexOf('3.1'));
    expect(prompt).toMatch(/not evidence|unverified/i);
  });

  test('a checkpoint carries ids, never content or approvals given by the caller; completed work cannot be undone; only the current run writes', async () => {
    const w = await world();
    await run(w, lostSession);
    const job = (await claimJob(pool, { jobId: w.jobId, workerId: 'w2', leaseMs: 60_000 }))!;
    const base = { paperId: w.paperId, jobId: w.jobId, fencingToken: job.fencingToken, boundary: 'before_call' as const, pendingStep: 'provider_call', scope: (await latestCheckpoint(pool, w.paperId, w.jobId))!.state.scope };
    const done = `proposal_stored:${randomUUID()}`;
    await recordCheckpoint(pool, { ...base, completedActions: [done] });
    await expect(recordCheckpoint(pool, { ...base, completedActions: [done], approved: { story: { id: w.story.id, content_hash: 'f'.repeat(64) } } } as never)).rejects.toMatchObject({ code: 'INVALID' });
    await expect(recordCheckpoint(pool, { ...base, completedActions: [done], scope: { ...base.scope, facts: [{ id: w.fact.id, value_text: '3.1' }] } } as never)).rejects.toMatchObject({ code: 'INVALID' });
    await expect(recordCheckpoint(pool, { ...base, completedActions: [] })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(recordCheckpoint(pool, { ...base, completedActions: [done], summary: { source: 'ai', text: 'x'.repeat(4001) } })).rejects.toMatchObject({ code: 'INVALID' });
    // an older run (an earlier fencing token) cannot write
    await expect(recordCheckpoint(pool, { ...base, fencingToken: job.fencingToken - 1, completedActions: [done] })).rejects.toMatchObject({ code: 'CONFLICT' });
    // checkpoints are kept as written
    await expect(pool.query("UPDATE job_checkpoints SET pending_step = 'done' WHERE job_id = $1", [w.jobId])).rejects.toThrow(/immutable/);
  });

  test('no summary and an exhausted quota: rehydration needs no model call', async () => {
    const w = await world();
    await run(w, lostSession);
    // the provider said the quota is used up, with no reset time
    await recordQuota(pool, { provider: 'claude_agent', authProfileId: 'default', bucket: 'reported', eventKey: randomUUID(), data: { status: 'rejected', used_percent: 100 } });
    expect((await pool.query("SELECT count(*)::int AS n FROM quota_observations WHERE used_percent = 100")).rows[0].n).toBeGreaterThan(0);
    const r = await rehydrate(pool, w.paperId, w.jobId);
    expect(r.resumable).toBe(true);
    expect(r.summary_note).toBeNull();
    expect(resumePrompt(r)).not.toMatch(/unverified/i);
  });

  test('what changed since the checkpoint stops the resume until it is checked again', async () => {
    const w = await world();
    await run(w, lostSession);
    // a fact the plan relies on is withdrawn
    await retractRecord(pool, { paperId: w.paperId, ownerId, kind: 'fact', id: w.fact.id, body: { intent: 'retract_fact', content_hash: w.fact.content_hash } });
    let r = await rehydrate(pool, w.paperId, w.jobId);
    expect(r.resumable).toBe(false);
    expect(r.drift).toContainEqual({ kind: 'fact', id: w.fact.id, reason: 'no_longer_settled' });
    expect(r.context.facts).toEqual([]);
    // a new story is approved (the old one superseded)
    const s2 = (await call('POST', `/api/papers/${w.paperId}/story/revisions`, { parent_revision_id: w.story.id, brief: { purpose: 'Show the result', audience: 'x', known_facts: [], missing_material: [], avoid_claims: [] }, story: { question: 'q', main_message: 'm2', novelty: 'Another novelty', evidence_links: [], competing_explanations: [], presentation_order: [], limitations: [] } })).json();
    await call('POST', `/api/papers/${w.paperId}/story/revisions/${s2.id}/approve`, { intent: 'approve_story', content_hash: s2.content_hash });
    r = await rehydrate(pool, w.paperId, w.jobId);
    expect(r.drift).toContainEqual({ kind: 'story', id: w.story.id, reason: 'no_longer_approved' });
    // the old story is what the checkpoint names; the new one is not taken silently
    expect(r.context.story.novelty).toBe(NOVELTY);
    // the paper's sending policy changed
    await pool.query("UPDATE paper_projects SET external_send_policy = 'allow_selected', allowed_providers = '{codex}' WHERE id = $1", [w.paperId]);
    r = await rehydrate(pool, w.paperId, w.jobId);
    expect(r.drift).toContainEqual({ kind: 'policy', id: w.paperId, reason: 'changed' });
    // a cancelled job does not resume
    await cancelJob(pool, { paperId: w.paperId, jobId: w.jobId, ownerId });
    expect((await rehydrate(pool, w.paperId, w.jobId)).reasons).toContain('job_cancelled');
  });

  test('the worker re-checks before resuming: a change since the checkpoint sends the job to the owner, not to the provider', async () => {
    const w = await world();
    await run(w, lostSession);
    // the owner changes what may be sent while the job waits
    await pool.query("UPDATE paper_projects SET external_send_policy = 'allow_selected', allowed_providers = '{codex}' WHERE id = $1", [w.paperId]);
    let called = 0;
    const counting: Writer = { id: 'mock', label: 'MOCK', async write(c) { called++; return createMockWriter().write(c); } };
    await run(w, counting);
    expect(called).toBe(0);
    const job = (await pool.query('SELECT status, last_error FROM jobs WHERE id = $1', [w.jobId])).rows[0];
    expect(job.status).toBe('WAITING_USER');
    expect(job.last_error).toMatch(/changed since the last checkpoint.*policy/);
    expect((await pool.query('SELECT count(*)::int AS n FROM paragraph_proposals WHERE job_id = $1', [w.jobId])).rows[0].n).toBe(0);
  });

  test('a later run carries the durable work of the earlier one (the worker helper)', async () => {
    const w = await world();
    await run(w, lostSession);
    const first = (await claimJob(pool, { jobId: w.jobId, workerId: 'w2', leaseMs: 60_000 }))!;
    const done = `proposal_stored:${randomUUID()}`;
    await jobCheckpoints(pool, first.job, first.fencingToken, { provider: 'mock' }).mark('session_change', 'provider_call', [done]);
    await pool.query("UPDATE jobs SET status = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1", [w.jobId]);
    const second = (await claimJob(pool, { jobId: w.jobId, workerId: 'w3', leaseMs: 60_000 }))!;
    const cps = jobCheckpoints(pool, second.job, second.fencingToken, { provider: 'mock' });
    expect((await cps.resume())!.completed_actions).toEqual([done]);
    expect((await cps.mark('before_call', 'provider_call', [])).state.completed_actions).toEqual([done]);
  });

  test('a job of another paper, or without a checkpoint, is not rehydrated', async () => {
    const w = await world();
    await expect(rehydrate(pool, w.paperId, w.jobId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await run(w, lostSession);
    const other = await world();
    await expect(rehydrate(pool, other.paperId, w.jobId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
