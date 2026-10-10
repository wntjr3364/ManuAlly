// PW-059 security audit — the whole API, swept with two owners (spec 09 "개인 앱도 인증이 필요하다": two
// test owners for IDOR). Every route the server has is taken from its own route table (a new route is
// swept without being listed here); every path parameter must have an id source below, or this test fails.
// TST-059A (negative tests): without a session every private route is 401; without the CSRF token every
//   changing route is 403 (and from another origin too); another owner's paper is 404 on every route; with
//   one's own paper, another owner's ids in the path or the body never return the other owner's data, never
//   change it, and are never stored in one's own records; no request ends in an internal error.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
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
  A = await buildWorld(app, pool, H.alice!, 'CANARYALICE7f3e', '', dir);
  B = await buildWorld(app, pool, H.bob!, 'CANARYBOB91c2', '', dir);
  routes = listRoutes(app);
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// a reading request also carries the id fields the API reads from the query string (review M1: candidates
// by asset_id, proposals by document_id, checks by block_id …), taken from the body's ids
const QUERY = ['asset_id', 'block_id', 'document_id', 'reference_id'] as const;
const send = (r: Route, url: string, headers: Record<string, string>, payload?: unknown) => {
  const b = (payload ?? {}) as Record<string, unknown>;
  const q = QUERY.filter((k) => typeof b[k] === 'string').map((k) => `${k}=${encodeURIComponent(b[k] as string)}`).join('&');
  return app.inject({ method: r.method as 'GET', url: r.method === 'GET' && q ? `${url}?${q}` : url, headers: r.method === 'GET' ? headers : { ...headers, 'content-type': 'application/json' }, payload: r.method === 'GET' ? undefined : JSON.stringify(b) });
};
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
  test('every id source has records of both owners (a kind with no record would be swept with nothing — review M1)', async () => {
    for (const [k, q] of Object.entries(PARAM)) {
      expect((await idsOf(q, A.paperId)).length, `alice has no ${k}`).toBeGreaterThan(0);
      expect((await idsOf(q, B.paperId)).length, `bob has no ${k}`).toBeGreaterThan(0);
    }
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
      paper_id: A.paperId, ids: aliceIds.figureId, handle_id: allAlice[0], handle_ids: allAlice.slice(0, 3), figure_id: first('figureId'), comment_id: first('commentId'),
      nodes: [{ node_id: first('nodeId'), parent_node_id: null, section: 'Results', role: 'result', paragraph_goal: 'g', claim_ids: aliceIds.claimId, evidence_ids: aliceIds.evidenceId, requires_evidence: false, allowed_interpretation: '', exclusions: [], transition: '', word_budget_min: null, word_budget_max: null }],
      facts: [{ evidence_id: first('evidenceId'), entity: 'e', metric: 'm', value_text: '1', unit: 'u', group: 'g', comparison: 'c', n: 3, extraction_method: 'manual_entry' }],
      selection: { blockId: first('blockId'), base_revision_id: first('revisionId') },
      intent: 'x', idempotency_key: 'audit-sweep-key-0001', format: 'docx', purpose: 'private', status: 'draft', label: 'audit', text: 'audit', kind: 'manuscript',
    };
    // the other owner's ids: none may appear in an answer unless the request carried it (review m1)
    const theirs = new Set([...[...before.values()].join('|').matchAll(UUID)].map((m) => m[0]));
    const leakedIds = (x: { body: string; rawPayload: Buffer }, sent: string) => [...seen(x).matchAll(UUID)].map((m) => m[0]).filter((u) => theirs.has(u) && !sent.includes(u));
    const check = (r: Route, url: string, b: unknown, x: { statusCode: number; body: string; rawPayload: Buffer }) => {
      note(String(x.statusCode));
      if (x.statusCode >= 500) findings.push(`500: ${r.method} ${r.url}`);
      expect(seen(x), `${r.method} ${r.url} leaked the other owner's text`).not.toContain(A.canary);
      const ids = leakedIds(x, url + JSON.stringify(b));
      expect(ids, `${r.method} ${r.url} answered with the other owner's ids`).toEqual([]);
    };
    // owner-wide changing routes (budgets, new papers …) with the other owner's ids in the body
    for (const r of routes.filter((x) => x.method !== 'GET' && !x.url.includes(':') && !['/api/auth/login', '/api/auth/logout', '/api/setup'].includes(x.url))) {
      for (const b of [body, { ...body, paper_id: A.paperId, papers: [A.paperId] }]) check(r, r.url, b, await send(r, r.url, H.bob!, b));
    }
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
        const url = fill(r.url, ids);
        check(r, url, b, await send(r, url, H.bob!, b));
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

  // review M1: the references a write keeps without a database guard (see the schema test) — each tried with
  // the other owner's id, and with one's own (the control that shows the request reached the id handling)
  test('targeted cross-paper references: refused with the other owner\'s id, accepted with one\'s own, never kept', async () => {
    const one = async (q: string, w: World) => (await pool.query(q, [w.paperId])).rows[0] as Record<string, string>;
    const rev = async (w: World) => one("SELECT r.id AS rev, b->'attrs'->>'id' AS block FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id, jsonb_array_elements(r.content_json->'content') b WHERE d.paper_id = $1 AND b->>'type' = 'paragraph' LIMIT 1", w);
    const story = async (w: World) => one("SELECT id FROM story_revisions WHERE paper_id = $1 AND status = 'APPROVED'", w);
    const outline = async (w: World) => one("SELECT o.id, n.node_id FROM outline_revisions o JOIN outline_nodes n ON n.outline_revision_id = o.id WHERE o.paper_id = $1 AND o.status = 'APPROVED' LIMIT 1", w);
    const search = async (w: World) => one('SELECT id FROM literature_searches WHERE paper_id = $1', w);
    // re-review M1': an outline node's claim and evidence ids (an id array, no foreign key)
    const records = async (w: World) => one('SELECT (SELECT id FROM claims WHERE paper_id = $1 LIMIT 1) AS claim, (SELECT id FROM evidence_records WHERE paper_id = $1 LIMIT 1) AS evidence', w);
    const outlineSave = async (claim: string, evidence: string) => ({
      parent_revision_id: (await one('SELECT id FROM outline_revisions WHERE paper_id = $1 ORDER BY created_at DESC LIMIT 1', B)).id, story_revision_id: (await story(B)).id,
      nodes: [{ node_id: crypto.randomUUID(), parent_node_id: null, section: 'Results', role: 'result', paragraph_goal: 'audit', claim_ids: [claim], evidence_ids: [evidence], requires_evidence: true }],
    });
    const cases: [string, (v: World) => Promise<Record<string, unknown>>, string][] = [
      ['/documents/:doc/scientific-checks', async (v) => ({ revision_id: (await rev(v)).rev, block_id: (await rev(v)).block }), 'scientific check'],
      ['/reviews', async (v) => ({ document_id: B.documentId, revision_id: (await rev(v)).rev, block_id: (await rev(v)).block, idempotency_key: crypto.randomUUID() }), 'review'],
      ['/story-alternatives/runs', async (v) => ({ base_story_revision_id: (await story(v)).id, idempotency_key: crypto.randomUUID() }), 'story alternatives'],
      ['/writer/requests', async (v) => ({ mode: 'draft', outline_revision_id: (await outline(v)).id, node_id: (await outline(v)).node_id, document_id: B.documentId, base_revision_id: (await rev(B)).rev, idempotency_key: crypto.randomUUID() }), 'writer'],
      ['/ai/draft-requests', async (v) => ({ outline_revision_id: (await outline(v)).id, node_id: (await outline(v)).node_id, instruction: 'write this paragraph' }), 'draft request'],
      ['/curation/runs', async (v) => ({ search_ids: [(await search(v)).id], idempotency_key: crypto.randomUUID() }), 'curation'],
      ['/outline/revisions', async (v) => outlineSave((await records(v)).claim!, (await records(B)).evidence!), 'outline node claim ids'],
      ['/outline/revisions', async (v) => outlineSave((await records(B)).claim!, (await records(v)).evidence!), 'outline node evidence ids'],
    ];
    const before = await rowsOf(A);
    const theirs = new Set([...[...before.values()].join('|').matchAll(UUID)].map((m) => m[0]));
    for (const [route, make, what] of cases) {
      const url = `/api/papers/${B.paperId}${route.replace(':doc', B.documentId)}`;
      const attack = await app.inject({ method: 'POST', url, headers: H.bob!, payload: await make(A) });
      // the control: one's own ids are accepted, or stopped later by a gate that read them (409)
      const control = await app.inject({ method: 'POST', url, headers: H.bob!, payload: await make(B) });
      expect(control.statusCode < 300 || control.statusCode === 409, `${what} with one's own ids (the control): ${control.statusCode} ${control.body}`).toBe(true);
      // the other owner's record is not found, not acceptable, or not this paper's (a different refusal than the control's)
      expect(attack.statusCode >= 400 && attack.statusCode < 500, `${what} with the other owner's id: ${attack.statusCode} ${attack.body}`).toBe(true);
      if (attack.statusCode === 409) expect(attack.json().reasons, `${what}: refused for the same reason as one's own request`).not.toEqual(control.statusCode === 409 ? control.json().reasons : undefined);
    }
    expect(await rowsOf(A)).toEqual(before);
    const kept = [...(await rowsOf(B)).entries()].filter(([, v]) => [...v.matchAll(UUID)].some((m) => theirs.has(m[0]))).map(([t]) => t);
    expect(kept, 'the other owner\'s ids kept in one\'s own records').toEqual([]);
  });

  // re-review M1': ids inside a manuscript (citations, figure references) are the owner's own text — a manual
  // edit is never refused — and they are resolved only within the paper: another paper's reference or figure
  // is an unresolved error in the export (which blocks a submission), and nothing of it is shown.
  test('another paper\'s ids written into one\'s manuscript resolve to nothing: an export error, none of its content', async () => {
    const one = async (q: string, w: World) => (await pool.query(q, [w.paperId])).rows[0] as Record<string, string>;
    const theirRef = (await one('SELECT reference_id AS id FROM project_references WHERE paper_id = $1 LIMIT 1', A)).id!;
    const theirFig = (await one('SELECT id FROM figure_objects WHERE paper_id = $1 LIMIT 1', A)).id!;
    const P = `/api/papers/${B.paperId}`;
    const head = (await app.inject({ method: 'GET', url: `${P}/documents/${B.documentId}`, headers: H.bob! })).json().head;
    const content = head.content_json as { content: unknown[] };
    content.content.push({ type: 'paragraph', attrs: { id: crypto.randomUUID() }, content: [{ type: 'text', text: 'As shown before ' }, { type: 'citation', attrs: { referenceId: theirRef, locator: null } }, { type: 'text', text: ' (' }, { type: 'figure_ref', attrs: { targetId: theirFig } }, { type: 'text', text: ').' }] });
    const saved = await app.inject({ method: 'POST', url: `${P}/documents/${B.documentId}/saves`, headers: H.bob!, payload: { schema_version: 1, reason: 'manual', expected_head_revision_id: head.id, content_json: content } });
    expect(saved.statusCode, saved.body).toBe(201);
    const ex = await app.inject({ method: 'POST', url: `${P}/exports`, headers: H.bob!, payload: { document_id: B.documentId, format: 'docx' } });
    expect(ex.statusCode, ex.body).toBe(201);
    const kinds = JSON.stringify(ex.json());
    expect(kinds).toContain('unresolved_citation');
    expect(kinds).toContain('unresolved_figure');
    expect(kinds).not.toContain(A.canary);
    const file = await app.inject({ method: 'GET', url: `${P}/exports/${ex.json().id}/file`, headers: H.bob! });
    expect(file.statusCode).toBe(200);
    expect(seen(file)).not.toContain(A.canary);
  });

  // review M1: what the sweep really reaches. The owner's own well-formed path (their own ids of the right
  // kind) and the same bodies: a reading route must answer 2xx (else the cross-owner 404s above prove
  // nothing for it); a changing route is "reached" when its own request gets past validation (2xx or 409).
  // Routes the generic bodies do not get past are listed in the audit as not reached by the sweep — their
  // cross-owner checks are the task tests (SEC areas), not this sweep. Runs last: it may change the owner's data.
  test('positive control: every reading route answers its owner; the changing routes the sweep reaches are recorded', async () => {
    const own: Record<string, string[]> = {};
    for (const [k, q] of Object.entries(PARAM)) own[k] = await idsOf(q, A.paperId);
    const refIds = (await pool.query<{ id: string }>('SELECT reference_id::text AS id FROM project_references WHERE paper_id = $1', [A.paperId])).rows.map((r) => r.id);
    // the k-th own id of each kind (so every kind's records get their turn)
    const at = (k: number) => (x: string) => own[x]![k % own[x]!.length]!;
    const bodyAt = (k: number) => {
      const o = at(k);
      return {
        document_id: o('documentId'), revision_id: o('revisionId'), base_revision_id: o('revisionId'), expected_revision_id: o('revisionId'), expected_head_revision_id: o('revisionId'),
        snapshot_id: o('snapshotId'), asset_id: o('assetId'), evidence_id: o('evidenceId'), node_id: o('nodeId'), block_id: o('blockId'), job_id: o('jobId'), reference_id: refIds[k % refIds.length],
        intent: 'x', idempotency_key: 'audit-control-key-0001', format: 'docx', purpose: 'private', status: 'draft', label: 'audit', text: 'audit', kind: 'manuscript',
      };
    };
    const reading: string[] = [];
    const reached: string[] = [];
    const notReached: Record<string, number> = {};
    const GET_EXCEPTIONS: Record<string, string> = {
      'GET /api/papers/:paperId/references/zotero': 'needs the owner\'s Zotero key (none in the fixture); refused 409 before any request',
    };
    for (const r of routes.filter((x) => x.url.startsWith('/api/papers/:paperId'))) {
      const params = [...r.url.matchAll(/:(\w+)/g)].map((m) => m[1]!).filter((x) => x !== 'paperId');
      const n = Math.max(1, ...params.map((x) => own[x]!.length), r.method === 'GET' ? own.assetId!.length : 1);
      let best = 0;
      for (let k = 0; k < Math.min(n, 8) && !(best >= 200 && best < 300); k++) {
        const ids: Record<string, string> = { paperId: A.paperId, ...Object.fromEntries(params.map((x) => [x, at(k)(x)])) };
        const body = bodyAt(k);
        for (const b of r.method === 'GET' ? [body] : [body, ...VARIANTS.map((v) => ({ ...body, ...v }))]) {
          const x = await send(r, fill(r.url, ids), H.alice!, b);
          if (x.statusCode >= 200 && x.statusCode < 300) { best = x.statusCode; break; }
          if (x.statusCode === 409 && (best < 200 || best >= 300)) best = 409;
          else if (!best) best = x.statusCode;
        }
      }
      const key = `${r.method} ${r.url}`;
      if (r.method === 'GET') {
        if (best >= 200 && best < 300) reading.push(key);
        else expect(GET_EXCEPTIONS[key], `${key}: the owner's own request answered ${best} — the cross-owner check proves nothing here`).toBeTruthy();
      } else if ((best >= 200 && best < 300) || best === 409) reached.push(key);
      else notReached[key] = best;
    }
    const stats = JSON.parse(fs.readFileSync(path.resolve('reports/tasks/PW-059/sweep-stats.json'), 'utf8'));
    fs.writeFileSync(path.resolve('reports/tasks/PW-059/sweep-stats.json'), `${JSON.stringify({ ...stats, coverage: { reading_routes_answering_owner: reading.length, changing_routes_reached: reached.length, changing_routes_not_reached: notReached, get_exceptions: GET_EXCEPTIONS } }, null, 2)}\n`);
    expect(reading.length).toBeGreaterThan(40);
  }, 600_000);
});
