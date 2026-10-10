// PW-048 — context budget and switching at a safe boundary (spec 08 "Context builder", "압축 시점").
// A multi-turn job runs its steps on one provider session while the request budget allows; near the
// limit it switches at a safe boundary: checkpoint → compaction confirmed by the provider (only where
// manual_compact is verified) or a new session started from the rehydrated state (PW-047) → re-check →
// the next step.
// TST-048A: with verified compaction the same session continues after the provider confirms it; without
//   (unsupported, unknown, documented but not verified) a new session continues the same job.
// TST-048B: cumulative billed tokens are never the context occupancy; no turn starts while the previous
//   one has not completed (a tool may still run) or while a compaction is not confirmed.
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
import { claimJob } from '../../../packages/domain/src/jobs/index.ts';
import { listCheckpoints } from '../../../packages/domain/src/checkpoints/index.ts';
import { jobCheckpoints } from '../../../apps/worker/src/checkpoints/index.ts';
import { JobOutcomeError } from '../../../apps/worker/src/queue/index.ts';
import { TurnIncomplete, canStartTurn, listContextSwitches, readContext, requestBudget, runJobTurns, type ContextSession } from '../../../apps/worker/src/context/index.ts';
import type { ProviderEvent } from '../../../packages/contracts/src/provider/index.ts';

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

// an approved story, plan, fact and claim, and a claimed (RUNNING) job for the plan
async function world() {
  const p = (await call('POST', '/api/papers', { working_title: 'context paper', article_type: 'research_article' })).json();
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
  const o = (await call('POST', `/api/papers/${p.id}/outline/revisions`, { parent_revision_id: null, story_revision_id: s.id, nodes: [{ node_id: nodeId, parent_node_id: null, section: 'Results', role: 'result', paragraph_goal: 'Root induction', claim_ids: [c.id], evidence_ids: [e.id], requires_evidence: false, allowed_interpretation: '', exclusions: [], transition: '', word_budget_min: null, word_budget_max: null }] })).json();
  await call('POST', `/api/papers/${p.id}/outline/revisions/${o.id}/approve`, { intent: 'approve_outline', content_hash: o.content_hash });
  const d = (await call('POST', `/api/papers/${p.id}/documents`, { kind: 'manuscript' })).json();
  const r = await call('POST', `/api/papers/${p.id}/writer/requests`, { mode: 'draft', outline_revision_id: o.id, node_id: nodeId, document_id: d.document.id, base_revision_id: d.head.id, idempotency_key: randomUUID() });
  const claimed = (await claimJob(pool, { jobId: r.json().job.id, workerId: 'w1', leaseMs: 60_000 }))!;
  const cps = jobCheckpoints(pool, claimed.job, claimed.fencingToken, { provider: 'codex' });
  cps.setScope({ outline_revision_id: o.id, node_id: nodeId, fact_ids: [f!.id], claim_ids: [c.id], evidence_ids: [e.id] });
  return { paperId: p.id as string, job: claimed.job, fencingToken: claimed.fencingToken, cps, outlineId: o.id as string, nodeId };
}

const ev = <K extends ProviderEvent['kind']>(kind: K, data: Extract<ProviderEvent, { kind: K }>['data']) => ({ schema_version: 1, provider: 'codex', kind, data }) as ProviderEvent;
const usage = (scope: 'message' | 'turn' | 'session', input: number, window: number | null = null) => ev('usage', { scope, input_tokens: input, output_tokens: 100, cost_usd_estimate: null, context_window: window, unknown_fields: [] });
const done = ev('turn_completed', { outcome: 'success', stop_reason: 'end_turn' });

// a fake provider session: each turn reports its (current) request size; compaction confirms or not
function fakeSessions(o: { sizes: (number | null)[]; window?: number | null; confirmCompact?: boolean | 'error'; cumulative?: boolean; breakTurn?: number }) {
  const log: string[] = [];
  const starts: string[] = [];
  let turnNo = 0;
  const make = (id: string): ContextSession => ({
    id,
    async *turn(prompt: string) {
      const n = turnNo++;
      log.push(`${id}:turn:${prompt}`);
      yield ev('message_completed', { text: `answer ${n}` });
      if (o.breakTurn === n) return; // the stream ends mid-turn (a tool still running, a crash): no turn_completed
      // the current request size (message scope); cumulative billing totals come as turn/session scope
      // null: this turn reports no size
      if (o.sizes[n] !== null) yield usage('message', o.sizes[n] ?? 1000, o.window ?? null);
      if (o.cumulative) { yield usage('turn', 10_000_000); yield usage('session', 50_000_000, o.window ?? null); }
      yield done;
    },
    async *compact() {
      log.push(`${id}:compact`);
      if (o.confirmCompact === 'error') yield ev('error', { kind: 'provider', message: 'compaction failed' });
      else if (o.confirmCompact) yield ev('compacted', {});
    },
  });
  return {
    log, starts,
    factory: { async start(prompt: string) { const id = `s${starts.length + 1}`; starts.push(prompt); log.push(`${id}:start`); return make(id); } },
  };
}
const steps = ['draft_intro', 'draft_results', 'draft_discussion', 'draft_conclusion'].map((name) => ({ name, prompt: name }));
const opts = { outputReserve: 4_000, safetyMargin: 2_000, nextPromptTokens: 1_000 };

describe('TST-048A: near the limit the job continues — compacted where verified, else in a new session', () => {
  test('verified compaction: checkpoint, compaction confirmed by the provider, the same session continues', async () => {
    const w = await world();
    const f = fakeSessions({ sizes: [40_000, 85_000, 20_000, 25_000], window: 100_000, confirmCompact: true });
    const out = await runJobTurns(pool, { ...w, factory: f.factory, compactSupport: 'verified', window: null, steps, initialPrompt: 'start', ...opts });
    expect(out.completed).toEqual(['draft_intro', 'draft_results', 'draft_discussion', 'draft_conclusion']);
    // after draft_results the session holds 85% of the window: compacted before the next step
    expect(f.log).toEqual(['s1:start', 's1:turn:draft_intro', 's1:turn:draft_results', 's1:compact', 's1:turn:draft_discussion', 's1:turn:draft_conclusion']);
    const sw = await listContextSwitches(pool, w.paperId, w.job.id);
    expect(sw.map((x) => x.kind)).toEqual(['compact_requested', 'compact_confirmed']);
    expect(sw[0]).toMatchObject({ from_session: 's1', context_window: 100_000, input_tokens: 85_000, input_source: 'provider_reported' });
    expect(Number(sw[0]!.occupancy)).toBeCloseTo(0.85);
    // a checkpoint at the boundary, before compaction (pending: the next step)
    const cps = await listCheckpoints(pool, w.paperId, w.job.id);
    expect(cps.find((c) => c.boundary === 'session_change')).toMatchObject({ pending_step: 'draft_discussion' });
    expect(sw[0]!.checkpoint_id).toBe(cps.find((c) => c.boundary === 'session_change')!.id);
  });

  for (const support of ['unsupported', 'unknown', 'documented_not_verified'] as const) {
    test(`compaction ${support}: checkpoint, a new session from the rehydrated state, the same job continues`, async () => {
      const w = await world();
      const f = fakeSessions({ sizes: [40_000, 85_000, 20_000, 25_000], window: 100_000, confirmCompact: true });
      const out = await runJobTurns(pool, { ...w, factory: f.factory, compactSupport: support, window: null, steps, initialPrompt: 'start', ...opts });
      expect(out.completed).toHaveLength(4);
      expect(f.log).toEqual(['s1:start', 's1:turn:draft_intro', 's1:turn:draft_results', 's2:start', 's2:turn:draft_discussion', 's2:turn:draft_conclusion']);
      // the new session starts from the database: approved story, verified fact, the pending step
      expect(f.starts[1]).toContain(NOVELTY);
      expect(f.starts[1]).toContain('2.4');
      expect(f.starts[1]).toContain('pending step: draft_discussion');
      const sw = await listContextSwitches(pool, w.paperId, w.job.id);
      expect(sw.map((x) => [x.kind, x.from_session, x.to_session])).toEqual([['session_replaced', 's1', 's2']]);
    });
  }

  test('a compaction the provider does not confirm is not trusted: no turn on it, a new session instead', async () => {
    const w = await world();
    const f = fakeSessions({ sizes: [40_000, 85_000, 20_000, 25_000], window: 100_000, confirmCompact: false });
    await runJobTurns(pool, { ...w, factory: f.factory, compactSupport: 'verified', window: null, steps, initialPrompt: 'start', ...opts });
    expect(f.log).toEqual(['s1:start', 's1:turn:draft_intro', 's1:turn:draft_results', 's1:compact', 's2:start', 's2:turn:draft_discussion', 's2:turn:draft_conclusion']);
    expect((await listContextSwitches(pool, w.paperId, w.job.id)).map((x) => x.kind)).toEqual(['compact_requested', 'compact_failed', 'session_replaced']);
  });

  test('a compaction stream that reports anything but its confirmation is not a compaction', async () => {
    const w = await world();
    const f = fakeSessions({ sizes: [40_000, 85_000, 20_000, 25_000], window: 100_000, confirmCompact: 'error' });
    await runJobTurns(pool, { ...w, factory: f.factory, compactSupport: 'verified', window: null, steps, initialPrompt: 'start', ...opts });
    expect((await listContextSwitches(pool, w.paperId, w.job.id)).map((x) => x.kind)).toEqual(['compact_requested', 'compact_failed', 'session_replaced']);
  });

  test('readings from before a switch do not count after it (a turn without a size report does not re-trigger it)', async () => {
    const w = await world();
    const f = fakeSessions({ sizes: [40_000, 85_000, null, 25_000], window: 100_000, confirmCompact: true });
    await runJobTurns(pool, { ...w, factory: f.factory, compactSupport: 'verified', window: null, steps, initialPrompt: 'start', ...opts });
    expect((await listContextSwitches(pool, w.paperId, w.job.id)).map((x) => x.kind)).toEqual(['compact_requested', 'compact_confirmed']);
  });

  test('a next turn that would not fit switches even below 80%; 70% records a checkpoint for review', async () => {
    const w = await world();
    const f = fakeSessions({ sizes: [72_000, 20_000, 20_000, 20_000], window: 100_000 });
    // 72% + a 25k tool payload expected for the next step: does not fit → switch
    const s2 = steps.map((s, i) => (i === 1 ? { ...s, expectedToolPayload: 25_000 } : s));
    await runJobTurns(pool, { ...w, factory: f.factory, compactSupport: 'unsupported', window: null, steps: s2, initialPrompt: 'start', ...opts });
    expect(f.log.slice(0, 4)).toEqual(['s1:start', 's1:turn:draft_intro', 's2:start', 's2:turn:draft_results']);
    const w2 = await world();
    const g = fakeSessions({ sizes: [72_000, 20_000, 20_000, 20_000], window: 100_000 });
    await runJobTurns(pool, { ...w2, factory: g.factory, compactSupport: 'unsupported', window: null, steps, initialPrompt: 'start', ...opts });
    expect(g.starts).toHaveLength(1);
    expect((await listContextSwitches(pool, w2.paperId, w2.job.id)).map((x) => x.kind)).toEqual(['checkpoint_review']);
  });

  test('after a switch the job is re-checked: a change since the checkpoint stops it before the next step', async () => {
    const w = await world();
    const f = fakeSessions({ sizes: [40_000, 85_000, 20_000, 25_000], window: 100_000 });
    let changed = false;
    const factory = { async start(p: string) {
      if (f.starts.length === 1 && !changed) { changed = true; await pool.query("UPDATE paper_projects SET external_send_policy = 'allow_selected', allowed_providers = '{claude_agent}' WHERE id = $1", [w.paperId]); }
      return f.factory.start(p);
    } };
    const err = await runJobTurns(pool, { ...w, factory, compactSupport: 'unsupported', window: null, steps, initialPrompt: 'start', ...opts }).catch((e) => e);
    expect(err).toBeInstanceOf(JobOutcomeError);
    expect(err.next).toBe('WAITING_USER');
    expect(f.log).not.toContain('s2:turn:draft_discussion');
  });
});

describe('TST-048B: occupancy is the current request, and no turn starts on an unfinished one', () => {
  test('cumulative turn/session totals are billing, not occupancy; the window may come from any report', () => {
    const r = readContext([usage('message', 30_000), usage('turn', 900_000), usage('session', 4_000_000, 128_000)], { window: null });
    expect(r).toEqual({ context_window: 128_000, current_input: 30_000, source: 'provider_reported' });
    expect(requestBudget(r, opts)).toMatchObject({ occupancy: 30_000 / 128_000, state: 'ok', available: 128_000 - 30_000 - 1_000 - 0 - 4_000 - 2_000 });
    // no message-scope report: estimated from the prompt, marked as such; no window: UNKNOWN, no percent
    expect(readContext([usage('session', 4_000_000)], { window: 100_000, promptChars: 40_000 })).toEqual({ context_window: 100_000, current_input: 10_000, source: 'estimated' });
    const u = readContext([usage('turn', 900_000)], { window: null });
    expect(u).toEqual({ context_window: null, current_input: null, source: 'unknown' });
    expect(requestBudget(u, opts)).toEqual({ available: null, occupancy: null, state: 'unknown', unknown: ['context_window', 'current_input'] });
  });

  test('cumulative totals in the stream do not trigger a switch', async () => {
    const w = await world();
    const f = fakeSessions({ sizes: [20_000, 20_000, 20_000, 20_000], window: 100_000, cumulative: true });
    await runJobTurns(pool, { ...w, factory: f.factory, compactSupport: 'unsupported', window: null, steps, initialPrompt: 'start', ...opts });
    expect(f.starts).toHaveLength(1);
    expect(await listContextSwitches(pool, w.paperId, w.job.id)).toEqual([]);
  });

  test('a turn that did not complete (its stream ended mid-turn) stops the job before the next step', async () => {
    const w = await world();
    const f = fakeSessions({ sizes: [20_000, 20_000, 20_000, 20_000], window: 100_000, breakTurn: 1 });
    const err = await runJobTurns(pool, { ...w, factory: f.factory, compactSupport: 'unsupported', window: null, steps, initialPrompt: 'start', ...opts }).catch((e) => e);
    // not a final outcome: the queue retries the job from its checkpoint
    expect(err).toBeInstanceOf(TurnIncomplete);
    expect(err).not.toBeInstanceOf(JobOutcomeError);
    expect(err.message).toMatch(/did not complete/);
    expect(f.log).toEqual(['s1:start', 's1:turn:draft_intro', 's1:turn:draft_results']);
  });

  test('the boundary gate: an open turn, an open tool call or an unconfirmed compaction blocks the next turn', () => {
    expect(canStartTurn({ turnOpen: false, openToolCalls: 0, compaction: 'none' })).toEqual({ ok: true });
    expect(canStartTurn({ turnOpen: true, openToolCalls: 0, compaction: 'none' })).toEqual({ ok: false, reason: 'turn_in_progress' });
    expect(canStartTurn({ turnOpen: false, openToolCalls: 1, compaction: 'none' })).toEqual({ ok: false, reason: 'tool_call_open' });
    expect(canStartTurn({ turnOpen: false, openToolCalls: 0, compaction: 'requested' })).toEqual({ ok: false, reason: 'compaction_unconfirmed' });
    expect(canStartTurn({ turnOpen: false, openToolCalls: 0, compaction: 'confirmed' })).toEqual({ ok: true });
  });

  test('only the job\'s current run records switches', async () => {
    const w = await world();
    const f = fakeSessions({ sizes: [40_000, 85_000], window: 100_000 });
    const err = await runJobTurns(pool, { ...w, fencingToken: w.fencingToken - 1, factory: f.factory, compactSupport: 'unsupported', window: null, steps: steps.slice(0, 3), initialPrompt: 'start', ...opts }).catch((e) => e);
    expect(err).toMatchObject({ code: 'CONFLICT' });
  });
});
