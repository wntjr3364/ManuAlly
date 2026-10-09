// PW-011 — TST-011A / TST-011B (real PostgreSQL)
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
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
// synthetic result table uploaded earlier (asset upload API is P04; the row is created directly here)
async function tableAsset(paperId: string) {
  const { rows } = await pool.query(
    "INSERT INTO asset_revisions (paper_id, asset_key, sha256, byte_size, media_type, original_name, created_by) VALUES ($1, 'table-2', repeat('d', 64), 120, 'text/csv', 'drought_qpcr.csv', $2) RETURNING id",
    [paperId, aliceId],
  );
  return rows[0].id as string;
}
async function evidence(paperId: string, assetId: string, over: Record<string, unknown> = {}) {
  const r = await call('POST', `/api/papers/${paperId}/evidence`, { kind: 'table_cell', source_asset_revision_id: assetId, locator: { table: 'Table 2', row: 'ABC1', column: 'fold change' }, label: 'ABC1 qPCR, drought vs control', ...over });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
const verifyEvidence = (paperId: string, ev: { id: string; content_hash: string }) =>
  call('POST', `/api/papers/${paperId}/evidence/${ev.id}/verify`, { intent: 'verify_evidence', content_hash: ev.content_hash });
const factBody = (evidenceId: string, over: Record<string, unknown> = {}) => ({
  evidence_id: evidenceId, entity: 'ABC1 transcript', metric: 'fold_change', value_text: '2.4', unit: 'fold',
  group: 'drought, 7 d', comparison: 'well-watered control', n: 3, extraction_method: 'manual_entry',
  statistics: [{ kind: 'p_value', value_text: '0.003', test: 'Welch t-test' }, { kind: 'adjusted_p_value', value_text: '0.012', adjustment: 'Benjamini-Hochberg' }],
  ...over,
});
async function fact(paperId: string, evidenceId: string, over: Record<string, unknown> = {}) {
  const r = await call('POST', `/api/papers/${paperId}/facts`, factBody(evidenceId, over));
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
const verifyFact = (paperId: string, f: { id: string; content_hash: string }, extra: Record<string, unknown> = {}) =>
  call('POST', `/api/papers/${paperId}/facts/${f.id}/verify`, { intent: 'verify_fact', content_hash: f.content_hash, ...extra });

describe('TST-011A: a fact links value, unit, groups, source and the person who verified it', () => {
  test('a verified fact carries its value, unit, groups, n, statistics, source locator and verifier', async () => {
    const p = await paper();
    const asset = await tableAsset(p.id);
    const ev = await evidence(p.id, asset);
    expect(ev.extraction_state).toBe('CANDIDATE');
    expect((await verifyEvidence(p.id, ev)).statusCode).toBe(200);
    const f = await fact(p.id, ev.id);
    expect(f.verification_state).toBe('CANDIDATE');
    const v = await verifyFact(p.id, f);
    expect(v.statusCode, v.body).toBe(200);
    const got = (await call('GET', `/api/papers/${p.id}/facts/${f.id}`)).json();
    expect(got).toMatchObject({
      entity: 'ABC1 transcript', metric: 'fold_change', value_text: '2.4', unit: 'fold', group: 'drought, 7 d', comparison: 'well-watered control', n: 3,
      verification_state: 'VERIFIED', verified_by: aliceId, origin: 'user',
    });
    expect(Number(got.value)).toBe(2.4);
    expect(got.statistics.map((s: { kind: string }) => s.kind).sort()).toEqual(['adjusted_p_value', 'p_value']);
    expect(got.evidence).toMatchObject({ id: ev.id, kind: 'table_cell', source_asset_revision_id: asset, locator: { table: 'Table 2', row: 'ABC1', column: 'fold change' }, extraction_state: 'VERIFIED', verified_by: aliceId });
  });

  test('a fact cannot be verified before its source evidence, or with unit, group, n or control missing', async () => {
    const p = await paper();
    const ev = await evidence(p.id, await tableAsset(p.id));
    const f = await fact(p.id, ev.id);
    const early = await verifyFact(p.id, f);
    expect(early.statusCode).toBe(409);
    expect(early.json().message).toMatch(/evidence/);
    await verifyEvidence(p.id, ev);
    const thin = await fact(p.id, ev.id, { unit: '', group: '', n: null, comparison: '' });
    const res = await verifyFact(p.id, thin);
    expect(res.statusCode).toBe(422);
    expect(res.json().missing).toEqual(expect.arrayContaining(['unit', 'group', 'n', 'comparison']));
  });

  test('values keep the exact text of the source; a number without a unit or source is refused as a fact', async () => {
    const p = await paper();
    const ev = await evidence(p.id, await tableAsset(p.id));
    const f = await fact(p.id, ev.id, { value_text: '2.40' });
    expect(f.value_text).toBe('2.40');
    for (const [over, status] of [
      [{ value_text: 'about 2' }, 422],
      [{ unit: undefined }, 422],
      [{ evidence_id: randomUUID() }, 404],
      [{ statistics: [{ kind: 'p_value', value_text: '1.3' }] }, 422],
    ] as const) {
      const r = await call('POST', `/api/papers/${p.id}/facts`, factBody(ev.id, over));
      expect(r.statusCode, JSON.stringify(over)).toBe(status);
    }
  });

  test('evidence locators are required and checked per kind; sources must belong to the same paper', async () => {
    const p = await paper();
    const other = await paper();
    const asset = await tableAsset(p.id);
    const foreign = await tableAsset(other.id);
    for (const body of [
      { kind: 'table_cell', source_asset_revision_id: asset, locator: { table: 'T2' } },
      { kind: 'figure_panel', source_asset_revision_id: asset, locator: {} },
      { kind: 'table_cell', locator: { table: 'T2', row: 'r', column: 'c' } },
      { kind: 'literature_excerpt', locator: { quote: 'x' } },
      { kind: 'gossip', locator: { note: 'x' } },
    ]) {
      expect((await call('POST', `/api/papers/${p.id}/evidence`, body)).statusCode, JSON.stringify(body)).toBe(422);
    }
    const cross = await call('POST', `/api/papers/${p.id}/evidence`, { kind: 'table_cell', source_asset_revision_id: foreign, locator: { table: 'T', row: 'r', column: 'c' } });
    expect(cross.statusCode).toBe(404);
    const method = await call('POST', `/api/papers/${p.id}/evidence`, { kind: 'method_record', locator: { note: 'qPCR protocol v3, step 4' } });
    expect(method.statusCode, method.body).toBe(201);
  });

  test('an observation claim is approved only with verified supporting evidence; links name the relation', async () => {
    const p = await paper();
    const ev = await evidence(p.id, await tableAsset(p.id));
    const claim = (await call('POST', `/api/papers/${p.id}/claims`, { kind: 'observation', text: 'ABC1 transcript increased under drought' })).json();
    const approve = () => call('POST', `/api/papers/${p.id}/claims/${claim.id}/approve`, { intent: 'approve_claim', content_hash: claim.content_hash });
    expect((await approve()).statusCode).toBe(422);
    expect((await call('POST', `/api/papers/${p.id}/claims/${claim.id}/evidence-links`, { evidence_id: ev.id, relation: 'proves' })).statusCode).toBe(422);
    expect((await call('POST', `/api/papers/${p.id}/claims/${claim.id}/evidence-links`, { evidence_id: ev.id, relation: 'supports' })).statusCode).toBe(201);
    expect((await approve()).statusCode).toBe(422); // evidence not verified yet
    await verifyEvidence(p.id, ev);
    const ok = await approve();
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ approval_state: 'APPROVED', approved_by: aliceId });
    const hyp = (await call('POST', `/api/papers/${p.id}/claims`, { kind: 'hypothesis', text: 'ABC1 may act upstream of root growth' })).json();
    expect((await call('POST', `/api/papers/${p.id}/claims/${hyp.id}/approve`, { intent: 'approve_claim', content_hash: hyp.content_hash })).statusCode).toBe(200);
  });
});

describe('TST-011B: AI or import cannot forge verification, and p and q stay different statistics', () => {
  test('verifier/approver fields in a request are refused; the verifier is the session owner', async () => {
    const p = await paper();
    const ev = await evidence(p.id, await tableAsset(p.id));
    const forged = await call('POST', `/api/papers/${p.id}/evidence/${ev.id}/verify`, { intent: 'verify_evidence', content_hash: ev.content_hash, verified_by: randomUUID() });
    expect(forged.statusCode).toBe(422);
    expect(forged.body).toMatch(/verified_by/);
    for (const extra of [{ verification_state: 'VERIFIED' }, { verified_by: aliceId }, { origin: 'user' }]) {
      const r = await call('POST', `/api/papers/${p.id}/facts`, { ...factBody(ev.id), ...extra });
      expect(r.statusCode, JSON.stringify(extra)).toBe(422);
    }
    const claim = await call('POST', `/api/papers/${p.id}/claims`, { kind: 'background', text: 't', approval_state: 'APPROVED' });
    expect(claim.statusCode).toBe(422);
  });

  test('imported and AI-extracted facts are candidates with their origin; any verification field fails the whole import', async () => {
    const p = await paper();
    const ev = await evidence(p.id, await tableAsset(p.id));
    const bad = await call('POST', `/api/papers/${p.id}/facts/import`, { facts: [factBody(ev.id), { ...factBody(ev.id), verified_by: aliceId }] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().field).toMatch(/facts\[1\]\.verified_by/);
    expect((await call('GET', `/api/papers/${p.id}/facts`)).json()).toHaveLength(0);
    const ok = await call('POST', `/api/papers/${p.id}/facts/import`, { facts: [factBody(ev.id), factBody(ev.id, { metric: 'survival', value_text: '64', unit: '%' })] });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().map((f: { origin: string; verification_state: string }) => [f.origin, f.verification_state])).toEqual([['import', 'CANDIDATE'], ['import', 'CANDIDATE']]);
    // the domain entry point used by future AI extraction cannot set a verifier either
    await expect(createFactCandidates(pool, { paperId: p.id, ownerId: aliceId, origin: 'ai_extraction', facts: [{ ...factBody(ev.id), verified_by: aliceId }] })).rejects.toThrow(/verified_by/);
    const ai = await createFactCandidates(pool, { paperId: p.id, ownerId: aliceId, origin: 'ai_extraction', facts: [factBody(ev.id)] });
    expect(ai[0]).toMatchObject({ origin: 'ai_extraction', verification_state: 'CANDIDATE', verified_by: null });
  });

  test('p, adjusted p and q are distinct statistic kinds: no aliases, no duplicates, no merging', async () => {
    const p = await paper();
    const ev = await evidence(p.id, await tableAsset(p.id));
    const both = await fact(p.id, ev.id, { statistics: [{ kind: 'p_value', value_text: '0.003' }, { kind: 'q_value', value_text: '0.03' }] });
    expect(both.statistics.map((s: { kind: string; value_text: string }) => [s.kind, s.value_text]).sort()).toEqual([['p_value', '0.003'], ['q_value', '0.03']]);
    for (const statistics of [
      [{ kind: 'p', value_text: '0.01' }],
      [{ kind: 'q', value_text: '0.01' }],
      [{ kind: 'FDR', value_text: '0.01' }],
      [{ kind: 'p_value', value_text: '0.01' }, { kind: 'p_value', value_text: '0.02' }],
      [{ kind: 'adjusted_p_value', value_text: '0.01' }],
    ]) {
      const r = await call('POST', `/api/papers/${p.id}/facts`, factBody(ev.id, { statistics }));
      expect(r.statusCode, JSON.stringify(statistics)).toBe(422);
      expect(r.json().field).toMatch(/statistics/);
    }
    expect(() => mergeStatistics([{ kind: 'p_value', value_text: '0.01' }], [{ kind: 'q_value', value_text: '0.01' }])).not.toThrow();
    expect(mergeStatistics([{ kind: 'p_value', value_text: '0.01' }], [{ kind: 'q_value', value_text: '0.01' }]).map((s) => s.kind).sort()).toEqual(['p_value', 'q_value']);
    expect(() => mergeStatistics([{ kind: 'p_value', value_text: '0.01' }], [{ kind: 'p_value', value_text: '0.02' }])).toThrow(/conflict/);
  });

  test('the database refuses verified rows that skip the verification step, a verifier who is not the owner, and p/q rewrites', async () => {
    const p = await paper();
    const ev = await evidence(p.id, await tableAsset(p.id));
    await verifyEvidence(p.id, ev);
    const f = await fact(p.id, ev.id);
    const bobId = (await pool.query("SELECT id FROM owners WHERE username = 'bob'")).rows[0].id;
    for (const [sql, params] of [
      ["UPDATE fact_records SET verification_state = 'VERIFIED', verified_by = $2, verified_at = now() WHERE id = $1", [f.id, bobId]],
      ["UPDATE fact_statistics SET kind = 'p_value' WHERE fact_id = $1 AND kind = 'adjusted_p_value'", [f.id]],
      ['UPDATE fact_records SET value_text = $2 WHERE id = $1', [f.id, '3.1']],
      ['DELETE FROM fact_records WHERE id = $1', [f.id]],
      ["INSERT INTO fact_records (paper_id, evidence_id, entity, metric, value, value_text, unit, content_hash, origin, created_by, verification_state, verified_by, verified_at) VALUES ($1, $2, 'e', 'm', 1, '1', 'u', repeat('0', 64), 'import', $3, 'VERIFIED', $3, now())", [p.id, ev.id, aliceId]],
      ["INSERT INTO fact_statistics (fact_id, paper_id, kind, value, value_text) VALUES ($1, $2, 'q_value', 0.1, '0.1')", [f.id, p.id]],
    ] as const) {
      await expect(pool.query(sql, [...params]), sql).rejects.toThrow(/immutable|transition|owner|check/);
    }
  });

  test("another owner sees none of a paper's evidence, facts or claims", async () => {
    const p = await paper();
    const ev = await evidence(p.id, await tableAsset(p.id), { label: 'SECRET-LABEL' });
    const f = await fact(p.id, ev.id);
    for (const url of [`/api/papers/${p.id}/evidence`, `/api/papers/${p.id}/evidence/${ev.id}`, `/api/papers/${p.id}/facts/${f.id}`, `/api/papers/${p.id}/claims`]) {
      const r = await call('GET', url, undefined, B);
      expect(r.statusCode, url).toBe(404);
      expect(r.body).not.toContain('SECRET-LABEL');
    }
    const q = await paper();
    expect((await call('GET', `/api/papers/${q.id}/facts/${f.id}`)).statusCode).toBe(404);
  });
});
