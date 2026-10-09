// PW-042 — ParagraphContract and Writer (spec 06 "ParagraphContract", "수정 모드", "검증 층" A; spec 04).
// TST-042A: a paragraph is generated from the approved node's contract — its purpose, its approved
//   claims and exact verified facts, its evidence, the profile's terminology — and comes back only as a
//   proposal: the manuscript changes only when the owner applies it (exact hash, base revision); the
//   three modes (draft a new paragraph, conservative correction, scientific rewrite) all go this way.
// TST-042B: the writer may answer "needs evidence" and never invents it: a number, claim or fact not
//   in the contract, a citation that is not one of this paper's references (RFC-008) or a bibliography
//   string, or more than one paragraph is never stored as a usable proposal.
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
import { createReference } from '../../../packages/domain/src/references/index.ts';
import { processDelivery } from '../../../apps/worker/src/queue/index.ts';
import { writerHandlers, createMockWriter, type Writer } from '../../../apps/worker/src/writer/index.ts';
import type { ParagraphContract } from '../../../packages/contracts/src/writing/index.ts';

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
const brief = { purpose: 'Test whether ABC1 responds to drought in roots', audience: 'plant biologists', known_facts: [], missing_material: [], avoid_claims: [] };
const story = { question: 'Does ABC1 respond to drought?', main_message: 'ABC1 is drought-induced', novelty: 'x', evidence_links: [], competing_explanations: [], presentation_order: [], limitations: [] };
const node = (o: Record<string, unknown>) => ({ node_id: randomUUID(), parent_node_id: null, section: 'Results', role: 'result', paragraph_goal: 'goal', claim_ids: [], evidence_ids: [], requires_evidence: false, allowed_interpretation: '', exclusions: [], transition: '', word_budget_min: null, word_budget_max: null, ...o });
const P1 = randomUUID();
const ORIGINAL = 'ABC1 was measured by qPCR in  3 replicates';

// an approved story and outline: n1 (claim c1 on evidence e1 with fact f1 = 2.4-fold, n = 3), n2 (claim c2);
// a manuscript with one paragraph; one reference; an approved writing profile that avoids "upregulated"
async function world() {
  const owner = ids.alice!;
  const paperId = (await call('alice', 'POST', '/api/papers', { working_title: 'writer paper', article_type: 'research_article' })).json().id as string;
  const s = (await call('alice', 'POST', `/api/papers/${paperId}/story/revisions`, { parent_revision_id: null, brief, story })).json();
  await call('alice', 'POST', `/api/papers/${paperId}/story/revisions/${s.id}/approve`, { intent: 'approve_story', content_hash: s.content_hash });
  const evidence = async (note: string) => {
    const e = await createEvidence(pool, { paperId, ownerId: owner, body: { kind: 'experiment', locator: { note }, label: note } });
    await reviewEvidence(pool, { paperId, ownerId: owner, id: e.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: e.content_hash } });
    return (await call('alice', 'GET', `/api/papers/${paperId}/evidence/${e.id}`)).json();
  };
  const e1 = await evidence('roots qPCR');
  const e2 = await evidence('leaf qPCR');
  const [f1] = await createFactCandidates(pool, { paperId, ownerId: owner, origin: 'user', single: true, facts: [{ evidence_id: e1.id, entity: 'ABC1 roots', metric: 'fold change', value_text: '2.4', unit: 'fold', group: 'drought', comparison: 'control', n: 3, extraction_method: 'manual_entry' }] });
  await reviewFact(pool, { paperId, ownerId: owner, id: f1!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: f1!.content_hash } });
  const claim = async (text: string, ev: string) => {
    const c = await createClaim(pool, { paperId, ownerId: owner, body: { kind: 'observation', text } });
    await linkClaimEvidence(pool, { paperId, ownerId: owner, claimId: c.id, body: { evidence_id: ev, relation: 'supports' } });
    return approveClaim(pool, { paperId, ownerId: owner, id: c.id, body: { intent: 'approve_claim', content_hash: c.content_hash } });
  };
  const c1 = await claim('ABC1 rises in roots under drought.', e1.id);
  const c2 = await claim('ABC1 does not change in leaves.', e2.id);
  const n1 = node({ paragraph_goal: 'Show root induction', claim_ids: [c1.id], evidence_ids: [e1.id], requires_evidence: true, transition: 'Then leaves.', word_budget_min: 10, word_budget_max: 60, exclusions: ['no mechanism'] });
  const n2 = node({ paragraph_goal: 'Contrast with leaves', claim_ids: [c2.id], evidence_ids: [e2.id] });
  const o = (await call('alice', 'POST', `/api/papers/${paperId}/outline/revisions`, { parent_revision_id: null, story_revision_id: s.id, nodes: [n1, n2] })).json();
  await call('alice', 'POST', `/api/papers/${paperId}/outline/revisions/${o.id}/approve`, { intent: 'approve_outline', content_hash: o.content_hash });
  const ref = await createReference(pool, { paperId, ownerId: owner, body: { title: 'Earlier root study', authors: [{ family: 'Kim' }], year: 2019 } });
  const d = (await call('alice', 'POST', `/api/papers/${paperId}/documents`, { kind: 'manuscript' })).json();
  const content = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P1 }, content: [{ type: 'text', text: ORIGINAL }] }] };
  const head = (await call('alice', 'POST', `/api/papers/${paperId}/documents/${d.document.id}/saves`, { expected_head_revision_id: d.head.id, content_json: content, schema_version: 1, reason: 'manual' })).json().id as string;
  const profile = (await call('alice', 'POST', `/api/papers/${paperId}/writing-profile/revisions`, { parent_revision_id: null, content: {
    article_type: 'research_article', target_audience: 'plant biologists', preferred_english_variant: 'US', concision_preference: 'concise', claim_strength_policy: 'State observations plainly.',
    terminology: [{ term: 'induced', preferred: 'induced', avoid: ['upregulated'], note: '' }],
    section_roles: [{ section: 'Results', role: 'report observations', principles: [{ text: 'One observation per paragraph, tied to its figure', sources: [] }], counterexamples: [] }],
    rhetoric_patterns: [], anti_examples: [], accepted_examples: [],
  } })).json();
  await call('alice', 'POST', `/api/papers/${paperId}/writing-profile/revisions/${profile.id}/approve`, { intent: 'approve_profile', content_hash: profile.content_hash });
  return { paperId, owner, storyId: s.id as string, outlineId: o.id as string, n1, n2, e1, e2, f1: f1!, c1, c2, ref, documentId: d.document.id as string, head };
}
type W = Awaited<ReturnType<typeof world>>;
const spy = (answer: (c: ParagraphContract) => unknown, id: Writer['id'] = 'mock'): Writer & { seen: ParagraphContract[] } => {
  const seen: ParagraphContract[] = [];
  return { id, label: id === 'mock' ? 'MOCK' : id, seen, async write(c) { seen.push(c); return answer(c); } };
};
const request = (w: W, o: Record<string, unknown> = {}) => call('alice', 'POST', `/api/papers/${w.paperId}/writer/requests`, {
  mode: 'draft', outline_revision_id: w.outlineId, node_id: w.n1.node_id, document_id: w.documentId, base_revision_id: w.head, after_block_id: P1, instruction: 'Write the root result.', idempotency_key: randomUUID(), ...o,
});
type Proposal = { id: string; job_id: string; proposal_hash: string; base_revision_id: string; status: string; checks: { check: string; result: string; details?: string }[]; [k: string]: unknown };
async function run(w: W, gen: Writer = createMockWriter(), o: Record<string, unknown> = {}) {
  const r = await request(w, o);
  expect(r.statusCode, r.body).toBe(201);
  const jobId = r.json().job.id as string;
  await processDelivery(pool, { job_id: jobId, paper_id: w.paperId, intent: 'draft_paragraph' }, { workerId: 'w1', leaseMs: 60_000, handlers: writerHandlers(pool, gen) });
  const job = (await pool.query('SELECT status, last_error FROM jobs WHERE id = $1', [jobId])).rows[0];
  const list = (await call('alice', 'GET', `/api/papers/${w.paperId}/writer/proposals?document_id=${w.documentId}`)).json() as Proposal[];
  return { jobId, job, proposal: list.find((p) => p.job_id === jobId) ?? null };
}
const good = (c: ParagraphContract, extra: unknown[] = []) => ({
  status: 'draft',
  paragraph: [{ type: 'text', text: `Under drought, ABC1 was induced ${c.exact_facts.length ? '2.4-fold' : ''} in roots (n = 3) ` }, { type: 'citation', reference_id: c.citable_references[0]!.reference_id }, { type: 'text', text: '.' }, ...extra],
  claim_ids: c.mandatory_claims.map((x) => x.id),
  fact_ids: c.exact_facts.map((f) => f.id),
});
const head = async (w: W) => (await pool.query('SELECT head_revision_id FROM documents WHERE id = $1', [w.documentId])).rows[0].head_revision_id as string;
const apply = (w: W, p: { id: string; proposal_hash: string; base_revision_id: string }, o: Record<string, unknown> = {}) =>
  call('alice', 'POST', `/api/papers/${w.paperId}/writer/proposals/${p.id}/apply`, { intent: 'apply_paragraph', proposal_hash: p.proposal_hash, expected_revision_id: p.base_revision_id, ...o });

describe('TST-042A: from the node\'s contract, back as a proposal only', () => {
  test('the contract holds the node\'s purpose, approved claims, exact facts, evidence, neighbours, terminology and length — and nothing of other nodes', async () => {
    const w = await world();
    const g = spy((c) => good(c));
    const { proposal } = await run(w, g);
    const c = g.seen[0]!;
    expect(c).toMatchObject({
      contract_version: 'pw-paragraph-contract-1', story_revision_id: w.storyId, outline_revision_id: w.outlineId, node_id: w.n1.node_id,
      section: 'Results', purpose: 'Show root induction', prohibited_inferences: ['no mechanism'], target_length: { min_words: 10, max_words: 60 },
      operation: { mode: 'draft', document_id: w.documentId, base_revision_id: w.head, after_block_id: P1 },
      instruction: 'Write the root result.',
    });
    expect(c.mandatory_claims).toEqual([{ id: w.c1.id, kind: 'observation', text: 'ABC1 rises in roots under drought.' }]);
    expect(c.exact_facts.map((f) => f.id)).toEqual([w.f1.id]);
    expect(c.exact_facts[0]!.text).toContain('2.4');
    expect(c.evidence.map((e) => e.id)).toEqual([w.e1.id]);
    expect(c.context.next).toMatchObject({ paragraph_goal: 'Contrast with leaves' });
    expect(c.context.preceding_text).toBe(ORIGINAL);
    expect(c.style.terminology).toEqual([{ term: 'induced', preferred: 'induced', avoid: ['upregulated'], note: '' }]);
    expect(c.style.section_principles).toEqual(['One observation per paragraph, tied to its figure']);
    expect(c.citable_references.map((r) => r.reference_id)).toEqual([w.ref.id]);
    expect(JSON.stringify(c)).not.toContain('ABC1 does not change in leaves.');
    expect(proposal).toMatchObject({ status: 'PENDING', mode: 'draft', node_id: w.n1.node_id, generator_label: 'MOCK', contract_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // only a proposal: the manuscript did not move
    expect(await head(w)).toBe(w.head);
  });

  test('applying needs the intent, the exact proposal and its base; it inserts one paragraph after the chosen one and links it to the node', async () => {
    const w0 = await world();
    // two paragraphs: the new one goes between them
    const P2 = randomUUID();
    const two = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P1 }, content: [{ type: 'text', text: ORIGINAL }] }, { type: 'paragraph', attrs: { id: P2 }, content: [{ type: 'text', text: 'Leaves next.' }] }] };
    const w = { ...w0, head: (await call('alice', 'POST', `/api/papers/${w0.paperId}/documents/${w0.documentId}/saves`, { expected_head_revision_id: w0.head, content_json: two, schema_version: 1, reason: 'manual' })).json().id as string };
    const { proposal } = await run(w, spy((c) => good(c)));
    expect((await apply(w, proposal!, { intent: undefined })).statusCode).toBe(422);
    expect((await apply(w, proposal!, { proposal_hash: 'f'.repeat(64) })).statusCode).toBe(409);
    expect((await call('bob', 'POST', `/api/papers/${w.paperId}/writer/proposals/${proposal!.id}/apply`, { intent: 'apply_paragraph', proposal_hash: proposal!.proposal_hash, expected_revision_id: w.head })).statusCode).toBe(404);
    const r = await apply(w, proposal!);
    expect(r.statusCode, r.body).toBe(200);
    const doc = (await pool.query('SELECT content_json, reason FROM document_revisions WHERE id = $1', [await head(w)])).rows[0];
    expect(doc.reason).toBe('ai_apply');
    expect(doc.content_json.content.map((n: { attrs: { id: string } }) => n.attrs.id)).toEqual([P1, r.json().block_id, P2]);
    const added = doc.content_json.content[1];
    expect(added.attrs.id).toBe(r.json().block_id);
    expect(added.content.find((n: { type: string }) => n.type === 'citation').attrs.referenceId).toBe(w.ref.id);
    const link = (await pool.query('SELECT origin FROM outline_node_paragraphs WHERE node_id = $1 AND block_id = $2', [w.n1.node_id, added.attrs.id])).rows[0];
    expect(link).toEqual({ origin: 'draft' });
    expect((await apply(w, proposal!)).statusCode).toBe(409); // applied once
  });

  test('conservative correction and scientific rewrite of an existing paragraph: the same block, checked against the original', async () => {
    const w = await world();
    const fix = await run(w, createMockWriter(), { mode: 'conservative', after_block_id: undefined, block_id: P1 });
    expect(fix.proposal).toMatchObject({ status: 'PENDING', mode: 'conservative', block_id: P1 });
    expect((await apply(w, fix.proposal!)).statusCode).toBe(200);
    const doc = (await pool.query('SELECT content_json FROM document_revisions WHERE id = $1', [await head(w)])).rows[0].content_json;
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]).toMatchObject({ attrs: { id: P1 }, content: [{ type: 'text', text: 'ABC1 was measured by qPCR in 3 replicates.' }] });
    // a conservative answer that changes a number fails the original-preservation checks
    const changed = await run({ ...w, head: await head(w) }, spy(() => ({ status: 'draft', paragraph: [{ type: 'text', text: 'ABC1 was measured by qPCR in 4 replicates.' }], claim_ids: [], fact_ids: [] })), { mode: 'conservative', after_block_id: undefined, block_id: P1, base_revision_id: await head(w) });
    expect(changed.proposal).toMatchObject({ status: 'CHECK_FAILED' });
    expect(changed.proposal!.checks.map((c: { check: string; result: string }) => `${c.check}:${c.result}`)).toContain('numbers:fail');
    // a rewrite keeps the same claims and numbers (spec 06 "Scientific Rewrite"): reordering is fine, adding a result is not
    const at = await head(w);
    const rw = await run({ ...w, head: at }, spy(() => ({ status: 'draft', paragraph: [{ type: 'text', text: 'Using qPCR, ABC1 was measured in 3 replicates.' }], claim_ids: [], fact_ids: [] })), { mode: 'rewrite', after_block_id: undefined, block_id: P1, base_revision_id: at });
    expect(rw.proposal).toMatchObject({ status: 'PENDING', mode: 'rewrite' });
    const added = await run({ ...w, head: at }, spy(() => ({ status: 'draft', paragraph: [{ type: 'text', text: 'In 3 replicates, qPCR showed ABC1 induced 2.4-fold.' }], claim_ids: [], fact_ids: [w.f1.id] })), { mode: 'rewrite', after_block_id: undefined, block_id: P1, base_revision_id: at });
    expect(added.proposal!.checks).toContainEqual(expect.objectContaining({ check: 'numbers', result: 'fail' }));
  });

  test('a proposal made for an older manuscript is STALE; the gate and the provider policy hold before anything is written', async () => {
    const w = await world();
    const { proposal } = await run(w, spy((c) => good(c)));
    // the user edits the manuscript meanwhile
    const content = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P1 }, content: [{ type: 'text', text: 'Edited by hand.' }] }] };
    await call('alice', 'POST', `/api/papers/${w.paperId}/documents/${w.documentId}/saves`, { expected_head_revision_id: w.head, content_json: content, schema_version: 1, reason: 'manual' });
    const r = await apply(w, proposal!);
    expect(r.statusCode).toBe(409);
    expect(r.json().reason ?? r.json().details?.reason).toBe('STALE');
    expect((await call('alice', 'GET', `/api/papers/${w.paperId}/writer/proposals/${proposal!.id}`)).json().status).toBe('STALE');
    // the gate: a node of a draft outline, another owner's paper, a block that is not there
    const draft = (await call('alice', 'POST', `/api/papers/${w.paperId}/outline/revisions`, { parent_revision_id: w.outlineId, story_revision_id: w.storyId, nodes: [node({ paragraph_goal: 'x' })] })).json();
    const g1 = await request({ ...w, head: await head(w) }, { outline_revision_id: draft.id, node_id: draft.nodes?.[0]?.node_id ?? randomUUID(), base_revision_id: await head(w) });
    expect(g1.statusCode).toBe(409);
    expect((await call('bob', 'POST', `/api/papers/${w.paperId}/writer/requests`, {})).statusCode).toBe(404);
    expect((await request(w, { base_revision_id: await head(w), after_block_id: randomUUID() })).statusCode).toBe(422);
    expect((await request(w, { base_revision_id: w.head })).statusCode).toBe(409); // not the current head
    // a real provider: the paper must allow it
    const real = spy((c) => good(c), 'claude_agent');
    const blocked = await run({ ...w, head: await head(w) }, real, { base_revision_id: await head(w) });
    expect(blocked.job.status).toBe('WAITING_USER');
    expect(real.seen).toHaveLength(0);
  });
  test('the gate is checked again when the writer runs and when the owner applies; a late answer is STALE; an unchanged paragraph is NO_CHANGE', async () => {
    const w = await world();
    const retractC1 = () => call('alice', 'POST', `/api/papers/${w.paperId}/claims/${w.c1.id}/retract`, { intent: 'retract_claim', content_hash: w.c1.content_hash });
    // a proposal waiting to be applied when the node gets an impact: refused until the owner reviews it
    const { proposal } = await run(w, spy((c) => good(c)));
    expect((await apply(w, proposal!, { expected_revision_id: randomUUID() })).statusCode).toBe(409);
    expect((await retractC1()).statusCode).toBe(200);
    const blocked = await apply(w, proposal!);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().reasons).toContain('impact_review_required');
    expect(await head(w)).toBe(w.head);
    // requested before the impact, run after it: the run fails at the gate, the writer is never asked
    const w2 = await world();
    const r = await request(w2);
    await call('alice', 'POST', `/api/papers/${w2.paperId}/claims/${w2.c1.id}/retract`, { intent: 'retract_claim', content_hash: w2.c1.content_hash });
    const g = spy((c) => good(c));
    await processDelivery(pool, { job_id: r.json().job.id, paper_id: w2.paperId, intent: 'draft_paragraph' }, { workerId: 'w1', leaseMs: 60_000, handlers: writerHandlers(pool, g) });
    expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [r.json().job.id])).rows[0].status).toBe('FAILED');
    expect(g.seen).toHaveLength(0);
    // the manuscript changed while the paragraph was written: kept, but STALE
    const w3 = await world();
    const r3 = await request(w3);
    const content = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P1 }, content: [{ type: 'text', text: 'Edited meanwhile.' }] }] };
    await call('alice', 'POST', `/api/papers/${w3.paperId}/documents/${w3.documentId}/saves`, { expected_head_revision_id: w3.head, content_json: content, schema_version: 1, reason: 'manual' });
    await processDelivery(pool, { job_id: r3.json().job.id, paper_id: w3.paperId, intent: 'draft_paragraph' }, { workerId: 'w1', leaseMs: 60_000, handlers: writerHandlers(pool, spy((c) => good(c))) });
    const late = (await call('alice', 'GET', `/api/papers/${w3.paperId}/writer/proposals?document_id=${w3.documentId}`)).json()[0];
    expect(late).toMatchObject({ status: 'STALE' });
    // a correction that changes nothing is not a proposal to apply
    const same = await run({ ...w3, head: await head(w3) }, spy((c) => ({ status: 'draft', paragraph: c.operation.original, claim_ids: [], fact_ids: [] })), { mode: 'conservative', after_block_id: undefined, block_id: P1, base_revision_id: await head(w3) });
    expect(same.proposal).toMatchObject({ status: 'NO_CHANGE', paragraph: null });
  });
});

describe('TST-042B: no invented evidence; one paragraph only', () => {
  test('"needs evidence" is a valid answer: kept with what is missing, never applicable', async () => {
    const w = await world();
    const { proposal } = await run(w, spy(() => ({ status: 'needs_evidence', missing: ['a replicate experiment in a second genotype'] })));
    expect(proposal).toMatchObject({ status: 'NEEDS_EVIDENCE', missing: ['a replicate experiment in a second genotype'], paragraph: null });
    expect((await apply(w, proposal!)).statusCode).toBe(409);
  });

  test('a number outside the contract, a missing mandatory claim or an avoided term makes the proposal CHECK_FAILED', async () => {
    const w = await world();
    const bad = async (answer: (c: ParagraphContract) => unknown) => (await run(w, spy(answer))).proposal!;
    const p1 = await bad((c) => ({ ...good(c), paragraph: [{ type: 'text', text: 'ABC1 was induced 5.1-fold in roots (n = 3).' }] }));
    expect(p1.status).toBe('CHECK_FAILED');
    expect(p1.checks).toContainEqual(expect.objectContaining({ check: 'number_not_in_contract', result: 'fail', details: '5.1' }));
    const p2 = await bad((c) => ({ ...good(c), claim_ids: [] }));
    expect(p2.checks).toContainEqual(expect.objectContaining({ check: 'mandatory_claim', result: 'fail', details: w.c1.id }));
    const p3 = await bad((c) => ({ ...good(c), paragraph: [{ type: 'text', text: 'ABC1 was upregulated 2.4-fold in roots (n = 3).' }] }));
    expect(p3.checks).toContainEqual(expect.objectContaining({ check: 'avoided_term', result: 'fail', details: 'upregulated' }));
    for (const p of [p1, p2, p3]) expect((await apply(w, p)).statusCode).toBe(409);
  });

  test('an invented claim or fact, a citation outside this paper\'s references, or a bibliography string: the answer is refused and nothing is stored', async () => {
    const w = await world();
    const other = await createReference(pool, { paperId: (await call('bob', 'POST', '/api/papers', { working_title: 'b', article_type: 'research_article' })).json().id, ownerId: ids.bob!, body: { title: 'Bob ref', authors: [{ family: 'Lee' }], year: 2020 } });
    for (const answer of [
      (c: ParagraphContract) => ({ ...good(c), claim_ids: [w.c2.id] }),
      (c: ParagraphContract) => ({ ...good(c), fact_ids: [randomUUID()] }),
      (c: ParagraphContract) => ({ ...good(c), paragraph: [{ type: 'text', text: 'ABC1 rose 2.4-fold ' }, { type: 'citation', reference_id: other.id }] }),
      (c: ParagraphContract) => ({ ...good(c), paragraph: [{ type: 'text', text: 'ABC1 rose 2.4-fold ' }, { type: 'citation', reference_id: randomUUID() }] }),
      (c: ParagraphContract) => ({ ...good(c), paragraph: [{ type: 'text', text: 'ABC1 rose 2.4-fold (Smith et al., 2020).' }] }),
      (c: ParagraphContract) => ({ ...good(c), paragraph: [{ type: 'text', text: 'ABC1 rose 2.4-fold [12].' }] }),
      (c: ParagraphContract) => ({ ...good(c), paragraph: [{ type: 'text', text: 'ABC1 rose 2.4-fold (doi:10.1000/xyz).' }] }),
      (c: ParagraphContract) => ({ ...good(c), approved: true }),
    ]) {
      const r = await run(w, spy(answer));
      expect(r.job.status, JSON.stringify(r.job)).toBe('FAILED');
      expect(r.proposal).toBeNull();
    }
  });

  test('a one-paragraph request is never widened into a manuscript: a second paragraph, a heading or far more than the budget is refused', async () => {
    const w = await world();
    const long = Array.from({ length: 130 }, () => 'roots').join(' ');
    for (const answer of [
      (c: ParagraphContract) => ({ ...good(c), paragraph: [{ type: 'text', text: 'ABC1 rose 2.4-fold.\n\nDiscussion follows here.' }] }),
      (c: ParagraphContract) => ({ ...good(c), paragraph: [{ type: 'text', text: '## Results\nABC1 rose 2.4-fold.' }] }),
      (c: ParagraphContract) => ({ ...good(c), paragraph: [{ type: 'text', text: `ABC1 rose 2.4-fold ${long}.` }] }),
      (c: ParagraphContract) => ({ ...good(c), paragraphs: [good(c).paragraph, good(c).paragraph] }),
    ]) {
      const r = await run(w, spy(answer));
      expect(r.job.status).toBe('FAILED');
      expect(r.job.last_error).toMatch(/scope_exceeded|unknown fields/);
      expect(r.proposal).toBeNull();
    }
    // somewhat over the budget is a warning, not a refusal
    const words = Array.from({ length: 70 }, () => 'roots').join(' ');
    const r = await run(w, spy((c) => ({ ...good(c), paragraph: [{ type: 'text', text: `ABC1 rose 2.4-fold ${words}.` }] })));
    expect(r.proposal).toMatchObject({ status: 'PENDING', warnings: ['longer_than_target'] });
  });
});
