// PW-046 — the researcher's path from an approved outline to written paragraphs, for different article
// types (spec 06 "섹션 역할": Resource/Software/Methods papers get a fitting structure, never a forced
// IMRaD; spec 03: the user's novelty is changed only by the user).
// TST-046A: the approved outline's sections become the manuscript's headings (only the missing ones,
//   in outline order), and a paragraph written for a plan lands in that plan's section by default.
// TST-046B: section templates are suggestions (any section is accepted); a software paper gets its own
//   sections, not Introduction/Methods/Results/Discussion; a list is fine where a protocol is; and
//   nothing in the writing path changes the story's novelty.
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
import { writerHandlers, createMockWriter } from '../../../apps/worker/src/writer/index.ts';
import { proseSignals } from '../../../packages/domain/src/scientific-checks/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
const H: Record<string, Record<string, string>> = {};
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  for (const u of ['alice', 'bob']) {
    await createOwner(pool, { username: u, password: 'correct horse battery' });
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
const node = (o: Record<string, unknown>) => ({ node_id: randomUUID(), parent_node_id: null, role: 'result', paragraph_goal: 'goal', claim_ids: [], evidence_ids: [], requires_evidence: false, allowed_interpretation: '', exclusions: [], transition: '', word_budget_min: null, word_budget_max: null, ...o });
const NOVELTY = 'First root-specific drought marker in this species';

// a paper of the given type with an approved story and an approved outline of the given sections;
// every plan carries the verified fact and the approved claim (a plan without one is NEEDS_EVIDENCE)
async function paper(articleType: string, sections: string[]) {
  const p = (await call('alice', 'POST', '/api/papers', { working_title: `${articleType} paper`, article_type: articleType })).json();
  const owner = p.owner_id as string;
  const s = (await call('alice', 'POST', `/api/papers/${p.id}/story/revisions`, { parent_revision_id: null, brief: { purpose: 'Show the result', audience: 'x', known_facts: [], missing_material: [], avoid_claims: [] }, story: { question: 'q', main_message: 'm', novelty: NOVELTY, evidence_links: [], competing_explanations: [], presentation_order: [], limitations: [] } })).json();
  await call('alice', 'POST', `/api/papers/${p.id}/story/revisions/${s.id}/approve`, { intent: 'approve_story', content_hash: s.content_hash });
  const e = await createEvidence(pool, { paperId: p.id, ownerId: owner, body: { kind: 'experiment', locator: { note: 'run 1' }, label: 'benchmark run' } });
  await reviewEvidence(pool, { paperId: p.id, ownerId: owner, id: e.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: e.content_hash } });
  const [f] = await createFactCandidates(pool, { paperId: p.id, ownerId: owner, origin: 'user', single: true, facts: [{ evidence_id: e.id, entity: 'ABC1 roots', metric: 'fold change', value_text: '2.4', unit: 'fold', group: 'drought', comparison: 'control', n: 3, extraction_method: 'manual_entry' }] });
  await reviewFact(pool, { paperId: p.id, ownerId: owner, id: f!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: f!.content_hash } });
  const c = await createClaim(pool, { paperId: p.id, ownerId: owner, body: { kind: 'observation', text: 'ABC1 rises in roots under drought.' } });
  await linkClaimEvidence(pool, { paperId: p.id, ownerId: owner, claimId: c.id, body: { evidence_id: e.id, relation: 'supports' } });
  await approveClaim(pool, { paperId: p.id, ownerId: owner, id: c.id, body: { intent: 'approve_claim', content_hash: c.content_hash } });
  const nodes = sections.map((section) => node({ section, paragraph_goal: `${section} paragraph`, claim_ids: [c.id], evidence_ids: [e.id] }));
  const o = (await call('alice', 'POST', `/api/papers/${p.id}/outline/revisions`, { parent_revision_id: null, story_revision_id: s.id, nodes })).json();
  expect(o.id, JSON.stringify(o)).toBeTruthy();
  await call('alice', 'POST', `/api/papers/${p.id}/outline/revisions/${o.id}/approve`, { intent: 'approve_outline', content_hash: o.content_hash });
  const d = (await call('alice', 'POST', `/api/papers/${p.id}/documents`, { kind: 'manuscript' })).json();
  return { paperId: p.id as string, storyId: s.id as string, outlineId: o.id as string, nodes, documentId: d.document.id as string, head: d.head.id as string };
}
type P = Awaited<ReturnType<typeof paper>>;
const doc = async (x: P) => (await call('alice', 'GET', `/api/papers/${x.paperId}/documents/${x.documentId}`)).json() as { head: { id: string; content_json: { content: { type: string; attrs: { id: string }; content?: { text?: string }[] }[] } } };
const shapeOf = (blocks: { type: string; content?: { text?: string }[] }[]) => blocks.map((b) => `${b.type === 'heading' ? '#' : ''}${(b.content ?? []).map((t) => t.text ?? '').join('')}`);
const scaffold = (x: P, head: string, outline = x.outlineId) => call('alice', 'POST', `/api/papers/${x.paperId}/documents/${x.documentId}/scaffold`, { outline_revision_id: outline, expected_head_revision_id: head });
async function draft(x: P, nodeId: string, head: string) {
  const r = await call('alice', 'POST', `/api/papers/${x.paperId}/writer/requests`, { mode: 'draft', outline_revision_id: x.outlineId, node_id: nodeId, document_id: x.documentId, base_revision_id: head, idempotency_key: randomUUID() });
  expect(r.statusCode, r.body).toBe(201);
  await processDelivery(pool, { job_id: r.json().job.id, paper_id: x.paperId, intent: 'draft_paragraph' }, { workerId: 'w1', leaseMs: 60_000, handlers: writerHandlers(pool, createMockWriter()) });
  const p = (await call('alice', 'GET', `/api/papers/${x.paperId}/writer/proposals?document_id=${x.documentId}`)).json()[0];
  const a = await call('alice', 'POST', `/api/papers/${x.paperId}/writer/proposals/${p.id}/apply`, { intent: 'apply_paragraph', proposal_hash: p.proposal_hash, expected_revision_id: p.base_revision_id });
  expect(a.statusCode, a.body).toBe(200);
  return a.json().revision_id as string;
}

describe('TST-046A: the outline\'s sections and roles reach the manuscript', () => {
  test('a research article: the approved outline\'s sections become headings in outline order; a paragraph lands in its plan\'s section', async () => {
    const x = await paper('research_article', ['Introduction', 'Results', 'Discussion']);
    const r = await scaffold(x, x.head);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().added).toEqual(['Introduction', 'Results', 'Discussion']);
    let d = await doc(x);
    expect(shapeOf(d.head.content_json.content)).toEqual(['#Introduction', '#Results', '#Discussion']);
    // the Results plan (with its claim and fact): its paragraph goes under Results, before Discussion
    const h1 = await draft(x, x.nodes[1]!.node_id, d.head.id);
    d = await doc(x);
    expect(d.head.id).toBe(h1);
    const shape = shapeOf(d.head.content_json.content);
    expect(shape[0]).toBe('#Introduction');
    expect(shape[1]).toBe('#Results');
    expect(shape[2]).toContain('ABC1 rises in roots under drought');
    expect(shape[3]).toBe('#Discussion');
    // the Discussion plan's paragraph goes after Discussion (the end), the Introduction plan's before Results
    await draft(x, x.nodes[2]!.node_id, d.head.id);
    d = await doc(x);
    await draft(x, x.nodes[0]!.node_id, d.head.id);
    d = await doc(x);
    expect(shapeOf(d.head.content_json.content).map((s) => (s.startsWith('#') ? s : 'p'))).toEqual(['#Introduction', 'p', '#Results', 'p', '#Discussion', 'p']);
  });

  test('scaffolding adds only missing sections, keeps what the user wrote, needs the approved outline and the current head', async () => {
    const x = await paper('research_article', ['Introduction', 'Results']);
    const typed = { type: 'doc', content: [{ type: 'heading', attrs: { id: randomUUID(), level: 1 }, content: [{ type: 'text', text: 'introduction' }] }, { type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text: 'My own opening.' }] }] };
    const head = (await call('alice', 'POST', `/api/papers/${x.paperId}/documents/${x.documentId}/saves`, { expected_head_revision_id: x.head, content_json: typed, schema_version: 1, reason: 'manual' })).json().id as string;
    expect((await scaffold(x, x.head)).statusCode).toBe(409); // not the current head
    expect((await scaffold(x, head, randomUUID())).statusCode).toBe(409); // not the approved outline
    const r = await scaffold(x, head);
    expect(r.json().added).toEqual(['Results']);
    const d = await doc(x);
    expect(shapeOf(d.head.content_json.content)).toEqual(['#introduction', 'My own opening.', '#Results']);
    const again = await scaffold(x, d.head.id);
    expect(again.json()).toMatchObject({ added: [], revision_id: null });
    expect((await call('bob', 'POST', `/api/papers/${x.paperId}/documents/${x.documentId}/scaffold`, { outline_revision_id: x.outlineId, expected_head_revision_id: d.head.id })).statusCode).toBe(404);
  });
  test('a missing section goes after its outline predecessor, between the user\'s sections; a repeated section is one heading; only a manuscript is scaffolded', async () => {
    const x = await paper('research_article', ['Introduction', 'Results', 'Results', 'Discussion']);
    const h = (t: string) => ({ type: 'heading', attrs: { id: randomUUID(), level: 1 }, content: [{ type: 'text', text: t }] });
    const p = (t: string) => ({ type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text: t }] });
    const sub = { type: 'heading', attrs: { id: randomUUID(), level: 2 }, content: [{ type: 'text', text: 'Background' }] };
    const typed = { type: 'doc', content: [h('Introduction'), p('Opening.'), sub, p('More.'), h('Discussion'), p('Closing.')] };
    const head = (await call('alice', 'POST', `/api/papers/${x.paperId}/documents/${x.documentId}/saves`, { expected_head_revision_id: x.head, content_json: typed, schema_version: 1, reason: 'manual' })).json().id as string;
    const r = await scaffold(x, head);
    expect(r.json().added).toEqual(['Results']);
    // after the whole Introduction section (its level-2 subsection included), before Discussion
    expect(shapeOf((await doc(x)).head.content_json.content)).toEqual(['#Introduction', 'Opening.', '#Background', 'More.', '#Results', '#Discussion', 'Closing.']);
    const notes = (await call('alice', 'POST', `/api/papers/${x.paperId}/documents`, { kind: 'notes' })).json();
    const n = await call('alice', 'POST', `/api/papers/${x.paperId}/documents/${notes.document.id}/scaffold`, { outline_revision_id: x.outlineId, expected_head_revision_id: notes.head.id });
    expect(n.statusCode).toBe(422);
  });
});

describe('TST-046B: no forced IMRaD, no report lists by force, novelty untouched', () => {
  test('section templates are suggestions per article type; a software paper\'s are its own', async () => {
    const t = async (type: string) => {
      const p = (await call('alice', 'POST', '/api/papers', { working_title: type, article_type: type })).json();
      return (await call('alice', 'GET', `/api/papers/${p.id}/section-template`)).json();
    };
    const sw = await t('software_resource');
    expect(sw).toMatchObject({ article_type: 'software_resource', enforced: false });
    expect(sw.sections.map((s: { section: string }) => s.section)).toEqual(expect.arrayContaining(['Implementation', 'Availability']));
    expect(sw.sections.map((s: { section: string }) => s.section)).not.toContain('Methods');
    expect((await t('research_article')).sections.map((s: { section: string }) => s.section)).toEqual(expect.arrayContaining(['Introduction', 'Results', 'Discussion', 'Methods']));
    expect((await t('short_communication')).sections.length).toBeLessThanOrEqual(1);
  });

  test('a software paper\'s outline (its own sections) becomes its headings; no IMRaD section is added; a protocol list is not flagged', async () => {
    const x = await paper('software_resource', ['Background', 'Implementation', 'Use cases', 'Availability']);
    expect((await scaffold(x, x.head)).json().added).toEqual(['Background', 'Implementation', 'Use cases', 'Availability']);
    const d = await doc(x);
    const headings = shapeOf(d.head.content_json.content);
    expect(headings).toEqual(['#Background', '#Implementation', '#Use cases', '#Availability']);
    for (const imrad of ['#Introduction', '#Methods', '#Results', '#Discussion']) expect(headings).not.toContain(imrad);
    await draft(x, x.nodes[1]!.node_id, d.head.id);
    const after = shapeOf((await doc(x)).head.content_json.content);
    expect(after.indexOf('#Implementation')).toBe(after.findIndex((s) => !s.startsWith('#')) - 1);
    // enumerated steps where a protocol is described are not a report-style warning
    for (const s of ['Implementation', 'Installation', 'Usage', 'Materials and Methods', 'Protocol']) expect(proseSignals('1. Install the package. 2. Run the tool.', s)).toEqual([]);
    expect(proseSignals('1. Background. 2. Result. 3. Importance.', 'Discussion')).toEqual(['enumerated_list']);
  });

  test('the writing path never changes the story: the novelty stays as the user approved it', async () => {
    const x = await paper('software_resource', ['Background', 'Implementation']);
    await scaffold(x, x.head);
    await draft(x, x.nodes[1]!.node_id, (await doc(x)).head.id);
    const story = (await call('alice', 'GET', `/api/papers/${x.paperId}/story`)).json();
    expect(story.revisions ?? [story.latest]).toHaveLength(1);
    expect((story.active ?? story.latest).story.novelty).toBe(NOVELTY);
  });

  test('a writing profile can describe the roles of a software paper\'s own sections', async () => {
    const x = await paper('software_resource', ['Implementation']);
    const r = await call('alice', 'POST', `/api/papers/${x.paperId}/writing-profile/revisions`, { parent_revision_id: null, content: {
      article_type: 'software_resource', target_audience: 'tool users', preferred_english_variant: 'US', concision_preference: 'concise', claim_strength_policy: '',
      terminology: [], section_roles: [{ section: 'Implementation', role: 'describe the design', principles: [{ text: 'Name each component before its interface', sources: [] }], counterexamples: [] }],
      rhetoric_patterns: [], anti_examples: [], accepted_examples: [],
    } });
    expect(r.statusCode, r.body).toBe(201);
  });
});
