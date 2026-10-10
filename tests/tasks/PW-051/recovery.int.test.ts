// PW-051 — one writer per job, stale workers fenced off, duplicate deliveries and lost messages handled,
// in-flight runs recovered (spec 08 "신뢰 가능한 queue": lease heartbeat + fencing token; outbox; "외부 모델은
// 정확히 한 번만 과금됐다고 보장하지 않는다").
// TST-051A: through a worker crash, a takeover and duplicate deliveries, the manuscript changes once and
//   the job's progress is reconciled.
// TST-051B: an expired worker changes nothing; the provider usage of a discarded run is counted and never
//   reported as exactly-once billing.
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
import { appendJobEvent, completeJob, heartbeatJob, listJobEvents } from '../../../packages/domain/src/jobs/index.ts';
import { recordUsage } from '../../../packages/domain/src/usage/index.ts';
import { billingAccount, leaseState } from '../../../packages/domain/src/leases/index.ts';
import { processDelivery, relayOutbox, type JobMessage } from '../../../apps/worker/src/queue/index.ts';
import { writerHandlers, createMockWriter, type Writer } from '../../../apps/worker/src/writer/index.ts';
import { reconcileInflight, listRecoveryLog } from '../../../apps/worker/src/recovery/index.ts';
import { initialState, reduce } from '../../../apps/web/src/features/chat/stream-state.ts';
import { withAdmission } from '../../../apps/worker/src/admission/index.ts';
import { listReservations } from '../../../packages/domain/src/budget/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
let H: Record<string, string>;
let ownerId: string;
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 12 });
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

async function world() {
  const p = (await call('POST', '/api/papers', { working_title: 'recovery paper', article_type: 'research_article' })).json();
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
  const o = (await call('POST', `/api/papers/${p.id}/outline/revisions`, { parent_revision_id: null, story_revision_id: s.id, nodes: [{ node_id: nodeId, parent_node_id: null, section: 'Results', role: 'result', paragraph_goal: 'Root induction', claim_ids: [c.id], evidence_ids: [e.id], requires_evidence: false, allowed_interpretation: '', exclusions: [], transition: '', word_budget_min: null, word_budget_max: null }] })).json();
  await call('POST', `/api/papers/${p.id}/outline/revisions/${o.id}/approve`, { intent: 'approve_outline', content_hash: o.content_hash });
  const d = (await call('POST', `/api/papers/${p.id}/documents`, { kind: 'manuscript' })).json();
  const r = await call('POST', `/api/papers/${p.id}/writer/requests`, { mode: 'draft', outline_revision_id: o.id, node_id: nodeId, document_id: d.document.id, base_revision_id: d.head.id, idempotency_key: randomUUID() });
  return { paperId: p.id as string, jobId: r.json().job.id as string, documentId: d.document.id as string };
}
type W = Awaited<ReturnType<typeof world>>;
const msg = (w: W): JobMessage => ({ job_id: w.jobId, paper_id: w.paperId, intent: 'draft_paragraph' });
const deliver = (w: W, worker: string, writer: Writer, leaseMs = 60_000) => processDelivery(pool, msg(w), { workerId: worker, leaseMs, handlers: writerHandlers(pool, writer) });
// a writer that waits until released (a slow or hung provider call)
function heldWriter() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let started!: () => void;
  const startedP = new Promise<void>((r) => { started = r; });
  const writer: Writer = { id: 'mock', label: 'MOCK', async write(c) { started(); await gate; return createMockWriter().write(c); } };
  return { writer, release, started: startedP };
}
const expireLease = (w: W) => pool.query("UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1 AND status = 'RUNNING'", [w.jobId]);
const proposals = async (w: W) => (await pool.query('SELECT id, status, proposal_hash, base_revision_id FROM paragraph_proposals WHERE job_id = $1', [w.jobId])).rows;

describe('TST-051A: through a crash, a takeover and duplicates, the manuscript changes once', () => {
  test('a worker that loses its lease mid-run is replaced; only the current run stores; progress is reconciled', async () => {
    const w = await world();
    const a = heldWriter();
    // worker A claims and hangs in the provider call
    const runA = deliver(w, 'A', a.writer);
    await a.started;
    expect(await leaseState(pool, w.paperId, w.jobId)).toMatchObject({ status: 'RUNNING', lease_owner: 'A', fencing_token: 1, expired: false });
    // A stops heartbeating (crash, network): its lease expires; recovery re-queues the job
    await expireLease(w);
    expect(await leaseState(pool, w.paperId, w.jobId)).toMatchObject({ expired: true });
    const rec = await reconcileInflight(pool, { redispatchAfterMs: 60_000 });
    expect(rec).toMatchObject({ requeued: 1, failed: 0 });
    expect(rec.jobs).toContainEqual({ job_id: w.jobId, status: 'QUEUED' });
    // the job's progress says so (what the browser shows)
    const ev = await listJobEvents(pool, w.paperId, w.jobId);
    // not a 'status' (the browser reads that as a new run); no worker id in what the browser sees
    expect(ev.at(-1)).toEqual(expect.objectContaining({ kind: 'error', data: { reason: 'lease_expired', status: 'QUEUED' } }));
    expect((await listRecoveryLog(pool)).at(-1)!.jobs).toContainEqual({ job_id: w.jobId, status: 'QUEUED', previous_owner: 'A' });
    // worker B takes it over and finishes
    expect((await deliver(w, 'B', createMockWriter())).outcome).toBe('completed');
    expect(await leaseState(pool, w.paperId, w.jobId)).toMatchObject({ status: 'SUCCEEDED', fencing_token: 2, lease_owner: null });
    // A wakes up: it is fenced off — nothing it does is stored
    a.release();
    expect((await runA).outcome).toBe('lost_lease');
    expect(await proposals(w)).toHaveLength(1);
    // the recovery is recorded
    expect((await listRecoveryLog(pool)).at(-1)).toMatchObject({ requeued: expect.any(Number), failed: 0 });
  });

  test('a job another worker claims right after it was re-queued: exactly one recovery note, and the new run finishes', async () => {
    const w = await world();
    const a = heldWriter();
    const runA = deliver(w, 'A', a.writer);
    await a.started;
    await expireLease(w);
    const b = heldWriter();
    let runB: Promise<unknown> = Promise.resolve();
    await reconcileInflight(pool, { redispatchAfterMs: 60_000, afterRecover: async () => { runB = deliver(w, 'B', b.writer); await b.started; } });
    a.release(); b.release();
    await runA; await runB;
    // the recovery note is written with the recovery itself (one transaction), so it precedes whatever
    // the next run reports
    const ev = await listJobEvents(pool, w.paperId, w.jobId);
    expect(ev.filter((e) => e.data.reason === 'lease_expired')).toHaveLength(1);
    expect(await leaseState(pool, w.paperId, w.jobId)).toMatchObject({ status: 'SUCCEEDED', fencing_token: 2 });
  });

  test('the reservation of a run that lost its lease is settled by the sweep', async () => {
    const w = await world();
    const a = heldWriter();
    const runA = processDelivery(pool, msg(w), { workerId: 'A', leaseMs: 60_000, handlers: withAdmission(pool, writerHandlers(pool, a.writer), { provider: 'mock', authMode: 'none', estimateUsd: () => null }) });
    await a.started;
    await expireLease(w);
    const rec = await reconcileInflight(pool, { redispatchAfterMs: 60_000 });
    expect(rec.settled).toBeGreaterThanOrEqual(1);
    expect((await listReservations(pool, w.paperId, w.jobId)).map((r) => r.state)).toEqual(['settled']);
    a.release();
    await runA;
  });

  test('two sweeps at once recover a lost run once, with one event', async () => {
    const w = await world();
    const a = heldWriter();
    const runA = deliver(w, 'A', a.writer);
    await a.started;
    await expireLease(w);
    const recs = await Promise.all([reconcileInflight(pool, { redispatchAfterMs: 60_000 }), reconcileInflight(pool, { redispatchAfterMs: 60_000 })]);
    expect(recs.flatMap((r) => r.jobs).filter((j) => j.job_id === w.jobId)).toHaveLength(1);
    expect((await listJobEvents(pool, w.paperId, w.jobId)).filter((e) => e.data.reason === 'lease_expired')).toHaveLength(1);
    a.release();
    await runA;
  });

  test('the browser\'s progress does not read the recovery note as a new run', () => {
    const answering = reduce(reduce(initialState, { event: 'status', id: 1, data: { run: 1, label: 'MOCK', provider: 'mock' } }), { event: 'delta', id: 2, data: { text: 'partial' } });
    const queued = reduce(answering, { event: 'job', data: { status: 'QUEUED' } });
    const after = reduce(queued, { event: 'error', id: 3, data: { reason: 'lease_expired', status: 'QUEUED' } });
    expect(after.phase).toBe('queued');
    expect(after.label).toBe('MOCK');
  });

  test('the same message delivered twice at once runs the job once; a late duplicate is ignored', async () => {
    const w = await world();
    let ran = 0;
    const counting: Writer = { id: 'mock', label: 'MOCK', async write(c) { ran++; await new Promise((r) => setTimeout(r, 50)); return createMockWriter().write(c); } };
    const outs = await Promise.all([deliver(w, 'A', counting), deliver(w, 'B', counting), deliver(w, 'C', counting)]);
    expect(outs.map((o) => o.outcome).sort()).toEqual(['completed', 'duplicate', 'duplicate']);
    expect(ran).toBe(1);
    expect((await deliver(w, 'D', counting)).outcome).toBe('duplicate');
    expect(await proposals(w)).toHaveLength(1);
  });

  test('a message published but not marked (the relay died) is published again; the second delivery is a no-op', async () => {
    const w = await world();
    const sent: JobMessage[] = [];
    // the publish reached the queue, then the relay crashed before marking it
    await relayOutbox(pool, async (m) => { sent.push(m); throw new Error('relay crashed after publishing'); });
    await pool.query('UPDATE job_outbox SET available_at = clock_timestamp() WHERE job_id = $1', [w.jobId]);
    await relayOutbox(pool, async (m) => { sent.push(m); });
    const mine = sent.filter((m) => m.job_id === w.jobId);
    expect(mine).toHaveLength(2);
    const outs = [];
    for (const m of mine) outs.push((await processDelivery(pool, m, { workerId: 'W', leaseMs: 60_000, handlers: writerHandlers(pool, createMockWriter()) })).outcome);
    expect(outs).toEqual(['completed', 'duplicate']);
    expect(await proposals(w)).toHaveLength(1);
  });

  test('a lost message is sent again by the recovery sweep', async () => {
    const w = await world();
    // the outbox message was published, but the queue lost it: the job stays QUEUED with nothing pending
    await relayOutbox(pool, async () => {});
    const rec = await reconcileInflight(pool, { redispatchAfterMs: 0 });
    expect(rec.redispatched).toBeGreaterThanOrEqual(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM job_outbox WHERE job_id = $1 AND published_at IS NULL', [w.jobId])).rows[0].n).toBe(1);
  });

  test('applying the stored proposal twice at once changes the manuscript once', async () => {
    const w = await world();
    await deliver(w, 'A', createMockWriter());
    const [p] = await proposals(w);
    const apply = () => call('POST', `/api/papers/${w.paperId}/writer/proposals/${p.id}/apply`, { intent: 'apply_paragraph', proposal_hash: p.proposal_hash, expected_revision_id: p.base_revision_id });
    const codes = (await Promise.all([apply(), apply(), apply()])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409]);
    expect((await pool.query("SELECT count(*)::int AS n FROM document_revisions WHERE document_id = $1 AND reason = 'ai_apply'", [w.documentId])).rows[0].n).toBe(1);
  });
});

describe('TST-051B: an expired worker changes nothing; billing is not exactly-once', () => {
  test('after its lease is taken over, a stale worker cannot heartbeat, report progress or complete', async () => {
    const w = await world();
    const a = heldWriter();
    const runA = deliver(w, 'A', a.writer);
    await a.started;
    await expireLease(w);
    await reconcileInflight(pool, { redispatchAfterMs: 60_000 });
    const b = heldWriter();
    const runB = deliver(w, 'B', b.writer);
    await b.started;
    // A (fencing token 1) against B's run (token 2)
    expect(await heartbeatJob(pool, { jobId: w.jobId, fencingToken: 1, leaseMs: 60_000 })).toBe(false);
    await expect(appendJobEvent(pool, { jobId: w.jobId, fencingToken: 1, kind: 'delta', data: { text: 'stale' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(completeJob(pool, { jobId: w.jobId, fencingToken: 1, result: { stale: true } })).rejects.toMatchObject({ code: 'CONFLICT' });
    a.release();
    expect((await runA).outcome).toBe('lost_lease');
    b.release();
    expect((await runB).outcome).toBe('completed');
    const rows = await proposals(w);
    expect(rows).toHaveLength(1);
    // the stored proposal came from B's run (its checkpoint after the proposal names B's fence)
    expect((await pool.query("SELECT fencing_token::int AS t FROM job_checkpoints WHERE job_id = $1 AND boundary = 'after_proposal'", [w.jobId])).rows).toEqual([{ t: 2 }]);
  });

  test('a recovered job that has used its attempts fails instead of looping', async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) {
      const h = heldWriter();
      const run = deliver(w, `W${i}`, h.writer);
      await h.started;
      await expireLease(w);
      await reconcileInflight(pool, { redispatchAfterMs: 60_000 });
      h.release();
      await run;
    }
    expect(await leaseState(pool, w.paperId, w.jobId)).toMatchObject({ status: 'FAILED' });
    expect((await listJobEvents(pool, w.paperId, w.jobId)).at(-1)).toMatchObject({ kind: 'error', data: { status: 'FAILED', reason: 'lease_expired' } });
  });

  test('the usage of a discarded run is counted, and billing is reported as at-least-once', async () => {
    const w = await world();
    const a = heldWriter();
    const runA = deliver(w, 'A', a.writer);
    await a.started;
    // A's provider call was made and reported usage before A lost its lease
    await recordUsage(pool, { paperId: w.paperId, jobId: w.jobId, provider: 'mock', nativeSessionId: `A-${randomUUID()}`, eventKey: randomUUID(), data: { scope: 'turn', input_tokens: 100, output_tokens: 20, cost_usd_estimate: 0, context_window: null } });
    await expireLease(w);
    await reconcileInflight(pool, { redispatchAfterMs: 60_000 });
    await deliver(w, 'B', createMockWriter());
    await recordUsage(pool, { paperId: w.paperId, jobId: w.jobId, provider: 'mock', nativeSessionId: `B-${randomUUID()}`, eventKey: randomUUID(), data: { scope: 'turn', input_tokens: 100, output_tokens: 20, cost_usd_estimate: 0, context_window: null } });
    a.release();
    await runA;
    const acct = await billingAccount(pool, w.paperId, w.jobId);
    // two runs reached the provider, one result was kept
    expect(acct).toMatchObject({ runs: 2, sessions_with_usage: 2, results_kept: 1, billing: 'at_least_once', exactly_once: false });
    expect(acct.note).toMatch(/not exactly once/i);
  });

  test('the lease view does not report a lost run as alive', async () => {
    const w = await world();
    await expect(leaseState(pool, w.paperId, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await leaseState(pool, w.paperId, w.jobId)).toMatchObject({ status: 'QUEUED', lease_owner: null, expired: false, fencing_token: 0 });
  });
});
