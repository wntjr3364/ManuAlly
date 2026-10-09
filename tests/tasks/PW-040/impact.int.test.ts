// PW-040 — detailed outline and change impact (spec 03 "변경 영향", "상태").
// TST-040A: from an approved node only that node's scope is generated (its goal, approved claims,
//   verified evidence and facts, its neighbours' transitions); when a source it relies on changes (a
//   claim or evidence withdrawn, a fact retracted, a figure redrawn, a cited work removed or retracted)
//   the node — and the paragraphs linked to it — show the impact until the user reviews it.
// TST-040B: a newer draft outline never replaces the approved one, and an impact on one node neither
//   blocks other nodes nor locks any manual editing.
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
import { createFigure, createReference } from '../../../packages/domain/src/references/index.ts';
import { ingestCandidate } from '../../../packages/domain/src/literature/index.ts';
import { addFigureVersion, linkFigureEvidence, recordFigureFile } from '../../../packages/domain/src/figures/index.ts';
import { checkDraftGate } from '../../../packages/domain/src/outlines/index.ts';
import { settledMaterial } from '../../../packages/search/src/retrieval/index.ts';

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

const call = (who: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url, headers: H[who], payload: payload as object | undefined });
const hex = () => [...Array(64)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
const brief = { purpose: 'Test whether ABC1 responds to drought in roots', audience: 'plant biologists', known_facts: [], missing_material: [], avoid_claims: [] };
const story = { question: 'Does ABC1 respond to drought?', main_message: 'ABC1 is drought-induced', novelty: 'x', evidence_links: [], competing_explanations: [], presentation_order: [], limitations: [] };
const node = (o: Record<string, unknown>) => ({ node_id: randomUUID(), parent_node_id: null, section: 'Results', role: 'result', paragraph_goal: 'goal', claim_ids: [], evidence_ids: [], requires_evidence: false, allowed_interpretation: '', exclusions: [], transition: '', word_budget_min: null, word_budget_max: null, ...o });

// a paper with an approved story and an approved outline of three paragraph plans:
// n1 (claim c1, evidence e1 with fact f1), n2 (claim c2, evidence e2), n3 (figure evidence e3 on figure v1)
async function world() {
  const owner = ids.alice!;
  const paperId = (await call('alice', 'POST', '/api/papers', { working_title: 'impact paper', article_type: 'research_article' })).json().id as string;
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
  const c1 = await claim('ABC1 rises 2.4-fold in roots.', e1.id);
  const c2 = await claim('ABC1 does not change in leaves.', e2.id);
  const draftClaim = await createClaim(pool, { paperId, ownerId: owner, body: { kind: 'interpretation', text: 'ABC1 protects roots.' } });
  // figure 1 v1 with a verified panel record
  const fig = await createFigure(pool, { paperId, ownerId: owner, kind: 'figure', title: 'ABC1' });
  const file = await recordFigureFile(pool, { paperId, ownerId: owner, sha256: hex(), byteSize: 10, media: 'image/png', name: 'f.png' });
  const v1 = await addFigureVersion(pool, { paperId, ownerId: owner, figureId: fig.id, body: { caption: 'v1', panels: [{ panel: 'A', unit: 'fold', groups: ['WT'] }], asset_id: file.id } });
  const e3r = await createEvidence(pool, { paperId, ownerId: owner, body: { kind: 'figure_panel', source_asset_revision_id: file.id, locator: { panel: 'A' }, label: 'Fig 1A' } });
  await reviewEvidence(pool, { paperId, ownerId: owner, id: e3r.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: e3r.content_hash } });
  await linkFigureEvidence(pool, { paperId, ownerId: owner, evidenceId: e3r.id, body: { figure_version_id: v1.version.id, panel: 'A' } });
  const n1 = node({ paragraph_goal: 'Show root induction', claim_ids: [c1.id, draftClaim.id], evidence_ids: [e1.id], requires_evidence: true, transition: 'Then leaves.' });
  const n2 = node({ paragraph_goal: 'Contrast with leaves', claim_ids: [c2.id], evidence_ids: [e2.id] });
  const n3 = node({ paragraph_goal: 'Figure 1 time course', evidence_ids: [e3r.id] });
  const o = (await call('alice', 'POST', `/api/papers/${paperId}/outline/revisions`, { parent_revision_id: null, story_revision_id: s.id, nodes: [n1, n2, n3] })).json();
  const approved = (await call('alice', 'POST', `/api/papers/${paperId}/outline/revisions/${o.id}/approve`, { intent: 'approve_outline', content_hash: o.content_hash })).json();
  expect(approved.status).toBe('APPROVED');
  return { paperId, owner, outlineId: o.id as string, contentHash: o.content_hash as string, storyId: s.id as string, n1, n2, n3, e1, e2, e3: e3r, f1: f1!, c1, c2, draftClaim, fig, file, v1 };
}
type W = Awaited<ReturnType<typeof world>>;
const gate = (w: W, nodeId: string, outlineId = w.outlineId) => checkDraftGate(pool, w.paperId, { instruction: 'draft it', node_id: nodeId, outline_revision_id: outlineId }).then(() => 'passed', (e: { details?: { reasons?: string[] } }) => e.details?.reasons ?? ['error']);
const impacts = async (w: W) => (await call('alice', 'GET', `/api/papers/${w.paperId}/outline/revisions/${w.outlineId}/impacts`)).json() as { node_id: string; change: string; key: string; resolved: boolean; paragraphs: unknown[]; detail: string }[];
const retract = (w: W, kind: 'claims' | 'facts' | 'evidence', id: string, hash: string) =>
  call('alice', 'POST', `/api/papers/${w.paperId}/${kind}/${id}/retract`, { intent: `retract_${kind === 'claims' ? 'claim' : kind === 'facts' ? 'fact' : 'evidence'}`, content_hash: hash });

describe('TST-040A: only the node\'s scope; changes of its sources are tracked', () => {
  test('the generation scope of an approved node is that node: its goal, approved claims, verified evidence and facts, neighbours\' transitions', async () => {
    const w = await world();
    const r = await call('alice', 'GET', `/api/papers/${w.paperId}/outline/revisions/${w.outlineId}/nodes/${w.n1.node_id}/scope`);
    expect(r.statusCode).toBe(200);
    const sc = r.json();
    expect(sc.node).toMatchObject({ node_id: w.n1.node_id, paragraph_goal: 'Show root induction', transition: 'Then leaves.' });
    expect(sc.claims.map((c: { id: string }) => c.id)).toEqual([w.c1.id]);
    expect(sc.excluded).toEqual([{ kind: 'claim', id: w.draftClaim.id, reason: 'not_approved' }]);
    expect(sc.evidence.map((e: { id: string }) => e.id)).toEqual([w.e1.id]);
    expect(sc.facts.map((f: { id: string }) => f.id)).toEqual([w.f1.id]);
    expect(sc.neighbours.next).toMatchObject({ node_id: w.n2.node_id, paragraph_goal: 'Contrast with leaves' });
    expect(sc.neighbours.previous).toBeNull();
    // nothing of the other nodes
    expect(JSON.stringify(sc)).not.toContain(w.c2.id);
    expect(JSON.stringify(sc)).not.toContain(w.e2.id);
    // only an approved node has a generation scope
    const d = (await call('alice', 'POST', `/api/papers/${w.paperId}/outline/revisions`, { parent_revision_id: w.outlineId, story_revision_id: w.storyId, nodes: [node({})] })).json();
    expect((await call('alice', 'GET', `/api/papers/${w.paperId}/outline/revisions/${d.id}/nodes/${d.nodes[0].node_id}/scope`)).statusCode).toBe(409);
  });

  test('a withdrawn claim marks its node (and the paragraphs linked to it) for impact review; other nodes are not touched', async () => {
    const w = await world();
    expect(await impacts(w)).toEqual([]);
    const docId = (await call('alice', 'POST', `/api/papers/${w.paperId}/documents`, { kind: 'manuscript' })).json().document.id;
    const block = randomUUID();
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/outline/revisions/${w.outlineId}/nodes/${w.n1.node_id}/paragraphs`, { document_id: docId, block_id: block })).statusCode).toBe(201);
    expect((await retract(w, 'claims', w.c1.id, w.c1.content_hash)).statusCode).toBe(200);
    const list = await impacts(w);
    expect(list).toEqual([expect.objectContaining({ node_id: w.n1.node_id, change: 'claim_withdrawn', resolved: false, paragraphs: [{ document_id: docId, block_id: block }] })]);
    expect(await gate(w, w.n1.node_id)).toEqual(['impact_review_required']);
    expect(await gate(w, w.n2.node_id)).toBe('passed');
    const o = (await call('alice', 'GET', `/api/papers/${w.paperId}/outline/revisions/${w.outlineId}`)).json();
    expect(o.nodes.map((n: { status: string }) => n.status)).toEqual(['IMPACT_REVIEW_REQUIRED', 'APPROVED', 'APPROVED']);
  });

  test('the user reviews an impact: the node may be drafted again, and the withdrawn claim is left out of its scope', async () => {
    const w = await world();
    await retract(w, 'claims', w.c1.id, w.c1.content_hash);
    const [imp] = await impacts(w);
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/outline/revisions/${w.outlineId}/impacts/resolve`, { node_id: w.n1.node_id, key: imp!.key })).statusCode).toBe(422);
    expect((await call('bob', 'POST', `/api/papers/${w.paperId}/outline/revisions/${w.outlineId}/impacts/resolve`, { intent: 'resolve_impact', node_id: w.n1.node_id, key: imp!.key })).statusCode).toBe(404);
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/outline/revisions/${w.outlineId}/impacts/resolve`, { intent: 'resolve_impact', node_id: w.n1.node_id, key: 'claim:nonexistent:withdrawn' })).statusCode).toBe(422);
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/outline/revisions/${w.outlineId}/impacts/resolve`, { intent: 'resolve_impact', node_id: w.n1.node_id, key: imp!.key })).statusCode).toBe(201);
    expect((await impacts(w))[0]).toMatchObject({ resolved: true });
    expect(await gate(w, w.n1.node_id)).toBe('passed');
    const sc = (await call('alice', 'GET', `/api/papers/${w.paperId}/outline/revisions/${w.outlineId}/nodes/${w.n1.node_id}/scope`)).json();
    expect(sc.claims).toEqual([]);
    expect(sc.excluded).toEqual(expect.arrayContaining([{ kind: 'claim', id: w.c1.id, reason: 'withdrawn' }]));
    await expect(pool.query('UPDATE outline_impact_resolutions SET resolution = resolution')).rejects.toThrow(/immutable/);
  });

  test('withdrawn evidence, a retracted fact and a redrawn figure are impacts of the nodes that rely on them; a newer figure version is a new impact', async () => {
    const w = await world();
    await retract(w, 'facts', w.f1.id, w.f1.content_hash);
    await retract(w, 'evidence', w.e2.id, w.e2.content_hash);
    await addFigureVersion(pool, { paperId: w.paperId, ownerId: w.owner, figureId: w.fig.id, body: { caption: 'v2', panels: [{ panel: 'A', unit: 'fold', groups: ['WT'] }], asset_id: w.file.id } });
    const list = await impacts(w);
    // c2 rests only on e2: withdrawing e2 also leaves the approved observation c2 unsupported (review MAJOR)
    expect(list.map((i) => [i.node_id, i.change]).sort()).toEqual([[w.n1.node_id, 'fact_withdrawn'], [w.n2.node_id, 'claim_unsupported'], [w.n2.node_id, 'evidence_withdrawn'], [w.n3.node_id, 'figure_version_changed']].sort());
    const fig = list.find((i) => i.change === 'figure_version_changed')!;
    await call('alice', 'POST', `/api/papers/${w.paperId}/outline/revisions/${w.outlineId}/impacts/resolve`, { intent: 'resolve_impact', node_id: w.n3.node_id, key: fig.key });
    expect(await gate(w, w.n3.node_id)).toBe('passed');
    await addFigureVersion(pool, { paperId: w.paperId, ownerId: w.owner, figureId: w.fig.id, body: { caption: 'v3', panels: [{ panel: 'A', unit: 'fold', groups: ['WT'] }], asset_id: w.file.id } });
    expect(await gate(w, w.n3.node_id)).toEqual(['impact_review_required']);
  });

  test('a cited work removed from the paper, or known to be retracted, is an impact of the nodes quoting it', async () => {
    const w = await world();
    const quote = async (title: string, doi: string) => {
      const r = await createReference(pool, { paperId: w.paperId, ownerId: w.owner, body: { title, authors: [{ family: 'Kim' }], doi } });
      const e = await createEvidence(pool, { paperId: w.paperId, ownerId: w.owner, body: { kind: 'literature_excerpt', reference_id: r.id, locator: { quote: `${title} quote` }, label: title } });
      await reviewEvidence(pool, { paperId: w.paperId, ownerId: w.owner, id: e.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: e.content_hash } });
      return { r, e };
    };
    const a = await quote('Removed work', '10.5555/pw040.removed');
    const b = await quote('Retracted work', '10.5555/pw040.retracted');
    const na = node({ paragraph_goal: 'Background A', role: 'background', evidence_ids: [a.e.id] });
    const nb = node({ paragraph_goal: 'Background B', role: 'background', evidence_ids: [b.e.id] });
    const o = (await call('alice', 'POST', `/api/papers/${w.paperId}/outline/revisions`, { parent_revision_id: w.outlineId, story_revision_id: w.storyId, nodes: [w.n1, w.n2, w.n3, na, nb] })).json();
    await call('alice', 'POST', `/api/papers/${w.paperId}/outline/revisions/${o.id}/approve`, { intent: 'approve_outline', content_hash: o.content_hash });
    await pool.query('UPDATE project_references SET removed_at = clock_timestamp() WHERE paper_id = $1 AND reference_id = $2', [w.paperId, a.r.id]);
    const s = (await pool.query("INSERT INTO literature_searches (paper_id, created_by, source, query, params, cache_key, endpoint, status) VALUES ($1, $2, 'crossref', 'q', '{}', repeat('d', 64), 'https://x', 'ok') RETURNING id", [w.paperId, w.owner])).rows[0].id;
    const cand = (await pool.query(`INSERT INTO literature_candidates (search_id, paper_id, source, rank, source_record_id, doi, title, authors, year, container, work_type, is_preprint, relations, update_notice)
      VALUES ($1, $2, 'crossref', 1, '10.5555/pw040.notice', '10.5555/pw040.notice', 'Retraction', '[]', 2024, 'J', 'journal-article', false, '{}', '{"type":"retraction","target_doi":"10.5555/pw040.retracted"}') RETURNING id`, [s, w.paperId])).rows[0].id;
    await ingestCandidate(pool, { ownerId: w.owner, candidateId: cand });
    const list = (await call('alice', 'GET', `/api/papers/${w.paperId}/outline/revisions/${o.id}/impacts`)).json() as { node_id: string; change: string }[];
    expect(list.map((i) => [i.node_id, i.change]).sort()).toEqual([[na.node_id, 'source_removed'], [nb.node_id, 'source_retracted']].sort());
  });

  test('retracting needs the explicit intent and the reviewed version; only approved or verified records can be retracted', async () => {
    const w = await world();
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/claims/${w.c1.id}/retract`, { content_hash: w.c1.content_hash })).statusCode).toBe(422);
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/claims/${w.c1.id}/retract`, { intent: 'retract_claim', content_hash: 'f'.repeat(64) })).statusCode).toBe(409);
    expect((await retract(w, 'claims', w.draftClaim.id, w.draftClaim.content_hash)).statusCode).toBe(409);
    expect((await call('bob', 'POST', `/api/papers/${w.paperId}/claims/${w.c1.id}/retract`, { intent: 'retract_claim', content_hash: w.c1.content_hash })).statusCode).toBe(404);
  });
});

describe('TST-040B: the approved outline stays in force; nothing unrelated is locked', () => {
  test('a newer draft outline does not replace the approved one for drafting', async () => {
    const w = await world();
    const d = (await call('alice', 'POST', `/api/papers/${w.paperId}/outline/revisions`, { parent_revision_id: w.outlineId, story_revision_id: w.storyId, nodes: [w.n1, w.n2] })).json();
    expect(await gate(w, w.n2.node_id)).toBe('passed');
    expect(await gate(w, w.n2.node_id, d.id)).toEqual(expect.arrayContaining(['outline_not_active']));
    expect((await call('alice', 'GET', `/api/papers/${w.paperId}/outline`)).json().active.id).toBe(w.outlineId);
  });

  test('an impact blocks only AI drafting of that node: manual edits of its linked paragraph still save', async () => {
    const w = await world();
    const d = (await call('alice', 'POST', `/api/papers/${w.paperId}/documents`, { kind: 'manuscript' })).json();
    const block = randomUUID();
    await call('alice', 'POST', `/api/papers/${w.paperId}/outline/revisions/${w.outlineId}/nodes/${w.n1.node_id}/paragraphs`, { document_id: d.document.id, block_id: block });
    await retract(w, 'claims', w.c1.id, w.c1.content_hash);
    const save = await call('alice', 'POST', `/api/papers/${w.paperId}/documents/${d.document.id}/saves`, { expected_head_revision_id: d.head.id, schema_version: 1, reason: 'manual',
      content_json: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: block }, content: [{ type: 'text', text: 'ABC1 rises in roots (fixed a typo).' }] }] } });
    expect(save.statusCode).toBe(201);
  });

  test('paragraph links belong to the paper; another user gets 404', async () => {
    const w = await world();
    const d = (await call('alice', 'POST', `/api/papers/${w.paperId}/documents`, { kind: 'manuscript' })).json();
    expect((await call('bob', 'POST', `/api/papers/${w.paperId}/outline/revisions/${w.outlineId}/nodes/${w.n1.node_id}/paragraphs`, { document_id: d.document.id, block_id: randomUUID() })).statusCode).toBe(404);
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/outline/revisions/${w.outlineId}/nodes/${randomUUID()}/paragraphs`, { document_id: d.document.id, block_id: randomUUID() })).statusCode).toBe(404);
  });
});

describe('review (PW-040)', () => {
  // a revision whose nodes are the world's plus extra ones, approved
  async function withNodes(w: W, extra: ReturnType<typeof node>[]) {
    const o = (await call('alice', 'POST', `/api/papers/${w.paperId}/outline/revisions`, { parent_revision_id: w.outlineId, story_revision_id: w.storyId, nodes: [w.n1, w.n2, w.n3, ...extra] })).json();
    await call('alice', 'POST', `/api/papers/${w.paperId}/outline/revisions/${o.id}/approve`, { intent: 'approve_outline', content_hash: o.content_hash });
    return o.id as string;
  }
  const impactsOf = async (w: W, rev: string) => (await call('alice', 'GET', `/api/papers/${w.paperId}/outline/revisions/${rev}/impacts`)).json() as { node_id: string; change: string; key: string }[];

  test('MAJOR: a node that lists only a claim sees the claim\'s evidence withdrawn; the claim is no longer settled anywhere', async () => {
    const w = await world();
    const n4 = node({ paragraph_goal: 'Leaf claim only', claim_ids: [w.c2.id] });
    const rev = await withNodes(w, [n4]);
    expect((await settledMaterial(pool, w.paperId, 'mock')).claimIds.has(w.c2.id)).toBe(true);
    await retract(w, 'evidence', w.e2.id, w.e2.content_hash);
    const mine = (await impactsOf(w, rev)).filter((i) => i.node_id === n4.node_id);
    expect(mine.map((i) => i.change).sort()).toEqual(['claim_unsupported', 'evidence_withdrawn']);
    expect(mine.find((i) => i.change === 'evidence_withdrawn')!.key).toBe(`via-claim:${w.c2.id}|evidence:${w.e2.id}:evidence_withdrawn`);
    expect(await gate(w, n4.node_id, rev)).toEqual(['impact_review_required']);
    const sc = (await call('alice', 'GET', `/api/papers/${w.paperId}/outline/revisions/${rev}/nodes/${n4.node_id}/scope`)).json();
    expect(sc.claims).toEqual([]);
    expect(sc.excluded).toEqual([{ kind: 'claim', id: w.c2.id, reason: 'claim_unsupported' }]);
    // PW-037/PW-039: no longer settled material
    const settled = await settledMaterial(pool, w.paperId, 'mock');
    expect(settled.claimIds.has(w.c2.id)).toBe(false);
    expect(settled.withheld).toEqual(expect.arrayContaining([{ kind: 'claim', id: w.c2.id, reason: 'claim_unsupported' }]));
  });

  test('MINOR 1: an archived figure is an impact of the nodes reading it', async () => {
    const w = await world();
    await pool.query('UPDATE figure_objects SET archived_at = clock_timestamp() WHERE id = $1', [w.fig.id]);
    expect((await impacts(w)).map((i) => [i.node_id, i.change])).toEqual([[w.n3.node_id, 'figure_archived']]);
  });

  test('MINOR 2: the generation scope leaves out what the gates withhold (a fact read from an older figure version)', async () => {
    const w = await world();
    const [f3] = await createFactCandidates(pool, { paperId: w.paperId, ownerId: w.owner, origin: 'user', single: true, facts: [{ evidence_id: w.e3.id, entity: 'ABC1 Fig1A', metric: 'fold change', value_text: '3.3', unit: 'fold', group: 'drought', comparison: 'control', n: 3, extraction_method: 'figure_reading' }] });
    await reviewFact(pool, { paperId: w.paperId, ownerId: w.owner, id: f3!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: f3!.content_hash } });
    const scope = async () => (await call('alice', 'GET', `/api/papers/${w.paperId}/outline/revisions/${w.outlineId}/nodes/${w.n3.node_id}/scope`)).json();
    expect((await scope()).facts.map((f: { id: string }) => f.id)).toEqual([f3!.id]);
    await addFigureVersion(pool, { paperId: w.paperId, ownerId: w.owner, figureId: w.fig.id, body: { caption: 'v2', panels: [{ panel: 'A', unit: 'fold', groups: ['WT'] }], asset_id: w.file.id } });
    const sc = await scope();
    expect(sc.facts).toEqual([]);
    expect(sc.excluded).toEqual([{ kind: 'fact', id: f3!.id, reason: 'read_from_older_figure_version' }]);
    expect((await call('alice', 'GET', `/api/papers/${w.paperId}/outline/revisions/${w.outlineId}/nodes/${w.n3.node_id}/scope?provider=other`)).statusCode).toBe(422);
  });

  test('nits: two reviews of the same impact at once are one review; a reference removed again is a new impact', async () => {
    const w = await world();
    await retract(w, 'claims', w.c1.id, w.c1.content_hash);
    const [imp] = await impacts(w);
    // another review of it is in flight (not yet committed) while this one checks and writes
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query("INSERT INTO outline_impact_resolutions (paper_id, outline_revision_id, node_id, impact_key, resolution, resolved_by) VALUES ($1, $2, $3, $4, 'reviewed', $5)", [w.paperId, w.outlineId, imp!.node_id, imp!.key, w.owner]);
      const mine = call('alice', 'POST', `/api/papers/${w.paperId}/outline/revisions/${w.outlineId}/impacts/resolve`, { intent: 'resolve_impact', node_id: imp!.node_id, key: imp!.key });
      await new Promise((r) => setTimeout(r, 300));
      await other.query('COMMIT');
      expect((await mine).statusCode).toBe(201);
    } finally {
      other.release();
    }
    // a quoted reference: removed, reviewed, added back, removed again
    const r = await createReference(pool, { paperId: w.paperId, ownerId: w.owner, body: { title: 'Again work', authors: [{ family: 'Kim' }] } });
    const e = await createEvidence(pool, { paperId: w.paperId, ownerId: w.owner, body: { kind: 'literature_excerpt', reference_id: r.id, locator: { quote: 'again quote' }, label: 'Again' } });
    await reviewEvidence(pool, { paperId: w.paperId, ownerId: w.owner, id: e.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: e.content_hash } });
    const n5 = node({ paragraph_goal: 'Quote again', role: 'background', evidence_ids: [e.id] });
    const rev = await withNodes(w, [n5]);
    const remove = () => pool.query('UPDATE project_references SET removed_at = clock_timestamp() WHERE paper_id = $1 AND reference_id = $2', [w.paperId, r.id]);
    await remove();
    const first = (await impactsOf(w, rev)).find((i) => i.node_id === n5.node_id)!;
    await call('alice', 'POST', `/api/papers/${w.paperId}/outline/revisions/${rev}/impacts/resolve`, { intent: 'resolve_impact', node_id: n5.node_id, key: first.key });
    await pool.query('UPDATE project_references SET removed_at = NULL WHERE paper_id = $1 AND reference_id = $2', [w.paperId, r.id]);
    await remove();
    expect(await gate(w, n5.node_id, rev)).toEqual(['impact_review_required']);
  });
});
