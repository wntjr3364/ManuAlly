// PW-011 — regression tests for the independent review (M1, m1–m5)
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { createFactCandidates, mergeStatistics } from '../../../packages/domain/src/evidence/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
let A: Record<string, string>;
let B: Record<string, string>;
let aliceId: string;

async function login(username: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username, password } });
  return { cookie: String(res.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': res.json().csrfToken, origin: ORIGIN };
}
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 6 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  aliceId = (await createOwner(pool, { username: 'alice', password: 'correct horse battery' })).id;
  await createOwner(pool, { username: 'bob', password: 'another long passphrase' });
  A = await login('alice', 'correct horse battery');
  B = await login('bob', 'another long passphrase');
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});

const call = (method: 'GET' | 'POST', url: string, payload?: unknown, h = A) => app.inject({ method, url, headers: h, payload: payload as object | undefined });
const paper = async () => (await call('POST', '/api/papers', { working_title: 'p', article_type: 'research_article' })).json();
async function evidence(paperId: string) {
  const { rows } = await pool.query("INSERT INTO asset_revisions (paper_id, asset_key, sha256, byte_size, media_type, created_by) VALUES ($1, 'table-2', repeat('d', 64), 1, 'text/csv', $2) RETURNING id", [paperId, aliceId]);
  const r = await call('POST', `/api/papers/${paperId}/evidence`, { kind: 'table_cell', source_asset_revision_id: rows[0].id, locator: { table: 'T2', row: 'r', column: 'c' } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
const factBody = (evidenceId: string, over: Record<string, unknown> = {}) => ({
  evidence_id: evidenceId, entity: 'ABC1', metric: 'fold_change', value_text: '2.4', unit: 'fold', group: 'drought', comparison: 'control', n: 3, ...over,
});
const postFact = (paperId: string, body: unknown) => call('POST', `/api/papers/${paperId}/facts`, body);

describe('review M1: the number text is stored exactly as the source wrote it', () => {
  test.each(['2.4E3', '1e2', '00012', '-0', '.5', '2.40', '+3.0'])('value %s comes back unchanged and matches its numeric value', async (text) => {
    const p = await paper();
    const ev = await evidence(p.id);
    const r = await postFact(p.id, factBody(ev.id, { value_text: text, statistics: [{ kind: 'p_value', value_text: '1.0e-5' }] }));
    expect(r.statusCode, r.body).toBe(201);
    const got = (await call('GET', `/api/papers/${p.id}/facts/${r.json().id}`)).json();
    expect(got.value_text).toBe(text);
    expect(Number(got.value) === Number(text), `${got.value} vs ${text}`).toBe(true); // -0 == 0
    expect(got.statistics[0].value_text).toBe('1.0e-5');
  });

  test('the database refuses a numeric value that differs from its text', async () => {
    const p = await paper();
    const ev = await evidence(p.id);
    const f = (await postFact(p.id, factBody(ev.id))).json();
    await expect(pool.query(
      "INSERT INTO fact_records (paper_id, evidence_id, entity, metric, value, value_text, unit, extraction_method, content_hash, origin, created_by) VALUES ($1, $2, 'e', 'm', 99, '1', 'u', 'manual_entry', repeat('0', 64), 'user', $3)",
      [p.id, ev.id, aliceId],
    )).rejects.toThrow(/check/);
    await expect(pool.query(
      'BEGIN; ' + "INSERT INTO fact_statistics (fact_id, paper_id, kind, value, value_text) VALUES ($1, $2, 'q_value', 0.9, '0.001')".replace('$1', `'${f.id}'`).replace('$2', `'${p.id}'`) + '; COMMIT',
    )).rejects.toThrow(/check|immutable/);
    await pool.query('ROLLBACK').catch(() => {});
  });
});

describe('review m1: out-of-range numbers are a 422, never a 500', () => {
  test.each([
    [{ value_text: '1e99999999' }],
    [{ value_text: '1e-99999999' }],
    [{ value_text: '1e999' }],
    [{ statistics: [{ kind: 'df', value_text: '1e99999999' }] }],
    [{ statistics: [{ kind: 'p_value', value_text: '1.00000000000000000001' }] }],
    [{ statistics: [{ kind: 'q_value', value_text: '-0.000000000000000000001' }] }],
  ])('%j', async (over) => {
    const p = await paper();
    const ev = await evidence(p.id);
    const r = await postFact(p.id, factBody(ev.id, over));
    expect(r.statusCode, r.body).toBe(422);
  });
  test('a p-value of exactly 1 or 0 is fine', async () => {
    const p = await paper();
    const ev = await evidence(p.id);
    expect((await postFact(p.id, factBody(ev.id, { statistics: [{ kind: 'p_value', value_text: '1.000' }, { kind: 'q_value', value_text: '0' }] }))).statusCode).toBe(201);
  });
});

describe('review m2: an adjusted value cannot be stored as a raw p-value', () => {
  test('p_value with an adjustment method is refused (API and DB); merge validates kinds', async () => {
    const p = await paper();
    const ev = await evidence(p.id);
    const r = await postFact(p.id, factBody(ev.id, { statistics: [{ kind: 'p_value', value_text: '0.01', adjustment: 'Benjamini-Hochberg' }] }));
    expect(r.statusCode).toBe(422);
    expect(r.json().field).toMatch(/adjustment/);
    for (const kind of ['P_value', 'p_value ', 'Q_VALUE', 'padj', 'p-value']) {
      expect((await postFact(p.id, factBody(ev.id, { statistics: [{ kind, value_text: '0.01' }] }))).statusCode, kind).toBe(422);
    }
    expect(() => mergeStatistics([{ kind: 'q' as never, value_text: '0.01' }], [])).toThrow(/kind/);
  });
});

describe('review m3: the database also enforces claim evidence and review timestamps', () => {
  test('an observation cannot be approved by SQL without verified supporting evidence; review time is the server clock', async () => {
    const p = await paper();
    const c = (await call('POST', `/api/papers/${p.id}/claims`, { kind: 'observation', text: 'x rose' })).json();
    await expect(pool.query("UPDATE claims SET approval_state = 'APPROVED', approved_by = $2, approved_at = now() WHERE id = $1", [c.id, aliceId])).rejects.toThrow(/evidence/);
    const ev = await evidence(p.id);
    await pool.query("UPDATE evidence_records SET extraction_state = 'VERIFIED', verified_by = $2, verified_at = '1970-01-01' WHERE id = $1", [ev.id, aliceId]);
    const { rows } = await pool.query('SELECT verified_at > now() - interval \'1 minute\' AS recent FROM evidence_records WHERE id = $1', [ev.id]);
    expect(rows[0].recent).toBe(true);
  });
});

describe('review m4: stale hashes and other owners cannot review', () => {
  test('verify/approve with a content hash other than the stored one is a 409', async () => {
    const p = await paper();
    const ev = await evidence(p.id);
    const wrong = '0'.repeat(64);
    expect((await call('POST', `/api/papers/${p.id}/evidence/${ev.id}/verify`, { intent: 'verify_evidence', content_hash: wrong })).statusCode).toBe(409);
    await call('POST', `/api/papers/${p.id}/evidence/${ev.id}/verify`, { intent: 'verify_evidence', content_hash: ev.content_hash });
    const f = (await postFact(p.id, factBody(ev.id))).json();
    expect((await call('POST', `/api/papers/${p.id}/facts/${f.id}/verify`, { intent: 'verify_fact', content_hash: wrong })).statusCode).toBe(409);
    const c = (await call('POST', `/api/papers/${p.id}/claims`, { kind: 'background', text: 't' })).json();
    expect((await call('POST', `/api/papers/${p.id}/claims/${c.id}/approve`, { intent: 'approve_claim', content_hash: wrong })).statusCode).toBe(409);
  });

  test("another owner cannot verify, reject, link or approve on someone else's paper", async () => {
    const p = await paper();
    const ev = await evidence(p.id);
    const c = (await call('POST', `/api/papers/${p.id}/claims`, { kind: 'background', text: 't' })).json();
    for (const [url, body] of [
      [`/api/papers/${p.id}/evidence/${ev.id}/verify`, { intent: 'verify_evidence', content_hash: ev.content_hash }],
      [`/api/papers/${p.id}/evidence/${ev.id}/reject`, { intent: 'reject_evidence', content_hash: ev.content_hash }],
      [`/api/papers/${p.id}/claims/${c.id}/approve`, { intent: 'approve_claim', content_hash: c.content_hash }],
      [`/api/papers/${p.id}/claims/${c.id}/evidence-links`, { evidence_id: ev.id, relation: 'supports' }],
      [`/api/papers/${p.id}/facts`, factBody(ev.id)],
    ] as const) {
      expect((await call('POST', url, body, B)).statusCode, url).toBe(404);
    }
    expect((await call('GET', `/api/papers/${p.id}/evidence/${ev.id}`)).json().extraction_state).toBe('CANDIDATE');
  });
});

describe('review m5: provenance and source checks', () => {
  test('extraction method must agree with origin', async () => {
    const p = await paper();
    const ev = await evidence(p.id);
    expect((await postFact(p.id, factBody(ev.id, { extraction_method: 'ai_extraction' }))).statusCode).toBe(422);
    await expect(createFactCandidates(pool, { paperId: p.id, ownerId: aliceId, origin: 'ai_extraction', facts: [factBody(ev.id, { extraction_method: 'manual_entry' })] })).rejects.toThrow(/extraction_method/);
  });

  test('links to rejected evidence, verifying evidence of a removed reference, and huge page numbers are refused', async () => {
    const p = await paper();
    const ev = await evidence(p.id);
    await call('POST', `/api/papers/${p.id}/evidence/${ev.id}/reject`, { intent: 'reject_evidence', content_hash: ev.content_hash });
    const c = (await call('POST', `/api/papers/${p.id}/claims`, { kind: 'background', text: 't' })).json();
    expect((await call('POST', `/api/papers/${p.id}/claims/${c.id}/evidence-links`, { evidence_id: ev.id, relation: 'supports' })).statusCode).toBe(409);
    const { rows } = await pool.query("INSERT INTO reference_works (owner_id) VALUES ($1) RETURNING id", [aliceId]);
    await pool.query('INSERT INTO project_references (paper_id, reference_id, owner_id) VALUES ($1, $2, $3)', [p.id, rows[0].id, aliceId]);
    const lit = (await call('POST', `/api/papers/${p.id}/evidence`, { kind: 'literature_excerpt', reference_id: rows[0].id, locator: { quote: 'q', page_index: 3 } })).json();
    await pool.query('UPDATE project_references SET removed_at = now() WHERE reference_id = $1', [rows[0].id]);
    expect((await call('POST', `/api/papers/${p.id}/evidence/${lit.id}/verify`, { intent: 'verify_evidence', content_hash: lit.content_hash })).statusCode).toBe(409);
    expect((await call('POST', `/api/papers/${p.id}/evidence`, { kind: 'literature_excerpt', reference_id: rows[0].id, locator: { quote: 'q', page_index: 1e20 } })).statusCode).toBe(422);
  });

  test('log fold-change metrics also need the comparison group before verification', async () => {
    const p = await paper();
    const ev = await evidence(p.id);
    await call('POST', `/api/papers/${p.id}/evidence/${ev.id}/verify`, { intent: 'verify_evidence', content_hash: ev.content_hash });
    const f = (await postFact(p.id, factBody(ev.id, { metric: 'log2FC', comparison: '' }))).json();
    const r = await call('POST', `/api/papers/${p.id}/facts/${f.id}/verify`, { intent: 'verify_fact', content_hash: f.content_hash });
    expect(r.statusCode).toBe(422);
    expect(r.json().missing).toContain('comparison');
  });
});
