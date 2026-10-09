// PW-043 — the gate on the paper's own records: a manuscript paragraph is checked against the paper's
// verified, settled facts (with their evidence locators), its references (retraction known to the
// library) and the approved claims of the plans it is linked to; each run is kept as an immutable
// record. The Writer (PW-042) runs the same gate on every proposal: a failure blocks applying, an
// unknown is shown and never counted as verified.
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
import { writerHandlers, type Writer } from '../../../apps/worker/src/writer/index.ts';
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
const node = (o: Record<string, unknown>) => ({ node_id: randomUUID(), parent_node_id: null, section: 'Results', role: 'result', paragraph_goal: 'goal', claim_ids: [], evidence_ids: [], requires_evidence: false, allowed_interpretation: '', exclusions: [], transition: '', word_budget_min: null, word_budget_max: null, ...o });
const P1 = randomUUID();
const P2 = randomUUID();

async function world() {
  const owner = ids.alice!;
  const paperId = (await call('alice', 'POST', '/api/papers', { working_title: 'gate paper', article_type: 'research_article' })).json().id as string;
  const s = (await call('alice', 'POST', `/api/papers/${paperId}/story/revisions`, { parent_revision_id: null, brief: { purpose: 'Test ABC1', audience: 'x', known_facts: [], missing_material: [], avoid_claims: [] }, story: { question: 'q', main_message: 'm', novelty: 'n', evidence_links: [], competing_explanations: [], presentation_order: [], limitations: [] } })).json();
  await call('alice', 'POST', `/api/papers/${paperId}/story/revisions/${s.id}/approve`, { intent: 'approve_story', content_hash: s.content_hash });
  const e = await createEvidence(pool, { paperId, ownerId: owner, body: { kind: 'experiment', locator: { note: 'qPCR plate 3' }, label: 'roots qPCR' } });
  await reviewEvidence(pool, { paperId, ownerId: owner, id: e.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: e.content_hash } });
  const [f] = await createFactCandidates(pool, { paperId, ownerId: owner, origin: 'user', single: true, facts: [{ evidence_id: e.id, entity: 'ABC1 roots', metric: 'fold change', value_text: '2.4', unit: 'fold', group: 'drought', comparison: 'control', n: 3, extraction_method: 'manual_entry',
    statistics: [{ kind: 'p_value', value_text: '0.003', test: 't-test' }, { kind: 'q_value', value_text: '0.04', test: 't-test' }] }] });
  await reviewFact(pool, { paperId, ownerId: owner, id: f!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: f!.content_hash } });
  const c = await createClaim(pool, { paperId, ownerId: owner, body: { kind: 'observation', text: 'ABC1 rises in roots under drought.' } });
  await linkClaimEvidence(pool, { paperId, ownerId: owner, claimId: c.id, body: { evidence_id: e.id, relation: 'supports' } });
  const c1 = await approveClaim(pool, { paperId, ownerId: owner, id: c.id, body: { intent: 'approve_claim', content_hash: c.content_hash } });
  const n1 = node({ paragraph_goal: 'Root induction', claim_ids: [c1.id], evidence_ids: [e.id] });
  const o = (await call('alice', 'POST', `/api/papers/${paperId}/outline/revisions`, { parent_revision_id: null, story_revision_id: s.id, nodes: [n1] })).json();
  await call('alice', 'POST', `/api/papers/${paperId}/outline/revisions/${o.id}/approve`, { intent: 'approve_outline', content_hash: o.content_hash });
  const ref = await createReference(pool, { paperId, ownerId: owner, body: { title: 'Earlier root study', authors: [{ family: 'Kim' }], year: 2019 } });
  const d = (await call('alice', 'POST', `/api/papers/${paperId}/documents`, { kind: 'manuscript' })).json();
  const content = { type: 'doc', content: [
    { type: 'paragraph', attrs: { id: P1 }, content: [{ type: 'text', text: 'Under drought, ABC1 rose 2.4-fold in roots (n = 3; p = 0.003) ' }, { type: 'citation', attrs: { referenceId: ref.id, locator: 'p. 4' } }, { type: 'text', text: '.' }] },
    { type: 'paragraph', attrs: { id: P2 }, content: [{ type: 'text', text: 'ABC1 does not rise in roots under drought (q = 0.003).' }] },
  ] };
  const head = (await call('alice', 'POST', `/api/papers/${paperId}/documents/${d.document.id}/saves`, { expected_head_revision_id: d.head.id, content_json: content, schema_version: 1, reason: 'manual' })).json().id as string;
  await call('alice', 'POST', `/api/papers/${paperId}/outline/revisions/${o.id}/nodes/${n1.node_id}/paragraphs`, { document_id: d.document.id, block_id: P2 });
  return { paperId, owner, e, f: f!, c1, n1, outlineId: o.id as string, ref, documentId: d.document.id as string, head };
}
type W = Awaited<ReturnType<typeof world>>;
const check = (w: W, blockId: string, who = 'alice', revisionId = w.head) => call(who, 'POST', `/api/papers/${w.paperId}/documents/${w.documentId}/scientific-checks`, { revision_id: revisionId, block_id: blockId });

describe('TST-043A/B on the paper\'s records', () => {
  test('a manuscript paragraph that matches: VERIFIED, with the fact\'s evidence and the citation\'s reference; the run is kept', async () => {
    const w = await world();
    const r = await check(w, P1);
    expect(r.statusCode, r.body).toBe(201);
    const run = r.json();
    expect(run).toMatchObject({ status: 'VERIFIED', gate_version: 'pw-sci-gate-2', block_id: P1, revision_id: w.head });
    expect(run.findings).toContainEqual(expect.objectContaining({ check: 'quantity', verdict: 'pass', fact_id: w.f.id, evidence_id: w.e.id, evidence_label: 'roots qPCR', locator: { note: 'qPCR plate 3' } }));
    expect(run.findings).toContainEqual(expect.objectContaining({ check: 'statistic', verdict: 'pass', statistic: 'p_value', fact_id: w.f.id }));
    expect(run.findings).toContainEqual(expect.objectContaining({ check: 'citation', verdict: 'pass', reference_id: w.ref.id, locator: 'p. 4' }));
    const list = (await call('alice', 'GET', `/api/papers/${w.paperId}/documents/${w.documentId}/scientific-checks?block_id=${P1}`)).json();
    expect(list.map((x: { id: string }) => x.id)).toEqual([run.id]);
    await expect(pool.query("UPDATE scientific_check_runs SET status = 'VERIFIED' WHERE id = $1", [run.id])).rejects.toThrow(/immutable/);
  });

  test('the paragraph linked to the plan is checked against the plan\'s approved claim: a negated claim and a q written as p fail', async () => {
    const w = await world();
    const run = (await check(w, P2)).json();
    expect(run.status).toBe('FAILED');
    expect(run.findings).toContainEqual(expect.objectContaining({ check: 'claim', verdict: 'fail', reason: 'negation_changed', claim_id: w.c1.id }));
    // q = 0.003 is the recorded p-value and no q of 0.003 is recorded anywhere: a p/q swap even without a
    // matched quantity (PW-045 SCI-003 tightened this from unknown to fail)
    expect(run.findings.find((x: { check: string }) => x.check === 'statistic')).toMatchObject({ verdict: 'fail', reason: 'p_q_mismatch' });
  });

  test('a fact that is no longer settled is not used: a retracted fact leaves its number unknown; a retracted reference fails', async () => {
    const w = await world();
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/facts/${w.f.id}/retract`, { intent: 'retract_fact', content_hash: w.f.content_hash })).statusCode).toBe(200);
    await pool.query("INSERT INTO reference_relations (owner_id, from_reference_id, relation, source) VALUES ($1, $2, 'flagged_retracted', 'manual')", [w.owner, w.ref.id]);
    const run = (await check(w, P1)).json();
    expect(run.status).toBe('FAILED');
    expect(run.findings).toContainEqual(expect.objectContaining({ check: 'quantity', verdict: 'unknown', reason: 'no_matching_fact' }));
    expect(run.findings).toContainEqual(expect.objectContaining({ check: 'citation', verdict: 'fail', reason: 'citation_retracted' }));
  });

  test('review NIT: the gate judges what is true, not what may be sent — a fact from a cited source with no confirmed PDF is used', async () => {
    const w = await world();
    const lit = await createEvidence(pool, { paperId: w.paperId, ownerId: w.owner, body: { kind: 'literature_excerpt', reference_id: w.ref.id, locator: { quote: 'leaf ABC1 fell 1.8-fold' }, label: 'Kim 2019 text' } });
    await reviewEvidence(pool, { paperId: w.paperId, ownerId: w.owner, id: lit.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: lit.content_hash } });
    const [lf] = await createFactCandidates(pool, { paperId: w.paperId, ownerId: w.owner, origin: 'user', single: true, facts: [{ evidence_id: lit.id, entity: 'ABC1 leaves', metric: 'fold change', value_text: '1.8', unit: 'fold', group: 'drought', comparison: 'control', n: 4, extraction_method: 'manual_entry' }] });
    await reviewFact(pool, { paperId: w.paperId, ownerId: w.owner, id: lf!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: lf!.content_hash } });
    const P3 = randomUUID();
    const content = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P3 }, content: [{ type: 'text', text: 'Under drought, leaf ABC1 fell 1.8-fold in leaves.' }] }] };
    const head = (await call('alice', 'POST', `/api/papers/${w.paperId}/documents/${w.documentId}/saves`, { expected_head_revision_id: w.head, content_json: content, schema_version: 1, reason: 'manual' })).json().id as string;
    const run = (await check(w, P3, 'alice', head)).json();
    expect(run.findings).toContainEqual(expect.objectContaining({ check: 'quantity', verdict: 'pass', fact_id: lf!.id, evidence_label: 'Kim 2019 text' }));
  });

  test('the request names a paragraph of a revision of this paper; another owner gets 404', async () => {
    const w = await world();
    expect((await check(w, randomUUID())).statusCode).toBe(422);
    expect((await check(w, P1, 'alice', randomUUID())).statusCode).toBe(404);
    expect((await check(w, P1, 'bob')).statusCode).toBe(404);
  });

  test('the Writer runs the gate on its proposals: a unit or group change fails the proposal; an unmapped number is shown as unknown', async () => {
    const w = await world();
    const ask = async (text: string) => {
      const r = await call('alice', 'POST', `/api/papers/${w.paperId}/writer/requests`, { mode: 'draft', outline_revision_id: w.outlineId, node_id: w.n1.node_id, document_id: w.documentId, base_revision_id: w.head, after_block_id: P1, idempotency_key: randomUUID() });
      expect(r.statusCode, r.body).toBe(201);
      const writer: Writer = { id: 'mock', label: 'MOCK', async write(c: ParagraphContract) { return { status: 'draft', paragraph: [{ type: 'text', text }], claim_ids: c.mandatory_claims.map((x) => x.id), fact_ids: [] }; } };
      await processDelivery(pool, { job_id: r.json().job.id, paper_id: w.paperId, intent: 'draft_paragraph' }, { workerId: 'w1', leaseMs: 60_000, handlers: writerHandlers(pool, writer) });
      const list = (await call('alice', 'GET', `/api/papers/${w.paperId}/writer/proposals?document_id=${w.documentId}`)).json();
      return list.find((p: { job_id: string }) => p.job_id === r.json().job.id) as { status: string; checks: { check: string; result: string; details?: string; finding?: Record<string, unknown> }[] };
    };
    const ok = await ask('ABC1 rises in roots under drought, 2.4-fold (n = 3).');
    expect(ok.status).toBe('PENDING');
    expect(ok.checks).toContainEqual(expect.objectContaining({ check: 'scientific', result: 'pass', finding: expect.objectContaining({ check: 'quantity', fact_id: w.f.id, evidence_label: 'roots qPCR' }) }));
    const unit = await ask('ABC1 rises in roots under drought, 2.4 mM (n = 3).');
    expect(unit.status).toBe('CHECK_FAILED');
    expect(unit.checks).toContainEqual(expect.objectContaining({ check: 'scientific', result: 'fail', details: expect.stringContaining('unit_mismatch') }));
    const group = await ask('ABC1 rises in roots of control plants, 2.4-fold (n = 3).');
    expect(group.status).toBe('CHECK_FAILED');
    expect(group.checks).toContainEqual(expect.objectContaining({ check: 'scientific', result: 'fail', details: expect.stringContaining('group_mismatch') }));
    const neg = await ask('ABC1 does not rise in roots under drought (2.4-fold, n = 3).');
    expect(neg.checks).toContainEqual(expect.objectContaining({ check: 'scientific', result: 'fail', details: expect.stringContaining('negation_changed') }));
    const vague = await ask('ABC1 rises in roots, 2.4-fold.');
    expect(vague.status).toBe('PENDING');
    expect(vague.checks).toContainEqual(expect.objectContaining({ check: 'scientific', result: 'unknown', details: expect.stringContaining('group_not_stated') }));
  });
});
