// PW-033 — AI literature candidate curation (spec 05 "논문을 AI가 선정하는 방식", 06).
// TST-033A: each candidate's use (scientific / writing / both / excluded), fit and exclusion reason are
//   stored and shown to the user; nothing is adopted until the user decides.
// TST-033B: citation counts never establish writing quality (style needs the text, which metadata
//   alone does not give), and finding a candidate never changes an approved profile or the paper.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { enqueueJob } from '../../../packages/domain/src/jobs/index.ts';
import { processDelivery } from '../../../apps/worker/src/queue/index.ts';
import { curationHandlers, createMockAssessor, type CurationAssessor } from '../../../apps/worker/src/curation/index.ts';

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
const brief = { purpose: 'Test whether ABC1 responds to drought in roots', audience: 'plant stress biologists', known_facts: ['ABC1 induced 2.4-fold'], missing_material: [], avoid_claims: [] };
const story = { question: 'Does ABC1 respond to drought?', main_message: 'ABC1 is drought-induced', novelty: 'none yet', evidence_links: [], competing_explanations: [], presentation_order: ['induction'], limitations: ['single genotype'] };

type Cand = { doi: string | null; title: string; work_type?: string; is_preprint?: boolean; update_notice?: unknown; source_record_id?: string };
async function paperWithSearch(who: string, cands: Cand[]) {
  const p = (await call(who, 'POST', '/api/papers', { working_title: 'curation paper', article_type: 'research_article' })).json();
  await call(who, 'POST', `/api/papers/${p.id}/story/revisions`, { parent_revision_id: null, brief, story });
  const s = (await pool.query("INSERT INTO literature_searches (paper_id, created_by, source, query, params, cache_key, endpoint, status) VALUES ($1, $2, 'crossref', 'ABC1 drought', '{}', repeat('b', 64), 'https://api.crossref.org/works', 'ok') RETURNING id", [p.id, ids[who]])).rows[0].id;
  const candIds: string[] = [];
  for (const [i, c] of cands.entries()) {
    candIds.push((await pool.query(
      `INSERT INTO literature_candidates (search_id, paper_id, source, rank, source_record_id, doi, title, authors, year, container, work_type, is_preprint, relations, update_notice)
       VALUES ($1, $2, 'crossref', $3, $4, $5, $6, '[{"family":"Kim"}]', 2021, 'Synthetic Journal', $7, $8, '{}', $9) RETURNING id`,
      [s, p.id, i + 1, c.source_record_id ?? c.doi ?? randomUUID(), c.doi, c.title, c.work_type ?? 'journal-article', c.is_preprint ?? false, c.update_notice ? JSON.stringify(c.update_notice) : null])).rows[0].id);
  }
  return { paperId: p.id as string, searchId: s as string, candIds };
}
const CANDS: Cand[] = [
  { doi: '10.5555/cur.1', title: 'ABC1 induction under drought in roots' },
  { doi: '10.5555/cur.2', title: 'A highly cited review of drought signalling', work_type: 'journal-article' },
  { doi: '10.5555/cur.3', title: 'ABC1 drought response (preprint)', work_type: 'posted-content', is_preprint: true },
  { doi: '10.5555/cur.4', title: 'ABC2 drought responsiveness (retracted)', update_notice: { type: 'retracted_publication' } },
  { doi: '10.5555/cur.5', title: 'Leaf colour in tulips' },
];
async function runCuration(owner: string, s: { paperId: string; searchId: string }, assessor: CurationAssessor = createMockAssessor()) {
  const { job } = await enqueueJob(pool, { paperId: s.paperId, ownerId: ids[owner]!, intent: 'literature_search', idempotencyKey: randomUUID(), payload: { kind: 'curate', search_ids: [s.searchId] } });
  const out = await processDelivery(pool, { job_id: job.id, paper_id: s.paperId, intent: 'literature_search' }, { workerId: 'w', leaseMs: 30_000, handlers: curationHandlers(pool, assessor) });
  return { jobId: job.id, out, job: (await pool.query('SELECT status, last_error, result FROM jobs WHERE id = $1', [job.id])).rows[0] };
}

describe('TST-033A: use, fit and exclusion reasons are visible; nothing is adopted without the user', () => {
  test('a curation run assesses every candidate with a use, fits, the read depth and reasons; excluded ones say why', async () => {
    const s = await paperWithSearch('alice', CANDS);
    const r = await runCuration('alice', s);
    expect(r.out.outcome).toBe('completed');
    const view = (await call('alice', 'GET', `/api/papers/${s.paperId}/curation`)).json();
    expect(view.runs[0]).toMatchObject({ assessor: 'mock', assessor_label: 'MOCK', status: 'done' });
    const a = view.assessments as { candidate_id: string; title: string; role: string; topic_fit: string; article_type_fit: string; style_fit: string; read_depth: string; reasons: string; exclusion_reason: string | null; warnings: string[]; decision: string }[];
    expect(a).toHaveLength(5);
    for (const x of a) {
      expect(['scientific', 'writing', 'both', 'exclude']).toContain(x.role);
      expect(x.read_depth).toBe('METADATA_ONLY');
      expect(x.reasons.length).toBeGreaterThan(5);
      expect(x.decision).toBe('pending');
      if (x.role === 'exclude') expect(x.exclusion_reason, x.title).toMatch(/\S{3,}/);
    }
    expect(a.find((x) => x.title.startsWith('Leaf colour'))).toMatchObject({ role: 'exclude', topic_fit: 'low' });
    expect(a.find((x) => x.title.includes('preprint'))!.warnings).toContain('preprint');
    // nothing joined the paper's references yet
    expect((await pool.query('SELECT count(*)::int AS n FROM project_references WHERE paper_id = $1', [s.paperId])).rows[0].n).toBe(0);
  });

  test('the owner accepts (with the use) or rejects; acceptance puts the work in the library and the paper; a decision is made once', async () => {
    const s = await paperWithSearch('alice', CANDS);
    await runCuration('alice', s);
    const a = (await call('alice', 'GET', `/api/papers/${s.paperId}/curation`)).json().assessments as { id: string; title: string; role: string }[];
    const sci = a.find((x) => x.title.startsWith('ABC1 induction'))!;
    const ok = await call('alice', 'POST', `/api/papers/${s.paperId}/curation/assessments/${sci.id}/decision`, { decision: 'accepted', use_role: 'scientific' });
    expect(ok.statusCode, ok.body).toBe(200);
    const refs = (await pool.query('SELECT pr.use_role, i.value FROM project_references pr JOIN reference_identifiers i ON i.reference_id = pr.reference_id WHERE pr.paper_id = $1', [s.paperId])).rows;
    expect(refs).toEqual([{ use_role: 'scientific', value: '10.5555/cur.1' }]);
    expect((await call('alice', 'POST', `/api/papers/${s.paperId}/curation/assessments/${sci.id}/decision`, { decision: 'rejected' })).statusCode).toBe(409);
    const other = a.find((x) => x.title.startsWith('Leaf colour'))!;
    expect((await call('alice', 'POST', `/api/papers/${s.paperId}/curation/assessments/${other.id}/decision`, { decision: 'rejected' })).statusCode).toBe(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM project_references WHERE paper_id = $1', [s.paperId])).rows[0].n).toBe(1);
    // another owner sees nothing and decides nothing
    expect((await call('bob', 'GET', `/api/papers/${s.paperId}/curation`)).statusCode).toBe(404);
    expect((await call('bob', 'POST', `/api/papers/${s.paperId}/curation/assessments/${other.id}/decision`, { decision: 'accepted', use_role: 'both' })).statusCode).toBe(404);
  });
});

describe('TST-033B: no writing quality from citations; discovery changes nothing approved', () => {
  test('a style judgement from metadata (e.g. "highly cited, so well written") is stored as unknown, with the reason', async () => {
    const s = await paperWithSearch('alice', CANDS);
    await runCuration('alice', s);
    const a = (await call('alice', 'GET', `/api/papers/${s.paperId}/curation`)).json().assessments as { title: string; role: string; style_fit: string; warnings: string[]; reasons: string }[];
    // the mock assessor claims "good" style for the highly cited review on its citation count
    const cited = a.find((x) => x.title.startsWith('A highly cited review'))!;
    expect(cited.style_fit).toBe('unknown');
    expect(cited.warnings).toContain('style_needs_full_text');
    for (const x of a) expect(x.style_fit, x.title).toBe('unknown'); // no candidate here has been read beyond metadata
  });

  test('a retracted work is never proposed as scientific support', async () => {
    const s = await paperWithSearch('alice', CANDS);
    await runCuration('alice', s);
    const a = (await call('alice', 'GET', `/api/papers/${s.paperId}/curation`)).json().assessments as { title: string; role: string; exclusion_reason: string | null; warnings: string[] }[];
    expect(a.find((x) => x.title.includes('retracted'))).toMatchObject({ role: 'exclude', warnings: expect.arrayContaining(['retracted']) });
    // and the owner cannot adopt it as scientific support either; only as a writing reference
    const r = (a as unknown as { id: string; title: string }[]).find((x) => x.title.includes('retracted'))!;
    for (const use_role of ['scientific', 'both']) {
      const res = await call('alice', 'POST', `/api/papers/${s.paperId}/curation/assessments/${r.id}/decision`, { decision: 'accepted', use_role });
      expect(res.statusCode).toBe(422);
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM project_references WHERE paper_id = $1', [s.paperId])).rows[0].n).toBe(0);
    const ok = await call('alice', 'POST', `/api/papers/${s.paperId}/curation/assessments/${r.id}/decision`, { decision: 'accepted', use_role: 'writing' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().project_use_role).toBe('writing');
  });

  test('an assessor answer that is malformed or names unknown candidates fails the run; nothing partial is stored', async () => {
    const bad: CurationAssessor[] = [
      { id: 'mock', label: 'MOCK', assess: async () => ({ assessments: [{ candidate_id: randomUUID(), role: 'scientific', topic_fit: 'high', article_type_fit: 'high', style_fit: 'unknown', reasons: 'x'.repeat(10) }] }) },
      { id: 'mock', label: 'MOCK', assess: async (inp) => ({ assessments: inp.candidates.map((c) => ({ candidate_id: c.id, role: 'great', topic_fit: 'high', article_type_fit: 'high', style_fit: 'unknown', reasons: 'x'.repeat(10) })) }) },
      { id: 'mock', label: 'MOCK', assess: async (inp) => ({ assessments: inp.candidates.map((c) => ({ candidate_id: c.id, role: 'exclude', topic_fit: 'low', article_type_fit: 'low', style_fit: 'unknown', reasons: 'x'.repeat(10) })) }) },
      { id: 'mock', label: 'MOCK', assess: async (inp) => ({ assessments: inp.candidates.map((c) => ({ candidate_id: c.id, role: 'scientific', topic_fit: 'high', article_type_fit: 'high', style_fit: 'unknown', reasons: 'x'.repeat(10), approve_profile: true })) }) },
    ];
    for (const assessor of bad) {
      const s = await paperWithSearch('alice', CANDS.slice(0, 2));
      const r = await runCuration('alice', s, assessor);
      expect(r.job.status).toBe('FAILED');
      expect(r.job.last_error).toMatch(/assess/i);
      expect((await pool.query('SELECT count(*)::int AS n FROM curation_assessments WHERE paper_id = $1', [s.paperId])).rows[0].n).toBe(0);
    }
  });

  test('a run changes no approved state: no references, no story/outline, no profile; candidates only become suggestions', async () => {
    const s = await paperWithSearch('alice', CANDS);
    const before = (await pool.query(`SELECT (SELECT count(*) FROM project_references) AS r, (SELECT count(*) FROM story_revisions) AS st, (SELECT count(*) FROM outline_revisions) AS o, (SELECT count(*) FROM reference_works) AS w`)).rows[0];
    await runCuration('alice', s);
    const after = (await pool.query(`SELECT (SELECT count(*) FROM project_references) AS r, (SELECT count(*) FROM story_revisions) AS st, (SELECT count(*) FROM outline_revisions) AS o, (SELECT count(*) FROM reference_works) AS w`)).rows[0];
    expect(after).toEqual(before);
    await expect(pool.query("UPDATE curation_assessments SET role = 'both' WHERE paper_id = $1", [s.paperId])).rejects.toThrow(/immutable/);
  });
});

describe('starting a curation run from the API', () => {
  test('the owner asks for a run over the paper\'s searches; bad or foreign search ids are refused; the view lists the searches', async () => {
    const s = await paperWithSearch('alice', CANDS.slice(0, 2));
    const view = (await call('alice', 'GET', `/api/papers/${s.paperId}/curation`)).json();
    expect(view.searches).toEqual([expect.objectContaining({ id: s.searchId, source: 'crossref', candidates: 2 })]);
    for (const bad of [undefined, [], ['nope'], Array.from({ length: 21 }, () => randomUUID())]) {
      expect((await call('alice', 'POST', `/api/papers/${s.paperId}/curation/runs`, { search_ids: bad, idempotency_key: randomUUID() })).statusCode).toBe(422);
    }
    const other = await paperWithSearch('alice', CANDS.slice(0, 1));
    expect((await call('alice', 'POST', `/api/papers/${s.paperId}/curation/runs`, { search_ids: [other.searchId], idempotency_key: randomUUID() })).statusCode).toBe(404);
    expect((await call('bob', 'POST', `/api/papers/${s.paperId}/curation/runs`, { search_ids: [s.searchId], idempotency_key: randomUUID() })).statusCode).toBe(404);
    const key = randomUUID();
    const r = await call('alice', 'POST', `/api/papers/${s.paperId}/curation/runs`, { search_ids: [s.searchId, s.searchId], idempotency_key: key });
    expect(r.statusCode).toBe(201);
    const job = (await pool.query('SELECT intent, payload, status FROM jobs WHERE id = $1', [r.json().job.id])).rows[0];
    expect(job).toMatchObject({ intent: 'literature_search', payload: { kind: 'curate', search_ids: [s.searchId] }, status: 'QUEUED' });
    expect((await call('alice', 'POST', `/api/papers/${s.paperId}/curation/runs`, { search_ids: [s.searchId], idempotency_key: key })).statusCode).toBe(200);
  });
});

describe('closing gaps found by mutation', () => {
  test('an answer that skips a candidate fails the run', async () => {
    const s = await paperWithSearch('alice', CANDS.slice(0, 2));
    const skip: CurationAssessor = { id: 'mock', label: 'MOCK', assess: async (inp) => ({ assessments: inp.candidates.slice(0, 1).map((c) => ({ candidate_id: c.id, role: 'scientific', topic_fit: 'high', article_type_fit: 'high', style_fit: 'unknown', reasons: 'x'.repeat(10) })) }) };
    const r = await runCuration('alice', s, skip);
    expect(r.job.status).toBe('FAILED');
    expect(r.job.last_error).toMatch(/every candidate/);
  });

  test('an exclusion reason is kept only for an excluded candidate', async () => {
    const s = await paperWithSearch('alice', CANDS.slice(0, 1));
    const odd: CurationAssessor = { id: 'mock', label: 'MOCK', assess: async (inp) => ({ assessments: inp.candidates.map((c) => ({ candidate_id: c.id, role: 'scientific', topic_fit: 'high', article_type_fit: 'high', style_fit: 'unknown', reasons: 'x'.repeat(10), exclusion_reason: 'not really excluded' })) }) };
    await runCuration('alice', s, odd);
    const a = (await call('alice', 'GET', `/api/papers/${s.paperId}/curation`)).json().assessments;
    expect(a).toEqual([expect.objectContaining({ role: 'scientific', exclusion_reason: null })]);
  });

  test('a worker payload naming another paper\'s search fails the run', async () => {
    const s = await paperWithSearch('alice', CANDS.slice(0, 1));
    const other = await paperWithSearch('alice', CANDS.slice(1, 2));
    const r = await runCuration('alice', { paperId: s.paperId, searchId: other.searchId });
    expect(r.job.status).toBe('FAILED');
    expect(r.job.last_error).toMatch(/not this paper's/);
    expect((await pool.query('SELECT count(*)::int AS n FROM curation_assessments WHERE paper_id = $1', [s.paperId])).rows[0].n).toBe(0);
  });

  test('a decided suggestion cannot be accepted later; nothing reaches the library', async () => {
    const s = await paperWithSearch('alice', [{ doi: `10.5555/fresh.${randomUUID()}`, title: 'ABC1 induction under drought, fresh' }]);
    await runCuration('alice', s);
    const [a] = (await call('alice', 'GET', `/api/papers/${s.paperId}/curation`)).json().assessments as { id: string }[];
    expect((await call('alice', 'POST', `/api/papers/${s.paperId}/curation/assessments/${a!.id}/decision`, { decision: 'rejected' })).statusCode).toBe(200);
    const before = (await pool.query('SELECT count(*)::int AS n FROM reference_works WHERE owner_id = $1', [ids.alice])).rows[0].n;
    expect((await call('alice', 'POST', `/api/papers/${s.paperId}/curation/assessments/${a!.id}/decision`, { decision: 'accepted', use_role: 'scientific' })).statusCode).toBe(409);
    expect((await pool.query('SELECT count(*)::int AS n FROM reference_works WHERE owner_id = $1', [ids.alice])).rows[0].n).toBe(before);
  });

  test('accepting a work the paper already holds keeps its use and says so', async () => {
    const s = await paperWithSearch('alice', CANDS.slice(0, 1));
    await runCuration('alice', s);
    await runCuration('alice', s);
    const all = (await pool.query('SELECT a.id FROM curation_assessments a JOIN curation_runs r ON r.id = a.run_id WHERE a.paper_id = $1 ORDER BY r.created_at, a.id', [s.paperId])).rows as { id: string }[];
    expect(all).toHaveLength(2);
    const first = await call('alice', 'POST', `/api/papers/${s.paperId}/curation/assessments/${all[0]!.id}/decision`, { decision: 'accepted', use_role: 'scientific' });
    expect(first.json().project_use_role).toBe('scientific');
    const second = await call('alice', 'POST', `/api/papers/${s.paperId}/curation/assessments/${all[1]!.id}/decision`, { decision: 'accepted', use_role: 'writing' });
    expect(second.statusCode).toBe(200);
    expect(second.json().project_use_role).toBe('scientific');
    expect((await pool.query('SELECT use_role FROM project_references WHERE paper_id = $1', [s.paperId])).rows).toEqual([{ use_role: 'scientific' }]);
  });
});
