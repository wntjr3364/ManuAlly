// PW-049 — waiting out a quota and resuming only after a re-check (spec 08 "Quota normalization",
// "자동 재개"). A provider quota error puts the job in WAITING_QUOTA with a durable wait: woken at the
// latest reset of every blocked bucket plus a short jitter, or — when a reset time is not known — after a
// bounded backoff, never at an invented time. At the wake-up nothing runs unless every check passes: the
// job is still waiting (not cancelled), the owner's auto-resume permission is still valid, no other bucket
// is still blocked, the provider confirms it can be used (always required when the reset was unknown),
// login, sending policy and the manuscript are as they were. Resuming only queues the job: it produces a
// proposal, never applies anything, never switches provider.
// TST-049A: after the provider's reset the job is re-checked and resumes within the owner's permission.
// TST-049B: another blocked bucket, an unknown reset, a cancelled job or an expired permission never runs.
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
import { cancelJob } from '../../../packages/domain/src/jobs/index.ts';
import { recordQuota } from '../../../packages/domain/src/usage/index.ts';
import { listQuotaWaits } from '../../../packages/domain/src/quota-waits/index.ts';
import { processDelivery } from '../../../apps/worker/src/queue/index.ts';
import { writerHandlers, createMockWriter, type Writer } from '../../../apps/worker/src/writer/index.ts';
import { QuotaExceeded, enterQuotaWait, wakeDueWaits, withQuotaWaits, type Probe } from '../../../apps/worker/src/quota-scheduler/index.ts';

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
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, headers: H[who], payload: payload as object | undefined });

// a paper that may send to claude_agent, an approved plan, and a draft request for it
async function world(opts: { afterParagraph?: boolean } = {}) {
  const p = (await call('alice', 'POST', '/api/papers', { working_title: 'quota paper', article_type: 'research_article' })).json();
  await pool.query("UPDATE paper_projects SET external_send_policy = 'allow_selected', allowed_providers = '{claude_agent}' WHERE id = $1", [p.id]);
  const s = (await call('alice', 'POST', `/api/papers/${p.id}/story/revisions`, { parent_revision_id: null, brief: { purpose: 'Show the result', audience: 'x', known_facts: [], missing_material: [], avoid_claims: [] }, story: { question: 'q', main_message: 'm', novelty: 'n', evidence_links: [], competing_explanations: [], presentation_order: [], limitations: [] } })).json();
  await call('alice', 'POST', `/api/papers/${p.id}/story/revisions/${s.id}/approve`, { intent: 'approve_story', content_hash: s.content_hash });
  const e = await createEvidence(pool, { paperId: p.id, ownerId, body: { kind: 'experiment', locator: { note: 'run 1' }, label: 'qPCR' } });
  await reviewEvidence(pool, { paperId: p.id, ownerId, id: e.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: e.content_hash } });
  const [f] = await createFactCandidates(pool, { paperId: p.id, ownerId, origin: 'user', single: true, facts: [{ evidence_id: e.id, entity: 'ABC1 roots', metric: 'fold change', value_text: '2.4', unit: 'fold', group: 'drought', comparison: 'control', n: 3, extraction_method: 'manual_entry' }] });
  await reviewFact(pool, { paperId: p.id, ownerId, id: f!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: f!.content_hash } });
  const c = await createClaim(pool, { paperId: p.id, ownerId, body: { kind: 'observation', text: 'ABC1 rises in roots under drought.' } });
  await linkClaimEvidence(pool, { paperId: p.id, ownerId, claimId: c.id, body: { evidence_id: e.id, relation: 'supports' } });
  await approveClaim(pool, { paperId: p.id, ownerId, id: c.id, body: { intent: 'approve_claim', content_hash: c.content_hash } });
  const nodeId = randomUUID();
  const o = (await call('alice', 'POST', `/api/papers/${p.id}/outline/revisions`, { parent_revision_id: null, story_revision_id: s.id, nodes: [{ node_id: nodeId, parent_node_id: null, section: 'Results', role: 'result', paragraph_goal: 'Root induction', claim_ids: [c.id], evidence_ids: [e.id], requires_evidence: false, allowed_interpretation: '', exclusions: [], transition: '', word_budget_min: null, word_budget_max: null }] })).json();
  await call('alice', 'POST', `/api/papers/${p.id}/outline/revisions/${o.id}/approve`, { intent: 'approve_outline', content_hash: o.content_hash });
  const d = (await call('alice', 'POST', `/api/papers/${p.id}/documents`, { kind: 'manuscript' })).json();
  let head = d.head.id as string;
  // optionally a paragraph the new one is to follow (its place)
  const after = { type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text: 'ABC1 was measured by qPCR.' }] };
  if (opts.afterParagraph) head = (await call('alice', 'POST', `/api/papers/${p.id}/documents/${d.document.id}/saves`, { expected_head_revision_id: head, content_json: { type: 'doc', content: [after] }, schema_version: 1, reason: 'manual' })).json().id;
  const r = await call('alice', 'POST', `/api/papers/${p.id}/writer/requests`, { mode: 'draft', outline_revision_id: o.id, node_id: nodeId, document_id: d.document.id, base_revision_id: head, ...(opts.afterParagraph ? { after_block_id: after.attrs.id } : {}), idempotency_key: randomUUID() });
  return { paperId: p.id as string, jobId: r.json().job.id as string, documentId: d.document.id as string, headId: head, after };
}
type W = Awaited<ReturnType<typeof world>>;
const jitter = () => 60_000;
const run = (w: W, writer: Writer) => processDelivery(pool, { job_id: w.jobId, paper_id: w.paperId, intent: 'draft_paragraph' }, { workerId: 'w1', leaseMs: 60_000, handlers: withQuotaWaits(pool, writerHandlers(pool, writer), { jitterMs: jitter }) });
const grant = (w: W, hours: number, who = 'alice') => call(who, 'POST', `/api/papers/${w.paperId}/jobs/${w.jobId}/auto-resume`, { intent: 'allow_auto_resume', hours });
const status = async (w: W) => (await pool.query('SELECT status, last_error FROM jobs WHERE id = $1', [w.jobId])).rows[0] as { status: string; last_error: string | null };
const min = (n: number) => n * 60_000;
// each test uses its own login so observations of other tests do not mix in
let profile = 0;
async function scenario(buckets: { bucket: string; resetsIn: number | null }[], opts: { afterParagraph?: boolean } = {}) {
  profile++;
  const w = await world(opts);
  const auth = `p${profile}`;
  const now = Date.now();
  for (const b of buckets) await recordQuota(pool, { provider: 'claude_agent', authProfileId: auth, bucket: b.bucket, eventKey: randomUUID(), observedAt: new Date(now - 1000).toISOString(), data: { status: 'rejected', used_percent: 100, resets_at: b.resetsIn === null ? null : new Date(now + b.resetsIn).toISOString() } });
  const writer: Writer = { id: 'mock', label: 'MOCK', async write() { throw new QuotaExceeded('usage limit reached', { provider: 'claude_agent', authProfileId: auth }); } };
  const out = await processDelivery(pool, { job_id: w.jobId, paper_id: w.paperId, intent: 'draft_paragraph' }, { workerId: 'w1', leaseMs: 60_000, handlers: withQuotaWaits(pool, writerHandlers(pool, writer), { jitterMs: jitter, now: () => new Date(now) }) });
  return { w, auth, now, out };
}
const probeOf = (answer: Awaited<ReturnType<Probe>>) => { const calls: unknown[] = []; const p: Probe = async (q) => { calls.push(q); return answer; }; return { p, calls }; };

describe('TST-049A: after the reset the job is re-checked and resumes within the owner\'s permission', () => {
  test('a known reset: woken at reset + jitter, the provider confirms, the job is queued and only proposes', async () => {
    const { w, auth, now, out } = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }]);
    expect(out.outcome).toBe('failed');
    expect((await status(w)).status).toBe('WAITING_QUOTA');
    const [wait] = await listQuotaWaits(pool, w.paperId, w.jobId);
    expect(wait).toMatchObject({ state: 'waiting', provider: 'claude_agent', auth_profile_id: auth, reset_known: true, attempt: 1 });
    expect(new Date(wait!.wake_at).getTime()).toBe(now + min(30) + 60_000);
    expect((await grant(w, 24)).statusCode).toBe(201);
    // before the wake-up nothing happens
    const early = probeOf('allowed');
    expect(await wakeDueWaits(pool, { now: new Date(now + min(10)), probe: early.p, jitterMs: jitter })).toEqual([]);
    expect(early.calls).toEqual([]);
    // after it: the provider is asked (no other bucket is blocked), then the job is queued again
    const outbox = async () => (await pool.query('SELECT count(*)::int AS n FROM job_outbox WHERE job_id = $1', [w.jobId])).rows[0].n as number;
    const before = await outbox();
    const later = probeOf('allowed');
    const d = await wakeDueWaits(pool, { now: new Date(now + min(32)), probe: later.p, jitterMs: jitter });
    expect(d).toEqual([{ job_id: w.jobId, decision: 'resumed', reason: null }]);
    expect(later.calls).toEqual([{ provider: 'claude_agent', authProfileId: auth }]);
    expect((await status(w)).status).toBe('QUEUED');
    // one new dispatch message (written with the status change)
    expect(await outbox()).toBe(before + 1);
    expect((await listQuotaWaits(pool, w.paperId, w.jobId))[0]).toMatchObject({ state: 'resumed' });
    // the resumed run makes a proposal; nothing is applied
    expect((await run(w, createMockWriter())).outcome).toBe('completed');
    expect((await pool.query('SELECT status FROM paragraph_proposals WHERE job_id = $1', [w.jobId])).rows.map((r) => r.status)).toEqual(['PENDING']);
    expect((await pool.query("SELECT count(*)::int AS n FROM document_revisions WHERE document_id = $1 AND reason = 'ai_apply'", [w.documentId])).rows[0].n).toBe(0);
  });

  test('the owner grants (1–72 h) and revokes auto-resume for their own unfinished job', async () => {
    const w = await world();
    expect((await grant(w, 0)).statusCode).toBe(422);
    expect((await grant(w, 73)).statusCode).toBe(422);
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/jobs/${w.jobId}/auto-resume`, { hours: 2 })).statusCode).toBe(422);
    expect((await grant(w, 2, 'bob')).statusCode).toBe(404);
    expect((await grant(w, 2)).json()).toMatchObject({ kind: 'allow' });
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/jobs/${w.jobId}/auto-resume`, { intent: 'revoke_auto_resume' })).json()).toMatchObject({ kind: 'revoke' });
    await cancelJob(pool, { paperId: w.paperId, jobId: w.jobId, ownerId });
    expect((await grant(w, 2)).statusCode).toBe(409);
  });
});

describe('TST-049B: never run unconditionally', () => {
  test('another bucket still blocked: rescheduled to its reset, the provider is not even asked', async () => {
    const { w, now } = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }, { bucket: 'weekly', resetsIn: min(600) }]);
    await grant(w, 72);
    const [first] = await listQuotaWaits(pool, w.paperId, w.jobId);
    // every blocked bucket must reset: the wake-up is the later one
    expect(new Date(first!.wake_at).getTime()).toBe(now + min(600) + 60_000);
    // a weekly limit observed later than the wait (e.g. by another run) also keeps it waiting
    const { w: w2, auth, now: now2 } = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }]);
    await grant(w2, 72);
    await recordQuota(pool, { provider: 'claude_agent', authProfileId: auth, bucket: 'weekly', eventKey: randomUUID(), observedAt: new Date(now2 + min(5)).toISOString(), data: { status: 'rejected', used_percent: 100, resets_at: new Date(now2 + min(300)).toISOString() } });
    const pr = probeOf('allowed');
    const d = await wakeDueWaits(pool, { now: new Date(now2 + min(32)), probe: pr.p, jitterMs: jitter });
    expect(d).toEqual([{ job_id: w2.jobId, decision: 'rescheduled', reason: 'bucket_still_blocked' }]);
    expect(pr.calls).toEqual([]);
    expect((await status(w2)).status).toBe('WAITING_QUOTA');
    const waits = await listQuotaWaits(pool, w2.paperId, w2.jobId);
    expect(waits.map((x) => [x.state, x.attempt])).toEqual([['rescheduled', 1], ['waiting', 2]]);
    expect(new Date(waits[1]!.wake_at).getTime()).toBe(now2 + min(300) + 60_000);
  });

  test('the decision uses what was observed by its time, not a report dated after it', async () => {
    const { w, auth, now } = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }]);
    await grant(w, 72);
    // a weekly limit reported for a time after this wake-up does not stand for it
    await recordQuota(pool, { provider: 'claude_agent', authProfileId: auth, bucket: 'weekly', eventKey: randomUUID(), observedAt: new Date(now + min(40)).toISOString(), data: { status: 'rejected', used_percent: 100, resets_at: new Date(now + min(600)).toISOString() } });
    expect(await wakeDueWaits(pool, { now: new Date(now + min(32)), probe: probeOf('allowed').p, jitterMs: jitter })).toEqual([{ job_id: w.jobId, decision: 'resumed', reason: null }]);
  });

  test('an unknown reset: bounded backoff, and only the provider\'s confirmation lets the job run', async () => {
    const { w, now } = await scenario([{ bucket: 'five_hour', resetsIn: null }]);
    await grant(w, 72);
    const [first] = await listQuotaWaits(pool, w.paperId, w.jobId);
    expect(first).toMatchObject({ reset_known: false });
    expect(new Date(first!.wake_at).getTime()).toBe(now + min(15) + 60_000);
    // the provider cannot tell: wait longer (doubling, bounded)
    let t = now + min(17);
    expect(await wakeDueWaits(pool, { now: new Date(t), probe: probeOf('unknown').p, jitterMs: jitter })).toEqual([{ job_id: w.jobId, decision: 'rescheduled', reason: 'availability_unknown' }]);
    let waits = await listQuotaWaits(pool, w.paperId, w.jobId);
    expect(new Date(waits.at(-1)!.wake_at).getTime()).toBe(t + min(30) + 60_000);
    // still limited
    t += min(32);
    expect(await wakeDueWaits(pool, { now: new Date(t), probe: probeOf('rejected').p, jitterMs: jitter })).toEqual([{ job_id: w.jobId, decision: 'rescheduled', reason: 'still_limited' }]);
    waits = await listQuotaWaits(pool, w.paperId, w.jobId);
    expect(new Date(waits.at(-1)!.wake_at).getTime()).toBe(t + min(60) + 60_000);
    expect((await status(w)).status).toBe('WAITING_QUOTA');
    // confirmed usable
    t += min(62);
    expect(await wakeDueWaits(pool, { now: new Date(t), probe: probeOf('allowed').p, jitterMs: jitter })).toEqual([{ job_id: w.jobId, decision: 'resumed', reason: null }]);
  });

  test('a known reset whose availability the provider cannot confirm resumes (the run itself is the check); an unknown one does not', async () => {
    const { w, now } = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }]);
    await grant(w, 72);
    expect(await wakeDueWaits(pool, { now: new Date(now + min(32)), probe: probeOf('unknown').p, jitterMs: jitter })).toEqual([{ job_id: w.jobId, decision: 'resumed', reason: null }]);
  });

  test('cancelled while waiting: closed, nothing queued, the provider not asked', async () => {
    const { w, now } = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }]);
    await grant(w, 72);
    await cancelJob(pool, { paperId: w.paperId, jobId: w.jobId, ownerId });
    const pr = probeOf('allowed');
    expect(await wakeDueWaits(pool, { now: new Date(now + min(32)), probe: pr.p, jitterMs: jitter })).toEqual([{ job_id: w.jobId, decision: 'closed', reason: 'job_cancelled' }]);
    expect(pr.calls).toEqual([]);
    expect((await status(w)).status).toBe('CANCELLED');
  });

  test('no permission, a revoked one or an expired one: the owner decides (WAITING_USER)', async () => {
    const a = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }]);
    expect(await wakeDueWaits(pool, { now: new Date(a.now + min(32)), probe: probeOf('allowed').p, jitterMs: jitter })).toEqual([{ job_id: a.w.jobId, decision: 'to_user', reason: 'auto_resume_not_allowed' }]);
    expect(await status(a.w)).toMatchObject({ status: 'WAITING_USER', last_error: expect.stringMatching(/auto-resume/) });
    const b = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }]);
    await grant(b.w, 2);
    await call('alice', 'POST', `/api/papers/${b.w.paperId}/jobs/${b.w.jobId}/auto-resume`, { intent: 'revoke_auto_resume' });
    expect((await wakeDueWaits(pool, { now: new Date(b.now + min(32)), probe: probeOf('allowed').p, jitterMs: jitter }))[0]).toMatchObject({ decision: 'to_user', reason: 'auto_resume_not_allowed' });
    const c = await scenario([{ bucket: 'five_hour', resetsIn: min(180) }]);
    await grant(c.w, 1);
    expect((await wakeDueWaits(pool, { now: new Date(c.now + min(182)), probe: probeOf('allowed').p, jitterMs: jitter }))[0]).toMatchObject({ decision: 'to_user', reason: 'auto_resume_expired' });
  });

  test('a lost login, a changed sending policy or a changed manuscript stop it', async () => {
    const a = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }]);
    await grant(a.w, 72);
    expect((await wakeDueWaits(pool, { now: new Date(a.now + min(32)), probe: probeOf('auth').p, jitterMs: jitter }))[0]).toMatchObject({ decision: 'to_auth' });
    expect((await status(a.w)).status).toBe('WAITING_AUTH');
    const b = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }]);
    await grant(b.w, 72);
    await pool.query("UPDATE paper_projects SET allowed_providers = '{codex}' WHERE id = $1", [b.w.paperId]);
    expect((await wakeDueWaits(pool, { now: new Date(b.now + min(32)), probe: probeOf('allowed').p, jitterMs: jitter }))[0]).toMatchObject({ decision: 'to_user', reason: 'policy_changed' });
    // the paragraph the draft was to follow is edited while the job waits
    const c = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }], { afterParagraph: true });
    await grant(c.w, 72);
    await call('alice', 'POST', `/api/papers/${c.w.paperId}/documents/${c.w.documentId}/saves`, { expected_head_revision_id: c.w.headId, content_json: { type: 'doc', content: [{ ...c.w.after, content: [{ type: 'text', text: 'ABC1 was measured by RNA-seq.' }] }] }, schema_version: 1, reason: 'manual' });
    expect((await wakeDueWaits(pool, { now: new Date(c.now + min(32)), probe: probeOf('allowed').p, jitterMs: jitter }))[0]).toMatchObject({ decision: 'stale', reason: 'document_changed' });
    expect((await status(c.w)).status).toBe('STALE');
  });

  test('waiting is bounded: after repeated reschedules the owner decides', async () => {
    const { w, now } = await scenario([{ bucket: 'five_hour', resetsIn: null }]);
    await grant(w, 72);
    let t = now;
    let last;
    for (let i = 0; i < 8; i++) {
      t += min(130);
      last = (await wakeDueWaits(pool, { now: new Date(t), probe: probeOf('unknown').p, jitterMs: jitter }))[0];
      if (last?.decision === 'to_user') break;
    }
    expect(last).toMatchObject({ decision: 'to_user', reason: 'waited_too_long' });
    expect((await listQuotaWaits(pool, w.paperId, w.jobId)).length).toBe(6);
  });

  test('only the job\'s current run enters a wait; a due wait is decided once', async () => {
    const w = await world();
    await expect(enterQuotaWait(pool, { paperId: w.paperId, jobId: w.jobId, fencingToken: 1, provider: 'claude_agent', authProfileId: 'default', now: new Date(), jitterMs: jitter })).rejects.toMatchObject({ code: 'CONFLICT' });
    const { w: w2, now } = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }]);
    await grant(w2, 72);
    const [d1, d2] = await Promise.all([1, 2].map(() => wakeDueWaits(pool, { now: new Date(now + min(32)), probe: probeOf('allowed').p, jitterMs: jitter })));
    expect([...d1!, ...d2!]).toEqual([{ job_id: w2.jobId, decision: 'resumed', reason: null }]);
  });
});

// PW-049 review (approve with MINOR/NIT): m2, m3, m4, n1, n2
describe('PW-049 review fixes', () => {
  test('m2: a bucket still blocked without a reset needs the provider\'s confirmation for the whole login', async () => {
    const { w, auth, now } = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }]);
    await grant(w, 72);
    await recordQuota(pool, { provider: 'claude_agent', authProfileId: auth, bucket: 'weekly', eventKey: randomUUID(), observedAt: new Date(now + min(1)).toISOString(), data: { status: 'rejected', used_percent: 100, resets_at: null } });
    // the five-hour window reset, the weekly one did not: "cannot tell" is not enough
    expect(await wakeDueWaits(pool, { now: new Date(now + min(32)), probe: probeOf('unknown').p, jitterMs: jitter })).toEqual([{ job_id: w.jobId, decision: 'rescheduled', reason: 'availability_unknown' }]);
    // the provider confirms the login can be used now (the Probe contract: every limit of this login)
    const next = (await listQuotaWaits(pool, w.paperId, w.jobId)).at(-1)!;
    expect(await wakeDueWaits(pool, { now: new Date(new Date(next.wake_at).getTime() + 1), probe: probeOf('allowed').p, jitterMs: jitter })).toEqual([{ job_id: w.jobId, decision: 'resumed', reason: null }]);
  });

  test('m3: what the owner is told does not offer a step that does not exist', async () => {
    const a = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }]);
    await wakeDueWaits(pool, { now: new Date(a.now + min(32)), probe: probeOf('allowed').p, jitterMs: jitter });
    const s = await status(a.w);
    expect(s.last_error).not.toMatch(/resume or cancel/);
    expect(s.last_error).toMatch(/ask again|cancel/);
  });

  test('m4: an edit elsewhere in the manuscript does not end the wait; a change at the job\'s own place does', async () => {
    const a = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }]);
    await grant(a.w, 72);
    // the draft goes at the end (no place chosen): a new paragraph does not move its place
    await call('alice', 'POST', `/api/papers/${a.w.paperId}/documents/${a.w.documentId}/saves`, { expected_head_revision_id: a.w.headId, content_json: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text: 'typed meanwhile' }] }] }, schema_version: 1, reason: 'manual' });
    expect((await wakeDueWaits(pool, { now: new Date(a.now + min(32)), probe: probeOf('allowed').p, jitterMs: jitter }))[0]).toMatchObject({ decision: 'resumed' });
  });

  test('n1: the provider is asked while nothing is locked', async () => {
    const { w, now } = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }]);
    await grant(w, 72);
    let lockedDuringProbe = true;
    const probe: Probe = async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SET LOCAL lock_timeout = '200ms'");
        await c.query('SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE', [w.jobId]);
        await c.query("SELECT 1 FROM quota_waits WHERE job_id = $1 AND state = 'waiting' FOR UPDATE", [w.jobId]);
        lockedDuringProbe = false;
      } finally { await c.query('ROLLBACK'); c.release(); }
      return 'allowed';
    };
    expect((await wakeDueWaits(pool, { now: new Date(now + min(32)), probe, jitterMs: jitter }))[0]).toMatchObject({ decision: 'resumed' });
    expect(lockedDuringProbe).toBe(false);
  });

  test('n2: a wait left open by a lost run is closed when the next run hits the quota again', async () => {
    const { w, auth, now } = await scenario([{ bucket: 'five_hour', resetsIn: min(30) }]);
    // as if the run that entered the wait lost its lease before the job became WAITING_QUOTA
    await pool.query("UPDATE jobs SET status = 'QUEUED', last_error = 'lease lost' WHERE id = $1", [w.jobId]);
    const writer: Writer = { id: 'mock', label: 'MOCK', async write() { throw new QuotaExceeded('usage limit reached', { provider: 'claude_agent', authProfileId: auth }); } };
    const out = await processDelivery(pool, { job_id: w.jobId, paper_id: w.paperId, intent: 'draft_paragraph' }, { workerId: 'w2', leaseMs: 60_000, handlers: withQuotaWaits(pool, writerHandlers(pool, writer), { jitterMs: jitter, now: () => new Date(now + min(1)) }) });
    expect(out.outcome).toBe('failed');
    expect((await status(w)).status).toBe('WAITING_QUOTA');
    expect((await listQuotaWaits(pool, w.paperId, w.jobId)).map((x) => [x.attempt, x.state, x.reason])).toEqual([[1, 'closed', 'superseded'], [2, 'waiting', null]]);
  });
});
