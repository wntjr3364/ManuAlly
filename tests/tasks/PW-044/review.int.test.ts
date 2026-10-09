// PW-044 — scientific and writing review with the owner's decision, and one bounded repair (spec 06
// "검증 층" B·C·D, "writer와 reviewer는 역할/context를 분리 … 최대 repair 1회").
// TST-044A: a reviewer's findings name an exact span of the paragraph, a reason, the record they rest
//   on (claim, fact, evidence, profile rule or a deterministic check) with a confidence, and an
//   alternative; nothing changes until the owner accepts or dismisses each one, and a repair from the
//   accepted findings is only another proposal the owner applies.
// TST-044B: there is no quality score or word blacklist (a score is refused, "Furthermore" is not a
//   finding by itself), a same-model review is labelled as such, and the repair runs at most once per
//   review — a failing repair goes back to the owner, never into a loop.
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
import { processDelivery } from '../../../apps/worker/src/queue/index.ts';
import { reviewerHandlers, createMockReviewer, type Reviewer, type ReviewInput } from '../../../apps/worker/src/reviewer/index.ts';
import { writerHandlers, createMockWriter, type Writer } from '../../../apps/worker/src/writer/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
const H: Record<string, Record<string, string>> = {};
const ids: Record<string, string> = {};
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  for (const u of ['alice', 'bob']) {
    ids[u] = (await createOwner(pool, { username: u, password: 'correct horse battery' })).id;
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
const node = (o: Record<string, unknown>) => ({ node_id: randomUUID(), parent_node_id: null, section: 'Results', role: 'result', paragraph_goal: 'goal', claim_ids: [], evidence_ids: [], requires_evidence: false, allowed_interpretation: '', exclusions: [], transition: '', word_budget_min: null, word_budget_max: null, ...o });
const P1 = randomUUID();
const TEXT = 'Under drought, ABC1 rose 2.4-fold in roots (n = 3), which demonstrates that ABC1 causes drought tolerance.';
const OVERCLAIM = 'demonstrates that ABC1 causes drought tolerance';

async function world(text = TEXT) {
  const owner = ids.alice!;
  const paperId = (await call('alice', 'POST', '/api/papers', { working_title: 'review paper', article_type: 'research_article' })).json().id as string;
  const s = (await call('alice', 'POST', `/api/papers/${paperId}/story/revisions`, { parent_revision_id: null, brief: { purpose: 'Test ABC1', audience: 'x', known_facts: [], missing_material: [], avoid_claims: [] }, story: { question: 'q', main_message: 'm', novelty: 'n', evidence_links: [], competing_explanations: [], presentation_order: [], limitations: [] } })).json();
  await call('alice', 'POST', `/api/papers/${paperId}/story/revisions/${s.id}/approve`, { intent: 'approve_story', content_hash: s.content_hash });
  const e = await createEvidence(pool, { paperId, ownerId: owner, body: { kind: 'experiment', locator: { note: 'plate 3' }, label: 'roots qPCR' } });
  await reviewEvidence(pool, { paperId, ownerId: owner, id: e.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: e.content_hash } });
  const [f] = await createFactCandidates(pool, { paperId, ownerId: owner, origin: 'user', single: true, facts: [{ evidence_id: e.id, entity: 'ABC1 roots', metric: 'fold change', value_text: '2.4', unit: 'fold', group: 'drought', comparison: 'control', n: 3, extraction_method: 'manual_entry' }] });
  await reviewFact(pool, { paperId, ownerId: owner, id: f!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: f!.content_hash } });
  const c = await createClaim(pool, { paperId, ownerId: owner, body: { kind: 'observation', text: 'ABC1 rises in roots under drought.' } });
  await linkClaimEvidence(pool, { paperId, ownerId: owner, claimId: c.id, body: { evidence_id: e.id, relation: 'supports' } });
  const c1 = await approveClaim(pool, { paperId, ownerId: owner, id: c.id, body: { intent: 'approve_claim', content_hash: c.content_hash } });
  const n1 = node({ paragraph_goal: 'Root induction', claim_ids: [c1.id], evidence_ids: [e.id] });
  const o = (await call('alice', 'POST', `/api/papers/${paperId}/outline/revisions`, { parent_revision_id: null, story_revision_id: s.id, nodes: [n1] })).json();
  await call('alice', 'POST', `/api/papers/${paperId}/outline/revisions/${o.id}/approve`, { intent: 'approve_outline', content_hash: o.content_hash });
  const d = (await call('alice', 'POST', `/api/papers/${paperId}/documents`, { kind: 'manuscript' })).json();
  const content = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P1 }, content: [{ type: 'text', text }] }] };
  const head = (await call('alice', 'POST', `/api/papers/${paperId}/documents/${d.document.id}/saves`, { expected_head_revision_id: d.head.id, content_json: content, schema_version: 1, reason: 'manual' })).json().id as string;
  await call('alice', 'POST', `/api/papers/${paperId}/outline/revisions/${o.id}/nodes/${n1.node_id}/paragraphs`, { document_id: d.document.id, block_id: P1 });
  return { paperId, owner, e, f: f!, c1, n1, outlineId: o.id as string, documentId: d.document.id as string, head };
}
type W = Awaited<ReturnType<typeof world>>;
const spy = (answer: (i: ReviewInput) => unknown, id: Reviewer['id'] = 'mock'): Reviewer & { seen: ReviewInput[] } => {
  const seen: ReviewInput[] = [];
  return { id, label: id === 'mock' ? 'MOCK' : id, seen, async review(i) { seen.push(i); return answer(i); } };
};
type Finding = { id: string; kind: string; category: string; quote: string; start: number; end: number; reason: string; source: { kind: string; id: string } | null; confidence: string; alternative: string | null; warnings: string[]; decision: string };
type Run = { id: string; job_id: string; status: string; independence: string; generator_label: string; findings: Finding[]; dropped: { reason: string }[]; repair: null | { job_id: string; proposal_status: string | null; proposal_id: string | null; needs_user: boolean } };
async function review(w: W, gen: Reviewer = createMockReviewer(), revisionId = w.head) {
  const r = await call('alice', 'POST', `/api/papers/${w.paperId}/reviews`, { document_id: w.documentId, revision_id: revisionId, block_id: P1, idempotency_key: randomUUID() });
  expect(r.statusCode, r.body).toBe(201);
  const jobId = r.json().job.id as string;
  await processDelivery(pool, { job_id: jobId, paper_id: w.paperId, intent: 'review' }, { workerId: 'w1', leaseMs: 60_000, handlers: reviewerHandlers(pool, gen) });
  const job = (await pool.query('SELECT status, last_error FROM jobs WHERE id = $1', [jobId])).rows[0];
  const runs = (await call('alice', 'GET', `/api/papers/${w.paperId}/reviews?document_id=${w.documentId}&block_id=${P1}`)).json() as Run[];
  return { job, run: runs.find((x) => x.job_id === jobId) ?? null };
}
const overclaim = (i: ReviewInput) => ({
  kind: 'scientific', category: 'causal_language', quote: OVERCLAIM, reason: 'An induction under drought is an observation; it does not show that ABC1 causes tolerance.',
  source: { kind: 'claim', id: i.claims[0]!.id }, confidence: 'high', alternative: 'is consistent with a role of ABC1 in the drought response',
});
const decide = (w: W, f: Finding, decision: string, who = 'alice', extra: Record<string, unknown> = {}) =>
  call(who, 'POST', `/api/papers/${w.paperId}/reviews/findings/${f.id}/decide`, { intent: 'decide_finding', decision, ...extra });
const repair = (w: W, run: Run) => call('alice', 'POST', `/api/papers/${w.paperId}/reviews/${run.id}/repair`, { intent: 'repair_paragraph', idempotency_key: randomUUID() });
async function runRepair(w: W, jobId: string, writer: Writer = createMockWriter()) {
  await processDelivery(pool, { job_id: jobId, paper_id: w.paperId, intent: 'draft_paragraph' }, { workerId: 'w1', leaseMs: 60_000, handlers: writerHandlers(pool, writer) });
}

describe('TST-044A: findings with span, reason, source, confidence and alternative; the owner decides', () => {
  test('the reviewer sees the paragraph, its plan\'s claims and facts, the deterministic check and the style; a finding is stored with its exact span', async () => {
    const w = await world();
    const g = spy((i) => ({ findings: [overclaim(i)] }));
    const { run } = await review(w, g);
    const input = g.seen[0]!;
    expect(input.paragraph_text).toBe(TEXT);
    expect(input).toMatchObject({ section: 'Results', purpose: 'Root induction' });
    expect(input.claims.map((c) => c.id)).toEqual([w.c1.id]);
    expect(input.facts.map((f) => f.id)).toEqual([w.f.id]);
    expect(input.gate.status).toBe('VERIFIED');
    expect(run).toMatchObject({ status: 'DONE', independence: 'human_written', generator_label: 'MOCK', dropped: [], repair: null });
    expect(run!.findings).toEqual([expect.objectContaining({
      kind: 'scientific', category: 'causal_language', quote: OVERCLAIM, start: TEXT.indexOf(OVERCLAIM), end: TEXT.indexOf(OVERCLAIM) + OVERCLAIM.length,
      source: { kind: 'claim', id: w.c1.id }, confidence: 'high', alternative: 'is consistent with a role of ABC1 in the drought response', decision: 'open', warnings: [],
    })]);
    // a review changes nothing
    expect((await pool.query('SELECT head_revision_id FROM documents WHERE id = $1', [w.documentId])).rows[0].head_revision_id).toBe(w.head);
  });

  test('a finding without an exact span or with a source the reviewer was not given is dropped with the reason; an alternative with a new number is flagged', async () => {
    const w = await world();
    const { run } = await review(w, spy((i) => ({ findings: [
      { ...overclaim(i), quote: 'proves that ABC1 is essential' },
      { ...overclaim(i), quote: 'ABC1' },
      { ...overclaim(i), source: { kind: 'fact', id: randomUUID() } },
      { ...overclaim(i), kind: 'writing', category: 'concision', quote: 'which demonstrates that', source: null, confidence: 'low', alternative: 'showing a 5-fold effect' },
    ] })));
    expect(run!.dropped.map((d) => d.reason)).toEqual(['span_not_found', 'span_ambiguous', 'unknown_source']);
    expect(run!.findings).toHaveLength(1);
    expect(run!.findings[0]).toMatchObject({ kind: 'writing', category: 'concision', warnings: ['alternative_number_not_in_evidence:5'] });
  });

  test('the owner accepts or dismisses each finding once (intent needed; another owner gets 404); the manuscript does not change', async () => {
    const w = await world();
    const { run } = await review(w, spy((i) => ({ findings: [overclaim(i), { ...overclaim(i), kind: 'writing', category: 'concision', quote: 'Under drought', source: null, confidence: 'low', alternative: null, reason: 'The condition could follow the result for flow.' }] })));
    const [a, b] = run!.findings;
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/reviews/findings/${a!.id}/decide`, { decision: 'accepted' })).statusCode).toBe(422);
    expect((await decide(w, a!, 'maybe')).statusCode).toBe(422);
    expect((await decide(w, a!, 'accepted', 'bob')).statusCode).toBe(404);
    expect((await decide(w, a!, 'accepted')).statusCode).toBe(200);
    expect((await decide(w, a!, 'dismissed')).statusCode).toBe(409);
    expect((await decide(w, b!, 'dismissed', 'alice', { note: 'I prefer this order' })).json()).toMatchObject({ decision: 'dismissed', note: 'I prefer this order' });
    expect((await pool.query('SELECT head_revision_id FROM documents WHERE id = $1', [w.documentId])).rows[0].head_revision_id).toBe(w.head);
  });

  test('a repair from the accepted findings is one writer proposal for that paragraph; the owner applies it', async () => {
    const w = await world();
    const { run } = await review(w, spy((i) => ({ findings: [overclaim(i)] })));
    expect((await repair(w, run!)).statusCode).toBe(422); // nothing accepted yet
    await decide(w, run!.findings[0]!, 'accepted');
    const r = await repair(w, run!);
    expect(r.statusCode, r.body).toBe(201);
    const seen: string[] = [];
    await runRepair(w, r.json().job.id, { id: 'mock', label: 'MOCK', async write(c) {
      seen.push(c.instruction);
      return { status: 'draft', paragraph: [{ type: 'text', text: TEXT.replace(OVERCLAIM, 'is consistent with a role of ABC1 in the drought response') }], claim_ids: [], fact_ids: [] };
    } });
    expect(seen[0]).toContain(OVERCLAIM);
    expect(seen[0]).toContain('is consistent with a role of ABC1 in the drought response');
    const after = ((await call('alice', 'GET', `/api/papers/${w.paperId}/reviews?document_id=${w.documentId}&block_id=${P1}`)).json() as Run[])[0]!;
    expect(after.repair).toMatchObject({ proposal_status: 'PENDING', needs_user: false });
    const p = (await call('alice', 'GET', `/api/papers/${w.paperId}/writer/proposals/${after.repair!.proposal_id}`)).json();
    expect(p).toMatchObject({ mode: 'rewrite', block_id: P1 });
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/writer/proposals/${p.id}/apply`, { intent: 'apply_paragraph', proposal_hash: p.proposal_hash, expected_revision_id: p.base_revision_id })).statusCode).toBe(200);
  });
});

describe('TST-044B: no score, no blacklist, labelled self-review, one repair', () => {
  test('a quality score or any field outside a finding is refused; nothing is stored', async () => {
    const w = await world();
    for (const bad of [
      (i: ReviewInput) => ({ findings: [overclaim(i)], quality_score: 0.92 }),
      (i: ReviewInput) => ({ findings: [{ ...overclaim(i), score: 7 }] }),
      (i: ReviewInput) => ({ findings: [{ ...overclaim(i), confidence: 0.9 }] }),
      (i: ReviewInput) => ({ findings: [{ ...overclaim(i), category: 'banned_word' }] }),
    ]) {
      const { job, run } = await review(w, spy(bad));
      expect(job.status).toBe('FAILED');
      expect(run).toBeNull();
    }
  });

  test('the MOCK reviewer does not flag a word by itself ("Furthermore"); it flags causal language over an observation', async () => {
    const plain = await world('Furthermore, under drought ABC1 rose 2.4-fold in roots (n = 3).');
    expect((await review(plain)).run!.findings).toEqual([]);
    const w = await world();
    const { run } = await review(w);
    expect(run!.findings.map((f) => [f.category, f.source?.kind])).toEqual([['causal_language', 'claim']]);
  });

  test('a review by the model that wrote the paragraph is labelled same_model', async () => {
    const w = await world('ABC1 was measured by qPCR.');
    const req = await call('alice', 'POST', `/api/papers/${w.paperId}/writer/requests`, { mode: 'draft', outline_revision_id: w.outlineId, node_id: w.n1.node_id, document_id: w.documentId, base_revision_id: w.head, after_block_id: P1, idempotency_key: randomUUID() });
    await runRepair(w, req.json().job.id);
    const p = (await call('alice', 'GET', `/api/papers/${w.paperId}/writer/proposals?document_id=${w.documentId}`)).json()[0];
    const applied = (await call('alice', 'POST', `/api/papers/${w.paperId}/writer/proposals/${p.id}/apply`, { intent: 'apply_paragraph', proposal_hash: p.proposal_hash, expected_revision_id: p.base_revision_id })).json();
    const r = await call('alice', 'POST', `/api/papers/${w.paperId}/reviews`, { document_id: w.documentId, revision_id: applied.revision_id, block_id: applied.block_id, idempotency_key: randomUUID() });
    await processDelivery(pool, { job_id: r.json().job.id, paper_id: w.paperId, intent: 'review' }, { workerId: 'w1', leaseMs: 60_000, handlers: reviewerHandlers(pool, createMockReviewer()) });
    const runs = (await call('alice', 'GET', `/api/papers/${w.paperId}/reviews?document_id=${w.documentId}&block_id=${applied.block_id}`)).json() as Run[];
    expect(runs[0]!.independence).toBe('same_model');
  });

  test('one repair per review: a second is refused; a repair that fails its checks goes back to the owner, no new attempt is made', async () => {
    const w = await world();
    const { run } = await review(w, spy((i) => ({ findings: [overclaim(i)] })));
    await decide(w, run!.findings[0]!, 'accepted');
    const r = await repair(w, run!);
    expect((await repair(w, run!)).statusCode).toBe(409);
    // the writer's repair changes a number: the proposal fails its checks
    await runRepair(w, r.json().job.id, { id: 'mock', label: 'MOCK', async write() { return { status: 'draft', paragraph: [{ type: 'text', text: TEXT.replace('2.4', '3.1').replace(OVERCLAIM, 'is consistent with a role of ABC1') }], claim_ids: [], fact_ids: [] }; } });
    const after = ((await call('alice', 'GET', `/api/papers/${w.paperId}/reviews?document_id=${w.documentId}&block_id=${P1}`)).json() as Run[])[0]!;
    expect(after.repair).toMatchObject({ proposal_status: 'CHECK_FAILED', needs_user: true });
    expect((await pool.query("SELECT count(*)::int AS n FROM jobs WHERE paper_id = $1 AND intent = 'draft_paragraph'", [w.paperId])).rows[0].n).toBe(1);
    expect((await repair(w, after)).statusCode).toBe(409);
  });

  test('a repair is refused when the paragraph changed since the review or is not part of an approved plan; a real reviewer needs the paper\'s permission', async () => {
    const w = await world();
    const { run } = await review(w, spy((i) => ({ findings: [overclaim(i)] })));
    await decide(w, run!.findings[0]!, 'accepted');
    const content = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P1 }, content: [{ type: 'text', text: 'Rewritten by hand.' }] }] };
    await call('alice', 'POST', `/api/papers/${w.paperId}/documents/${w.documentId}/saves`, { expected_head_revision_id: w.head, content_json: content, schema_version: 1, reason: 'manual' });
    expect((await repair(w, run!)).statusCode).toBe(409);
    // a paragraph that no longer belongs to a plan: the Writer has no contract for it
    const w2 = await world();
    const r2 = await review(w2, spy((i) => ({ findings: [overclaim(i)] })));
    await decide(w2, r2.run!.findings[0]!, 'accepted');
    expect((await app.inject({ method: 'DELETE', url: `/api/papers/${w2.paperId}/outline/revisions/${w2.outlineId}/nodes/${w2.n1.node_id}/paragraphs/${w2.documentId}/${P1}`, headers: H.alice })).statusCode).toBeLessThan(300);
    const unlinked = await repair(w2, r2.run!);
    expect(unlinked.statusCode).toBe(422);
    expect(unlinked.json().reason).toBe('paragraph_not_in_plan');
    const real = spy((i) => ({ findings: [overclaim(i)] }), 'codex');
    const { job } = await review(w, real, (await pool.query('SELECT head_revision_id FROM documents WHERE id = $1', [w.documentId])).rows[0].head_revision_id);
    expect(job.status).toBe('WAITING_USER');
    expect(real.seen).toHaveLength(0);
  });
});

describe('review fixes (5119f09)', () => {
  // an applied selection proposal (PW-017) on P1 with the given origin
  async function selectionEdit(w: W, origin: string) {
    const { snapshotSelection, parseDocument } = await import('../../../packages/editor-core/src/index.ts');
    const { createProposal, applyProposal } = await import('../../../packages/domain/src/proposals/index.ts');
    const content = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P1 }, content: [{ type: 'text', text: TEXT }] }] };
    const from = TEXT.indexOf('causes');
    const selection = await snapshotSelection(parseDocument(content, 1), { blockId: P1, from, to: from + 'causes'.length });
    const h = (await call('alice', 'POST', `/api/papers/${w.paperId}/documents/${w.documentId}/selection-handles`, { base_revision_id: w.head, selection })).json();
    const p = await createProposal(pool, { paperId: w.paperId, handleId: h.id, intent: 'grammar', replacement: [{ type: 'text', text: 'contributes to' }], origin });
    const applied = await applyProposal(pool, { paperId: w.paperId, proposalId: p.id, ownerId: w.owner, proposalHash: p.proposal_hash, expectedRevisionId: w.head, idempotencyKey: randomUUID().replaceAll('-', '') });
    return applied.revision.id as string;
  }
  test('MINOR: AI edits through selection proposals count for authorship; unknown generators are not "human_written"', async () => {
    const same = await world();
    expect((await review(same, createMockReviewer(), await selectionEdit(same, 'worker:provider.mock'))).run!.independence).toBe('same_model');
    const other = await world();
    expect((await review(other, createMockReviewer(), await selectionEdit(other, 'worker:tool-gateway:codex'))).run!.independence).toBe('different_model');
    const unknown = await world();
    expect((await review(unknown, createMockReviewer(), await selectionEdit(unknown, 'worker:legacy-import'))).run!.independence).toBe('unknown_authorship');
  });

  test('NIT: a scientific finding must rest on a record; a writing finding may not', async () => {
    const w = await world();
    const { run } = await review(w, spy((i) => ({ findings: [
      { ...overclaim(i), source: null },
      { ...overclaim(i), kind: 'writing', category: 'concision', source: null },
    ] })));
    expect(run!.dropped.map((d) => d.reason)).toEqual(['no_source']);
    expect(run!.findings.map((f) => f.kind)).toEqual(['writing']);
  });

  test('NIT: a run on an older version of the paragraph is marked outdated; a reused key for another repair says so', async () => {
    const w = await world();
    const { run } = await review(w, spy((i) => ({ findings: [overclaim(i)] })));
    expect((run as Run & { outdated: boolean }).outdated).toBe(false);
    const content = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P1 }, content: [{ type: 'text', text: `${TEXT} More.` }] }] };
    await call('alice', 'POST', `/api/papers/${w.paperId}/documents/${w.documentId}/saves`, { expected_head_revision_id: w.head, content_json: content, schema_version: 1, reason: 'manual' });
    const after = ((await call('alice', 'GET', `/api/papers/${w.paperId}/reviews?document_id=${w.documentId}&block_id=${P1}`)).json() as (Run & { outdated: boolean })[])[0]!;
    expect(after.outdated).toBe(true);
    // two reviews of the current text; one key used for the first one's repair cannot start the second's
    const w2 = await world();
    const a = (await review(w2, spy((i) => ({ findings: [overclaim(i)] })))).run!;
    const b = (await review(w2, spy((i) => ({ findings: [overclaim(i)] })))).run!;
    await decide(w2, a.findings[0]!, 'accepted');
    await decide(w2, b.findings[0]!, 'accepted');
    const key = randomUUID();
    expect((await call('alice', 'POST', `/api/papers/${w2.paperId}/reviews/${a.id}/repair`, { intent: 'repair_paragraph', idempotency_key: key })).statusCode).toBe(201);
    const reused = await call('alice', 'POST', `/api/papers/${w2.paperId}/reviews/${b.id}/repair`, { intent: 'repair_paragraph', idempotency_key: key });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().field).toBe('idempotency_key');
  });
});
