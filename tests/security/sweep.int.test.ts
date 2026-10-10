// PW-059 security audit — the whole API, swept with two owners (spec 09 "개인 앱도 인증이 필요하다": two
// test owners for IDOR). Every route the server has is taken from its own route table (a new route is
// swept without being listed here); every path parameter must have an id source below, or this test fails.
// TST-059A (negative tests): without a session every private route is 401; without the CSRF token every
//   changing route is 403 (and from another origin too); another owner's paper is 404 on every route; with
//   one's own paper, another owner's ids in the path or the body never return the other owner's data, never
//   change it, and are never stored in one's own records; no request ends in an internal error.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../packages/config/src/test-db.ts';
import { migrate } from '../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createOwner } from '../../apps/api/src/auth/owners.ts';
import { listRoutes, type Route } from './routes.ts';
import { buildWorld, type World } from './world.ts';
import { openZip } from '../../packages/domain/src/imports/docx/zip.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
let dir: string;
const H: Record<string, Record<string, string>> = {};
let A: World;
let B: World;
let routes: Route[];
const findings: string[] = [];
export const SWEEP_STATS: Record<string, number> = {};

// where each path parameter's ids come from, for a paper
const PARAM: Record<string, string> = {
  documentId: "SELECT id::text FROM documents WHERE paper_id = $1",
  revisionId: "SELECT id::text FROM document_revisions WHERE paper_id = $1 UNION SELECT id::text FROM outline_revisions WHERE paper_id = $1 UNION SELECT id::text FROM story_revisions WHERE paper_id = $1 UNION SELECT id::text FROM writing_profile_revisions WHERE paper_id = $1",
  assetId: "SELECT id::text FROM asset_revisions WHERE paper_id = $1",
  anchorId: "SELECT id::text FROM pdf_anchors WHERE paper_id = $1",
  snapshotId: "SELECT id::text FROM paper_snapshots WHERE paper_id = $1",
  alternativeId: "SELECT id::text FROM story_alternatives WHERE paper_id = $1",
  submissionId: "SELECT id::text FROM submissions WHERE paper_id = $1",
  nodeId: "SELECT DISTINCT node_id::text FROM outline_nodes WHERE paper_id = $1",
  blockId: "SELECT DISTINCT b->'attrs'->>'id' FROM document_revisions r, jsonb_array_elements(r.content_json->'content') b WHERE r.paper_id = $1 AND b->'attrs'->>'id' IS NOT NULL",
  evidenceId: "SELECT id::text FROM evidence_records WHERE paper_id = $1",
  exportId: "SELECT id::text FROM exports WHERE paper_id = $1",
  factId: "SELECT id::text FROM fact_records WHERE paper_id = $1",
  figureId: "SELECT id::text FROM figure_objects WHERE paper_id = $1",
  claimId: "SELECT id::text FROM claims WHERE paper_id = $1",
  threadId: "SELECT id::text FROM comment_threads WHERE paper_id = $1",
  assessmentId: "SELECT a.id::text FROM curation_assessments a JOIN curation_runs r ON r.id = a.run_id WHERE r.paper_id = $1",
  jobId: "SELECT id::text FROM jobs WHERE paper_id = $1",
  proposalId: "SELECT id::text FROM edit_proposals WHERE paper_id = $1",
  flagId: "SELECT id::text FROM figure_review_flags WHERE paper_id = $1",
  commentId: "SELECT id::text FROM review_comments WHERE paper_id = $1",
  id: "SELECT id::text FROM paragraph_proposals WHERE paper_id = $1 UNION SELECT id::text FROM review_findings WHERE paper_id = $1",
  runId: "SELECT id::text FROM review_runs WHERE paper_id = $1",
  importId: "SELECT id::text FROM import_sources WHERE paper_id = $1",
};
const idsOf = async (q: string, paperId: string) => {
  try { return (await pool.query(q, [paperId])).rows.map((r) => Object.values(r)[0] as string); } catch (e) { throw new Error(`${q}: ${(e as Error).message}`, { cause: e }); }
};
// every value an owner's records hold that looks like an id, from every table tied to the owner
async function tablesWith(col: string): Promise<string[]> {
  return (await pool.query<{ t: string }>("SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = $1 ORDER BY 1", [col])).rows.map((r) => r.t);
}
async function rowsOf(w: World): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const t of await tablesWith('paper_id')) out.set(t, (await pool.query(`SELECT coalesce(string_agg(x::text, '|' ORDER BY x::text), '') AS s FROM (SELECT row_to_json(r) AS x FROM ${t} r WHERE paper_id = $1) q`, [w.paperId])).rows[0].s);
  for (const t of (await tablesWith('owner_id')).filter((t) => t !== 'sessions')) out.set(`${t}@owner`, (await pool.query(`SELECT coalesce(string_agg(x::text, '|' ORDER BY x::text), '') AS s FROM (SELECT row_to_json(r) AS x FROM ${t} r WHERE owner_id = $1) q`, [w.ownerId])).rows[0].s);
  return out;
}
const VARIANTS: Record<string, unknown>[] = [
  { status: 'disagree', links: [] },
  { status: 'addressed' },
  { format: 'csl_json' },
  { format: 'source_archive', purpose: 'share' },
  { format: 'markdown', filename: 'x.md' },
  { kind: 'figure', title: 'audit' },
  { mode: 'draft' },
];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw059-assets-'));
  app = buildServer({ pool, allowedOrigins: [ORIGIN], assets: { dir }, eventStreamMaxMs: 300, eventPollMs: 50, zotero: { baseUrl: 'http://127.0.0.1:9' } });
  await app.ready();
  for (const u of ['alice', 'bob']) {
    await createOwner(pool, { username: u, password: 'correct horse battery' });
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: u, password: 'correct horse battery' } });
    H[u] = { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken, origin: ORIGIN };
  }
  A = await buildWorld(app, pool, H.alice!, 'CANARYALICE7f3e');
  B = await buildWorld(app, pool, H.bob!, 'CANARYBOB91c2');
  routes = listRoutes(app);
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const send = (r: Route, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method: r.method as 'GET', url, headers: r.method === 'GET' ? headers : { ...headers, 'content-type': 'application/json' }, payload: r.method === 'GET' ? undefined : JSON.stringify(payload ?? {}) });
const fill = (url: string, ids: Record<string, string>) => url.replace(/:(\w+)/g, (_, k: string) => ids[k] ?? '00000000-0000-4000-8000-000000000000');
// the answer's text, with any ZIP (DOCX, archive) unpacked, so a compressed leak is found too
function seen(x: { body: string; rawPayload: Buffer }): string {
  if (x.rawPayload.subarray(0, 2).toString('latin1') !== 'PK') return x.body;
  try {
    const z = openZip(x.rawPayload, { entries: 5000, totalUnpacked: 256 * 1024 * 1024, part: 64 * 1024 * 1024 });
    return z.names.map((n) => z.read(n)?.toString('utf8') ?? '').join('\n');
  } catch { return x.body; }
}
const note = (kind: string) => { SWEEP_STATS[kind] = (SWEEP_STATS[kind] ?? 0) + 1; };

describe('TST-059A: the route table is fully covered', () => {
  test('the leak detector sees through a ZIP: one\'s own export shows one\'s own canary', async () => {
    const e = (await app.inject({ method: 'GET', url: `/api/papers/${A.paperId}/exports`, headers: H.alice })).json()[0];
    const f = await app.inject({ method: 'GET', url: `/api/papers/${A.paperId}/exports/${e.id}/file`, headers: H.alice });
    expect(f.body).not.toContain(A.canary); // compressed
    expect(seen(f)).toContain(A.canary);
  });
  test('every route is read from the server; every paper route is owner-checked; every path parameter has an id source', () => {
    expect(routes.length).toBeGreaterThan(100);
    const paper = routes.filter((r) => r.url.startsWith('/api/papers/:paperId'));
    expect(paper.length).toBe(app.paperScopedRoutes().length);
    const params = new Set(routes.flatMap((r) => [...r.url.matchAll(/:(\w+)/g)].map((m) => m[1]!)));
    params.delete('paperId');
    for (const p of params) expect(PARAM[p], `no id source for :${p} — add it to the audit`).toBeTruthy();
    // what the fixture made (the more kinds, the deeper the sweep)
    expect(A.made.length).toBeGreaterThan(25);
  });
});

describe('TST-059A: authentication and CSRF on every route', () => {
  test('no session: every private route answers 401 and nothing else', async () => {
    const pub = new Set(['GET /api/health', 'POST /api/setup', 'POST /api/auth/login']);
    for (const r of routes) {
      if (pub.has(`${r.method} ${r.url}`)) continue;
      const x = await send(r, fill(r.url, { paperId: A.paperId }), { origin: ORIGIN });
      expect(x.statusCode, `${r.method} ${r.url}`).toBe(401);
      expect(x.body).not.toContain(A.canary);
    }
  });
  test('a changing request without the CSRF token, or from another origin, is refused and changes nothing', async () => {
    const before = await rowsOf(A);
    for (const r of routes.filter((x) => x.method !== 'GET')) {
      if (r.url === '/api/auth/login' || r.url === '/api/setup') continue;
      const url = fill(r.url, { paperId: A.paperId });
      const noToken = await send(r, url, { cookie: H.alice!.cookie!, origin: ORIGIN });
      expect(noToken.statusCode, `${r.method} ${r.url} without token`).toBe(403);
      const foreign = await send(r, url, { ...H.alice!, origin: 'https://evil.example' });
      expect(foreign.statusCode, `${r.method} ${r.url} from another origin`).toBe(403);
    }
    expect(await rowsOf(A)).toEqual(before);
  });
});

describe('TST-059A: IDOR — another owner\'s paper and ids', () => {
  test('another owner\'s paper: 404 on every paper route, with nothing of it in the answer', async () => {
    const before = await rowsOf(A);
    for (const r of routes.filter((x) => x.url.startsWith('/api/papers/:paperId'))) {
      const x = await send(r, fill(r.url, { paperId: A.paperId }), H.bob!, {});
      expect(x.statusCode, `${r.method} ${r.url}`).toBe(404);
      expect(seen(x)).not.toContain(A.canary);
    }
    // the owner-wide routes never show another owner's records
    for (const r of routes.filter((x) => x.method === 'GET' && !x.url.includes(':'))) expect((await send(r, r.url, H.bob!)).body, r.url).not.toContain(A.canary);
    expect(await rowsOf(A)).toEqual(before);
  });

  test('one\'s own paper with the other owner\'s ids in the path or the body: no data of theirs, no change to it, none of their ids kept', async () => {
    const before = await rowsOf(A);
    const aliceIds: Record<string, string[]> = {};
    const bobIds: Record<string, string> = {};
    for (const [k, q] of Object.entries(PARAM)) {
      aliceIds[k] = await idsOf(q, A.paperId);
      bobIds[k] = (await idsOf(q, B.paperId))[0] ?? '00000000-0000-4000-8000-000000000000';
    }
    const allAlice = [...new Set(Object.values(aliceIds).flat())];
    // the body: every id field the API reads, set to the other owner's records
    const first = (k: string) => aliceIds[k]![0] ?? allAlice[0]!;
    const body = {
      document_id: first('documentId'), revision_id: first('revisionId'), base_revision_id: first('revisionId'), expected_revision_id: first('revisionId'),
      expected_head_revision_id: first('revisionId'), parent_revision_id: first('revisionId'), story_revision_id: first('revisionId'), base_story_revision_id: first('revisionId'),
      outline_revision_id: first('revisionId'), snapshot_id: first('snapshotId'), asset_id: first('assetId'), source_asset_revision_id: first('assetId'),
      evidence_id: first('evidenceId'), node_id: first('nodeId'), block_id: first('blockId'), after_block_id: first('blockId'), job_id: first('jobId'),
      figure_version_id: allAlice[0], reference_id: allAlice[0], reference_ids: allAlice.slice(0, 5), claim_ids: aliceIds.claimId, evidence_ids: aliceIds.evidenceId,
      library_id: allAlice[0], source_candidate_id: allAlice[0], search_ids: allAlice.slice(0, 3), links: [{ revision_id: first('revisionId'), block_id: first('blockId') }],
      intent: 'x', idempotency_key: 'audit-sweep-key-0001', format: 'docx', purpose: 'private', status: 'draft', label: 'audit', text: 'audit', kind: 'manuscript',
    };
    const scoped = routes.filter((x) => x.url.startsWith('/api/papers/:paperId'));
    for (const r of scoped) {
      const params = [...r.url.matchAll(/:(\w+)/g)].map((m) => m[1]!).filter((p) => p !== 'paperId');
      const tries: Record<string, string>[] = [];
      // the other owner's ids in the path (every id in every parameter), and one's own valid path with their ids in the body
      if (params.length) for (const id of allAlice) tries.push({ paperId: B.paperId, ...Object.fromEntries(params.map((p) => [p, id])) });
      tries.push({ paperId: B.paperId, ...Object.fromEntries(params.map((p) => [p, bobIds[p]!])) });
      // a few bodies with valid choices, so requests get past the first validation to where ids are used
      const bodies = r.method === 'GET' ? [body] : [body, ...VARIANTS.map((v) => ({ ...body, ...v }))];
      for (const ids of tries) for (const b of bodies) {
        const x = await send(r, fill(r.url, ids), H.bob!, b);
        note(String(x.statusCode));
        if (x.statusCode >= 500) findings.push(`500: ${r.method} ${r.url} ${JSON.stringify(Object.keys(b).length)}`);
        expect(seen(x), `${r.method} ${r.url} leaked the other owner's text`).not.toContain(A.canary);
      }
    }
    fs.writeFileSync(path.resolve('reports/tasks/PW-059/sweep-stats.json'), `${JSON.stringify({ routes: routes.length, alice_ids: allAlice.length, made: A.made, statuses: SWEEP_STATS }, null, 2)}\n`);
    expect(findings, 'requests ending in an internal error').toEqual([]);
    // the other owner's records are unchanged
    const after = await rowsOf(A);
    for (const [t, s] of before) expect(after.get(t), t).toBe(s);
    // and none of their ids ended up in one's own records
    const bobRows = [...(await rowsOf(B)).entries()];
    const aliceOwn = new Set([...[...before.values()].join('|').matchAll(UUID)].map((m) => m[0]));
    const bobOwn = new Set([...bobRows.map(([, s]) => s).join('|').matchAll(UUID)].map((m) => m[0]));
    const shared = new Set((await pool.query<{ id: string }>("SELECT id::text FROM owners")).rows.map((r) => r.id));
    const crossing = [...bobOwn].filter((u) => aliceOwn.has(u) && !shared.has(u));
    const where = crossing.map((u) => bobRows.filter(([, s]) => s.includes(u)).map(([t]) => t).join(','));
    expect(crossing.map((u, k) => `${u} in ${where[k]}`), 'the other owner\'s ids kept in one\'s own records').toEqual([]);
  }, 600_000);
});
