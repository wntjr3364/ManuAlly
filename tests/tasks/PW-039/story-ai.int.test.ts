// PW-039 — story alternatives from the paper's own material (spec 03 "Storyline", 06).
// TST-039A: each alternative shows its main message, the evidence it rests on (verified facts, approved
//   claims) and its limitations; the user adopts one, which becomes a new DRAFT story revision (the
//   brief untouched); approving it stays the user's separate act.
// TST-039B: the AI never settles a claim and never puts a result into the story that the data do not
//   hold: unknown evidence fails the run, a number that is not in the linked evidence (or the user's
//   own story) blocks adoption, suggested claims stay text, the brief cannot be changed.
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
import { createFigure } from '../../../packages/domain/src/references/index.ts';
import { addFigureVersion, linkFigureEvidence, recordFigureFile } from '../../../packages/domain/src/figures/index.ts';
import { processDelivery } from '../../../apps/worker/src/queue/index.ts';
import { storyHandlers, createMockStoryGenerator, type StoryGenerator, type StoryInput } from '../../../apps/worker/src/story/index.ts';

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
const brief = { purpose: 'Test whether ABC1 responds to drought in roots', audience: 'plant stress biologists', known_facts: [], missing_material: ['leaf data'], avoid_claims: ['ABC1 causes drought tolerance'] };
const story = { question: 'Does ABC1 respond to drought?', main_message: 'ABC1 is drought-induced', novelty: 'first root data', evidence_links: [], competing_explanations: [], presentation_order: ['induction'], limitations: ['single genotype'] };

// a paper with a story, verified facts (2.4-fold; 0.8-fold in leaves), an approved claim, and material
// that must NOT reach the generator (an unverified fact, a draft claim)
async function world(who = 'alice') {
  const owner = ids[who]!;
  const paperId = (await call(who, 'POST', '/api/papers', { working_title: 'story paper', article_type: 'research_article' })).json().id as string;
  const s = (await call(who, 'POST', `/api/papers/${paperId}/story/revisions`, { parent_revision_id: null, brief, story })).json();
  const ev = await createEvidence(pool, { paperId, ownerId: owner, body: { kind: 'experiment', locator: { note: 'qPCR, roots, day 3' }, label: 'Exp 1' } });
  await reviewEvidence(pool, { paperId, ownerId: owner, id: ev.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: ev.content_hash } });
  const fact = async (value: string, entity: string, group: string, verify = true) => {
    const [f] = await createFactCandidates(pool, { paperId, ownerId: owner, origin: 'user', single: true, facts: [{ evidence_id: ev.id, entity, metric: 'fold change', value_text: value, unit: 'fold', group, comparison: 'well-watered', n: 3, extraction_method: 'manual_entry' }] });
    if (verify) await reviewFact(pool, { paperId, ownerId: owner, id: f!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: f!.content_hash } });
    return f!;
  };
  const roots = await fact('2.4', 'ABC1 roots', 'drought roots');
  const leaves = await fact('0.8', 'ABC1 leaves', 'drought leaves');
  const unverified = await fact('7.7', 'ABC1 stems', 'drought stems', false);
  const claim = await createClaim(pool, { paperId, ownerId: owner, body: { kind: 'observation', text: 'ABC1 transcripts rise 2.4-fold in drought-stressed roots.' } });
  await linkClaimEvidence(pool, { paperId, ownerId: owner, claimId: claim.id, body: { evidence_id: ev.id, relation: 'supports' } });
  await approveClaim(pool, { paperId, ownerId: owner, id: claim.id, body: { intent: 'approve_claim', content_hash: claim.content_hash } });
  const draftClaim = await createClaim(pool, { paperId, ownerId: owner, body: { kind: 'interpretation', text: 'ABC1 protects roots.' } });
  return { paperId, owner, storyRevisionId: s.id as string, roots, leaves, unverified, claim, draftClaim };
}

// runs the job the API enqueued with the given generator (the worker path, fenced)
async function runJob(jobId: string, paperId: string, gen: StoryGenerator) {
  return processDelivery(pool, { job_id: jobId, paper_id: paperId, intent: 'propose_story' }, { workerId: 'w1', leaseMs: 60_000, handlers: storyHandlers(pool, gen) });
}
async function request(w: Awaited<ReturnType<typeof world>>, gen: StoryGenerator = createMockStoryGenerator(), who = 'alice') {
  const r = await call(who, 'POST', `/api/papers/${w.paperId}/story-alternatives/runs`, { base_story_revision_id: w.storyRevisionId, idempotency_key: randomUUID() });
  expect(r.statusCode).toBe(201);
  await runJob(r.json().job.id, w.paperId, gen);
  return { jobId: r.json().job.id as string, view: (await call(who, 'GET', `/api/papers/${w.paperId}/story-alternatives`)).json() };
}
const spy = (answer: (input: StoryInput) => unknown): StoryGenerator & { seen: StoryInput[] } => {
  const seen: StoryInput[] = [];
  return { id: 'mock', label: 'MOCK', seen, async propose(input) { seen.push(input); return answer(input); } };
};
const alt = (o: Record<string, unknown> = {}) => ({
  title: 'Root induction', question: 'Does drought induce ABC1 in roots?', main_message: 'Drought induces ABC1 2.4-fold in roots but not in leaves.',
  presentation_order: ['root induction', 'leaf contrast'], evidence_links: [], competing_explanations: ['osmotic stress rather than drought signalling'],
  limitations: ['single genotype', 'one time point'], evidence_gaps: ['no protein data'], claim_suggestions: [], ...o,
});

describe('TST-039A: alternatives with message, evidence and limits; the user adopts', () => {
  test('a run stores alternatives with their evidence resolved; nothing changes until the user adopts one', async () => {
    const w = await world();
    const { view } = await request(w);
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]).toMatchObject({ generator: 'mock', label: 'MOCK', base_story_revision_id: w.storyRevisionId });
    const alts = view.runs[0].alternatives;
    expect(alts.length).toBeGreaterThanOrEqual(2);
    for (const a of alts) {
      expect(a.main_message).toBeTruthy();
      expect(Array.isArray(a.limitations)).toBe(true);
      expect(a.adopted_story_revision_id).toBeNull();
    }
    // evidence is shown as the verified record it is, with its kind and id
    const first = alts[0];
    expect(first.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'fact', id: w.roots.id, role: 'supports', text: expect.stringContaining('2.4') })]));
    // nothing changed: the story is still the one revision
    expect((await call('alice', 'GET', `/api/papers/${w.paperId}/story`)).json().latest.id).toBe(w.storyRevisionId);
  });

  test('adopting makes a new DRAFT story revision from the alternative (the brief untouched); approval is separate', async () => {
    const w = await world();
    const { view } = await request(w);
    const a = view.runs[0].alternatives[0];
    const r = await call('alice', 'POST', `/api/papers/${w.paperId}/story-alternatives/${a.id}/adopt`, { intent: 'adopt_story_alternative', parent_revision_id: w.storyRevisionId });
    expect(r.statusCode).toBe(201);
    const rev = r.json();
    expect(rev).toMatchObject({ status: 'DRAFT', parent_revision_id: w.storyRevisionId, brief });
    expect(rev.story).toMatchObject({ question: a.question, main_message: a.main_message, limitations: a.limitations, competing_explanations: a.competing_explanations, presentation_order: a.presentation_order, novelty: story.novelty });
    expect(rev.story.evidence_links).toEqual(expect.arrayContaining([`fact:${w.roots.id}`]));
    // context links are shown, but the story records only what the message rests on (or contradicts)
    expect(rev.story.evidence_links).not.toContain(`fact:${w.leaves.id}`);
    // once only; the alternative remembers what it became
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/story-alternatives/${a.id}/adopt`, { intent: 'adopt_story_alternative', parent_revision_id: rev.id })).statusCode).toBe(409);
    const v2 = (await call('alice', 'GET', `/api/papers/${w.paperId}/story-alternatives`)).json();
    expect(v2.runs[0].alternatives[0].adopted_story_revision_id).toBe(rev.id);
    // the active (approved) story is unchanged until the user approves the new draft
    const st = (await call('alice', 'GET', `/api/papers/${w.paperId}/story`)).json();
    expect(st.latest.id).toBe(rev.id);
    expect(st.active?.id ?? null).not.toBe(rev.id);
  });

  test('adoption needs the intent and the current parent; another user gets 404', async () => {
    const w = await world();
    const { view } = await request(w);
    const [a, b] = view.runs[0].alternatives;
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/story-alternatives/${a.id}/adopt`, { parent_revision_id: w.storyRevisionId })).statusCode).toBe(422);
    expect((await call('bob', 'POST', `/api/papers/${w.paperId}/story-alternatives/${a.id}/adopt`, { intent: 'adopt_story_alternative', parent_revision_id: w.storyRevisionId })).statusCode).toBe(404);
    const ok = await call('alice', 'POST', `/api/papers/${w.paperId}/story-alternatives/${a.id}/adopt`, { intent: 'adopt_story_alternative', parent_revision_id: w.storyRevisionId });
    expect(ok.statusCode).toBe(201);
    // the story moved on: adopting another alternative against the old parent is stale
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/story-alternatives/${b.id}/adopt`, { intent: 'adopt_story_alternative', parent_revision_id: w.storyRevisionId })).statusCode).toBe(409);
  });
});

describe('TST-039B: the AI settles nothing and adds no result the data do not hold', () => {
  test('the generator sees only verified facts and approved claims, and the brief as the user wrote it', async () => {
    const w = await world();
    const g = spy((input) => ({ alternatives: [alt({ evidence_links: [{ kind: 'fact', id: input.facts[0]!.id, role: 'supports' }] })] }));
    await request(w, g);
    const input = g.seen[0]!;
    expect(input.facts.map((f) => f.id).sort()).toEqual([w.roots.id, w.leaves.id].sort());
    expect(input.claims.map((c) => c.id)).toEqual([w.claim.id]);
    expect(JSON.stringify(input)).not.toContain('7.7');
    expect(JSON.stringify(input)).not.toContain('ABC1 protects roots');
    expect(input.brief).toMatchObject({ purpose: brief.purpose, avoid_claims: brief.avoid_claims });
  });

  test('an answer naming evidence that is not this paper\'s verified material fails the run; nothing is stored', async () => {
    const w = await world();
    for (const bad of [w.unverified.id, w.draftClaim.id, randomUUID()]) {
      const { view, jobId } = await request(w, spy(() => ({ alternatives: [alt({ evidence_links: [{ kind: 'fact', id: bad, role: 'supports' }] })] })));
      expect((await pool.query('SELECT status, last_error FROM jobs WHERE id = $1', [jobId])).rows[0]).toMatchObject({ status: 'FAILED', last_error: expect.stringMatching(/evidence/) });
      expect(view.runs).toHaveLength(0);
    }
  });

  test('the answer cannot change the brief, carry extra fields or approve anything', async () => {
    const w = await world();
    for (const bad of [
      { alternatives: [alt({ purpose: 'something else' })] },
      { alternatives: [alt()], brief: { purpose: 'x' } },
      { alternatives: [alt({ approved: true })] },
      { alternatives: [] },
      { alternatives: Array.from({ length: 6 }, () => alt()) },
    ]) {
      const { view } = await request(w, spy(() => bad));
      expect(view.runs).toHaveLength(0);
    }
  });

  test('a number that is not in the linked evidence (or the user\'s own story) blocks adoption; it is shown why', async () => {
    const w = await world();
    const { view } = await request(w, spy((input) => ({
      alternatives: [
        alt({ title: 'inflated', main_message: 'Drought induces ABC1 3.1-fold in roots.', evidence_links: [{ kind: 'fact', id: input.facts.find((f) => f.text.includes('roots'))!.id, role: 'supports' }] }),
        alt({ title: 'faithful', evidence_links: [{ kind: 'fact', id: input.facts.find((f) => f.text.includes('roots'))!.id, role: 'supports' }, { kind: 'fact', id: input.facts.find((f) => f.text.includes('leaves'))!.id, role: 'context' }] }),
        alt({ title: 'unlinked number', main_message: 'ABC1 rises 2.4-fold.', evidence_links: [] }),
      ],
    })));
    const [inflated, faithful, unlinked] = view.runs[0].alternatives;
    expect(inflated.blocked_reasons).toEqual(['number_not_in_evidence:3.1']);
    expect(faithful.blocked_reasons).toEqual([]);
    expect(unlinked.blocked_reasons).toEqual(['number_not_in_evidence:2.4']);
    expect(unlinked.warnings).toContain('no_supporting_evidence');
    const r = await call('alice', 'POST', `/api/papers/${w.paperId}/story-alternatives/${inflated.id}/adopt`, { intent: 'adopt_story_alternative', parent_revision_id: w.storyRevisionId });
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toMatch(/3\.1/);
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/story-alternatives/${faithful.id}/adopt`, { intent: 'adopt_story_alternative', parent_revision_id: w.storyRevisionId })).statusCode).toBe(201);
  });

  test('suggested claims stay suggestions: no claim is created or approved by a run or an adoption', async () => {
    const w = await world();
    const before = (await pool.query('SELECT id, approval_state FROM claims WHERE paper_id = $1 ORDER BY id', [w.paperId])).rows;
    const { view } = await request(w, spy((input) => ({ alternatives: [alt({ evidence_links: [{ kind: 'claim', id: input.claims[0]!.id, role: 'supports' }], claim_suggestions: ['ABC1 is required for root drought tolerance.'] })] })));
    const a = view.runs[0].alternatives[0];
    expect(a.claim_suggestions).toEqual(['ABC1 is required for root drought tolerance.']);
    await call('alice', 'POST', `/api/papers/${w.paperId}/story-alternatives/${a.id}/adopt`, { intent: 'adopt_story_alternative', parent_revision_id: w.storyRevisionId });
    expect((await pool.query('SELECT id, approval_state FROM claims WHERE paper_id = $1 ORDER BY id', [w.paperId])).rows).toEqual(before);
  });

  test('stored alternatives cannot be edited; adoption is decided once', async () => {
    const w = await world();
    const { view } = await request(w);
    const a = view.runs[0].alternatives[0];
    await expect(pool.query("UPDATE story_alternatives SET content = '{}' WHERE id = $1", [a.id])).rejects.toThrow(/immutable|decided/);
  });

  test('a number the user wrote in the brief or story may be restated without a link', async () => {
    const w = await world();
    const rev = (await call('alice', 'POST', `/api/papers/${w.paperId}/story/revisions`, { parent_revision_id: w.storyRevisionId, brief: { ...brief, known_facts: ['ABC1 induced 2.4-fold'] }, story })).json();
    const r = await call('alice', 'POST', `/api/papers/${w.paperId}/story-alternatives/runs`, { base_story_revision_id: rev.id, idempotency_key: randomUUID() });
    await runJob(r.json().job.id, w.paperId, spy(() => ({ alternatives: [alt({ main_message: 'ABC1 rises 2.4-fold.', evidence_links: [] })] })));
    const view = (await call('alice', 'GET', `/api/papers/${w.paperId}/story-alternatives`)).json();
    expect(view.runs[0].alternatives[0].blocked_reasons).toEqual([]);
  });

  test('a real provider gets nothing from a paper that does not allow sending to it', async () => {
    const w = await world();
    const g = spy(() => ({ alternatives: [alt()] }));
    (g as { id: string }).id = 'claude_agent';
    const r = await call('alice', 'POST', `/api/papers/${w.paperId}/story-alternatives/runs`, { base_story_revision_id: w.storyRevisionId, idempotency_key: randomUUID() });
    await runJob(r.json().job.id, w.paperId, g);
    expect(g.seen).toHaveLength(0);
    expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [r.json().job.id])).rows[0].status).toBe('WAITING_USER');
  });
});

describe('review (PW-039)', () => {
  const rootsLink = (input: StoryInput) => ({ kind: 'fact', id: input.facts.find((f) => f.text.includes('roots'))!.id, role: 'supports' });
  test('MAJOR: numbers written with units, x, words, ranges or notation are checked too', async () => {
    const w = await world();
    const messages = ['ABC1 rises 9x under drought', 'ABC1 rises tenfold in roots', 'ABC1 rises 50mM-dependently in 72h', 'a 2-9 fold rise in roots', 'p < 10⁻⁶ in roots'];
    const { view } = await request(w, spy((input) => ({ alternatives: messages.map((m) => alt({ title: 'numbers', main_message: m, evidence_links: [rootsLink(input)] })) })));
    expect(view.runs[0].alternatives.map((a: { blocked_reasons: string[] }) => a.blocked_reasons)).toEqual([
      ['number_not_in_evidence:9'], ['number_not_in_evidence:10'], ['number_not_in_evidence:50', 'number_not_in_evidence:72'], ['number_not_in_evidence:2', 'number_not_in_evidence:9'], ['number_not_in_evidence:0.000001'],
    ]);
  });

  test('MINOR 1: a number from a context link (which the story does not keep) does not count', async () => {
    const w = await world();
    const { view } = await request(w, spy((input) => ({ alternatives: [alt({ main_message: 'ABC1 rises 0.8-fold in roots', evidence_links: [rootsLink(input), { kind: 'fact', id: input.facts.find((f) => f.text.includes('leaves'))!.id, role: 'context' }] })] })));
    expect(view.runs[0].alternatives[0].blocked_reasons).toEqual(['number_not_in_evidence:0.8']);
  });

  test('MINOR 2: an alternative made from an older story version cannot bring that version back', async () => {
    const w = await world();
    const { view } = await request(w);
    const rev2 = (await call('alice', 'POST', `/api/papers/${w.paperId}/story/revisions`, { parent_revision_id: w.storyRevisionId, brief: { ...brief, purpose: 'A sharper purpose' }, story: { ...story, novelty: 'new novelty' } })).json();
    const r = await call('alice', 'POST', `/api/papers/${w.paperId}/story-alternatives/${view.runs[0].alternatives[0].id}/adopt`, { intent: 'adopt_story_alternative', parent_revision_id: rev2.id });
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toMatch(/older story/);
    expect((await call('alice', 'GET', `/api/papers/${w.paperId}/story`)).json().latest.id).toBe(rev2.id);
  });

  test('MINOR 3: material the paragraph context would withhold (here: read from an older figure version) is not given and cannot be linked', async () => {
    const w = await world();
    const hex = () => [...Array(64)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    const fig = await createFigure(pool, { paperId: w.paperId, ownerId: w.owner, kind: 'figure', title: 'ABC1' });
    const file = await recordFigureFile(pool, { paperId: w.paperId, ownerId: w.owner, sha256: hex(), byteSize: 10, media: 'image/png', name: 'f.png' });
    const v1 = await addFigureVersion(pool, { paperId: w.paperId, ownerId: w.owner, figureId: fig.id, body: { caption: 'v1', panels: [{ panel: 'A', unit: 'fold', groups: ['WT'] }], asset_id: file.id } });
    const fev = await createEvidence(pool, { paperId: w.paperId, ownerId: w.owner, body: { kind: 'figure_panel', source_asset_revision_id: file.id, locator: { panel: 'A' }, label: 'Fig 1A' } });
    await reviewEvidence(pool, { paperId: w.paperId, ownerId: w.owner, id: fev.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: fev.content_hash } });
    await linkFigureEvidence(pool, { paperId: w.paperId, ownerId: w.owner, evidenceId: fev.id, body: { figure_version_id: v1.version.id, panel: 'A' } });
    const [old] = await createFactCandidates(pool, { paperId: w.paperId, ownerId: w.owner, origin: 'user', single: true, facts: [{ evidence_id: fev.id, entity: 'ABC1 panel', metric: 'fold change', value_text: '5.5', unit: 'fold', group: 'drought', comparison: 'control', n: 3, extraction_method: 'figure_reading' }] });
    await reviewFact(pool, { paperId: w.paperId, ownerId: w.owner, id: old!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: old!.content_hash } });
    await addFigureVersion(pool, { paperId: w.paperId, ownerId: w.owner, figureId: fig.id, body: { caption: 'v2', panels: [{ panel: 'A', unit: 'fold', groups: ['WT'] }], asset_id: file.id } });
    const g = spy(() => ({ alternatives: [alt({ evidence_links: [{ kind: 'fact', id: old!.id, role: 'supports' }] })] }));
    const { view, jobId } = await request(w, g);
    expect(g.seen[0]!.facts.map((f) => f.id)).not.toContain(old!.id);
    expect(view.runs).toHaveLength(0);
    expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [jobId])).rows[0].status).toBe('FAILED');
  });

  test('nits: numbers in suggestions are flagged; digits inside ids in the story do not count as the user\'s numbers', async () => {
    const w = await world();
    const rev = (await call('alice', 'POST', `/api/papers/${w.paperId}/story/revisions`, { parent_revision_id: w.storyRevisionId, brief, story: { ...story, evidence_links: ['fact:00000000-0000-4000-8000-000000004567'] } })).json();
    const r = await call('alice', 'POST', `/api/papers/${w.paperId}/story-alternatives/runs`, { base_story_revision_id: rev.id, idempotency_key: randomUUID() });
    await runJob(r.json().job.id, w.paperId, spy((input) => ({ alternatives: [alt({ main_message: 'ABC1 rises 4567 times', evidence_links: [rootsLink(input)], claim_suggestions: ['ABC1 rises 50-fold'] })] })));
    const a = (await call('alice', 'GET', `/api/papers/${w.paperId}/story-alternatives`)).json().runs[0].alternatives[0];
    expect(a.blocked_reasons).toEqual(['number_not_in_evidence:4567']);
    expect(a.warnings).toContain('suggestion_number_not_in_evidence:50');
  });
});
