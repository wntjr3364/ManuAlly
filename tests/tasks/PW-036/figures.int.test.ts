// PW-036 — figure/table/fact source tracing and impact review (spec 05 "Figure/Table 관리", "Evidence와 Fact").
// TST-036A: from a manuscript claim, the figure/table (version, panel, unit, groups), the source location
//   and the fact values can be traced.
// TST-036B: a new figure version, a unit change or a group change never reaches the linked paragraphs,
//   claims and facts silently: they get open review flags that only the owner closes.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { processDelivery } from '../../../apps/worker/src/queue/index.ts';
import { pdfHandlers } from '../../../apps/worker/src/pdf/index.ts';
import { versionChanges } from '../../../packages/domain/src/figures/index.ts';
import { PAPER_V1 } from '../PW-035/fixtures.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
let dir: string;
const H: Record<string, Record<string, string>> = {};
const ids: Record<string, string> = {};
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw036-assets-'));
  app = buildServer({ pool, allowedOrigins: [ORIGIN], assets: { dir } });
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
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (who: string, method: 'GET' | 'POST', url: string, payload?: unknown, expectCode?: number) => {
  const r = await app.inject({ method, url, headers: H[who], payload: payload as object | undefined });
  if (expectCode) expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(expectCode);
  return r;
};
const PNG = (seed: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`synthetic image ${seed}`)]);
const uploadFile = async (paperId: string, figureId: string, bytes: Buffer, type = 'image/png') =>
  app.inject({ method: 'POST', url: `/api/papers/${paperId}/figures/${figureId}/files?name=fig.png`, headers: { ...H.alice, 'content-type': type }, payload: bytes });

// a paper with: figure F (version 1, panel A in "fold", groups WT/abc1), a manuscript paragraph that
// mentions F and one that does not, verified figure-panel evidence linked to F v1, a fact and a claim
async function setup() {
  const p = (await call('alice', 'POST', '/api/papers', { working_title: 'figure paper', article_type: 'research_article' }, 201)).json().id as string;
  const fig = (await call('alice', 'POST', `/api/papers/${p}/figures`, { kind: 'figure', title: 'ABC1 induction' }, 201)).json();
  const file1 = (await uploadFile(p, fig.id, PNG('v1'))).json();
  const v1 = (await call('alice', 'POST', `/api/papers/${p}/figures/${fig.id}/versions`, { caption: 'ABC1 induction in roots.', panels: [{ panel: 'A', unit: 'fold', groups: ['WT', 'abc1'] }], asset_id: file1.asset_id }, 201)).json();
  const doc = (await call('alice', 'POST', `/api/papers/${p}/documents`, { kind: 'manuscript' }, 201)).json().document;
  const [b1, b2] = [randomUUID(), randomUUID()];
  await call('alice', 'POST', `/api/papers/${p}/documents/${doc.id}/revisions`, {
    expected_head_revision_id: doc.head_revision_id, schema_version: 1, reason: 'manual',
    content_json: { type: 'doc', content: [
      { type: 'paragraph', attrs: { id: b1 }, content: [{ type: 'text', text: 'ABC1 was induced (' }, { type: 'figure_ref', attrs: { targetId: fig.id } }, { type: 'text', text: ').' }] },
      { type: 'paragraph', attrs: { id: b2 }, content: [{ type: 'text', text: 'An unrelated paragraph.' }] },
    ] },
  }, 201);
  const ev = (await call('alice', 'POST', `/api/papers/${p}/evidence`, { kind: 'figure_panel', source_asset_revision_id: file1.asset_id, locator: { panel: 'A', figure: fig.id }, label: 'Fig. 1A bar' }, 201)).json();
  await call('alice', 'POST', `/api/papers/${p}/evidence/${ev.id}/figure-link`, { figure_version_id: v1.version.id, panel: 'A' }, 201);
  const fact = (await call('alice', 'POST', `/api/papers/${p}/facts`, { evidence_id: ev.id, entity: 'ABC1', metric: 'fold change', value_text: '2.4', unit: 'fold', group: 'abc1 vs WT', comparison: 'WT', n: 3, extraction_method: 'figure_reading' }, 201)).json();
  const claim = (await call('alice', 'POST', `/api/papers/${p}/claims`, { kind: 'observation', text: 'ABC1 is induced 2.4-fold under drought.' }, 201)).json();
  await call('alice', 'POST', `/api/papers/${p}/claims/${claim.id}/evidence-links`, { evidence_id: ev.id, relation: 'supports' }, 201);
  return { p, fig, file1, v1: v1.version, doc, b1, b2, ev, fact: Array.isArray(fact) ? fact[0] : fact, claim };
}

describe('TST-036A: a claim traces to its figure/table, source location and values', () => {
  test('claim → evidence → figure (number, version, panel, unit, groups) → fact values', async () => {
    const s = await setup();
    const t = (await call('alice', 'GET', `/api/papers/${s.p}/claims/${s.claim.id}/trace`, undefined, 200)).json();
    expect(t.claim).toMatchObject({ id: s.claim.id, text: 'ABC1 is induced 2.4-fold under drought.' });
    expect(t.links).toHaveLength(1);
    expect(t.links[0]).toMatchObject({
      relation: 'supports',
      evidence: { id: s.ev.id, kind: 'figure_panel', label: 'Fig. 1A bar', source_asset_revision_id: s.file1.asset_id },
      figure: { id: s.fig.id, kind: 'figure', number: 1, title: 'ABC1 induction', version_no: 1, current_version_no: 1, outdated: false, panel: 'A', unit: 'fold', groups: ['WT', 'abc1'] },
      facts: [{ value_text: '2.4', unit: 'fold', group_label: 'abc1 vs WT', comparison: 'WT', n: 3, unit_matches_panel: true }],
    });
    expect(t.open_flags).toEqual([]);
    expect((await call('bob', 'GET', `/api/papers/${s.p}/claims/${s.claim.id}/trace`)).statusCode).toBe(404);
    // a value recorded in another unit than its panel shows as a mismatch in the trace
    await call('alice', 'POST', `/api/papers/${s.p}/facts`, { evidence_id: s.ev.id, entity: 'ABC1', metric: 'fold change', value_text: '1.3', unit: 'log2 fold', group: 'abc1 vs WT', comparison: 'WT', n: 3, extraction_method: 'figure_reading' }, 201);
    const t2 = (await call('alice', 'GET', `/api/papers/${s.p}/claims/${s.claim.id}/trace`, undefined, 200)).json();
    expect(t2.links[0].facts.map((f: { unit: string; unit_matches_panel: boolean }) => [f.unit, f.unit_matches_panel])).toEqual([['fold', true], ['log2 fold', false]]);
  });

  test('literature evidence traces to its confirmed PDF location (page, quote, source hash)', async () => {
    const s = await setup();
    const ref = (await call('alice', 'POST', `/api/papers/${s.p}/references`, { title: 'Synthetic source', authors: [{ family: 'Kim' }] }, 201)).json();
    const pdf = (await app.inject({ method: 'POST', url: `/api/papers/${s.p}/assets?license=cc-by&reference_id=${ref.id}`, headers: { ...H.alice, 'content-type': 'application/pdf' }, payload: PAPER_V1() })).json();
    const job = (await call('alice', 'POST', `/api/papers/${s.p}/assets/${pdf.id}/extract`, { idempotency_key: randomUUID() }, 201)).json().job;
    await processDelivery(pool, { job_id: job.id, paper_id: s.p, intent: 'parse_source' }, { workerId: 'w', leaseMs: 60_000, handlers: pdfHandlers(pool, { assetDir: dir }) });
    const an = (await call('alice', 'POST', `/api/papers/${s.p}/assets/${pdf.id}/anchors`, { page_index: 0, exact: 'induced 2.4-fold' }, 201)).json();
    // the quote must be the anchored text
    expect((await call('alice', 'POST', `/api/papers/${s.p}/evidence`, { kind: 'literature_excerpt', reference_id: ref.id, locator: { quote: 'induced 3-fold', anchor_id: an.id } })).statusCode).toBe(422);
    const lit = (await call('alice', 'POST', `/api/papers/${s.p}/evidence`, { kind: 'literature_excerpt', reference_id: ref.id, locator: { quote: 'induced 2.4-fold', anchor_id: an.id } }, 201)).json();
    await call('alice', 'POST', `/api/papers/${s.p}/claims/${s.claim.id}/evidence-links`, { evidence_id: lit.id, relation: 'supports' }, 201);
    const t = (await call('alice', 'GET', `/api/papers/${s.p}/claims/${s.claim.id}/trace`, undefined, 200)).json();
    expect(t.links.find((l: { evidence: { id: string } }) => l.evidence.id === lit.id).source_location).toMatchObject({ id: an.id, asset_revision_id: pdf.id, sha256: pdf.sha256, page_index: 0, exact: 'induced 2.4-fold' });
  });

  test('evidence is linked only to a version whose file it was read from; versions keep the figure number', async () => {
    const s = await setup();
    const other = (await call('alice', 'POST', `/api/papers/${s.p}/figures`, { kind: 'figure', title: 'Leaves' }, 201)).json();
    const f2 = (await uploadFile(s.p, other.id, PNG('other'))).json();
    const v = (await call('alice', 'POST', `/api/papers/${s.p}/figures/${other.id}/versions`, { caption: 'Leaves.', panels: [{ panel: 'A', unit: 'mm' }], asset_id: f2.asset_id }, 201)).json();
    const ev2 = (await call('alice', 'POST', `/api/papers/${s.p}/evidence`, { kind: 'figure_panel', source_asset_revision_id: s.file1.asset_id, locator: { panel: 'B' } }, 201)).json();
    expect((await call('alice', 'POST', `/api/papers/${s.p}/evidence/${ev2.id}/figure-link`, { figure_version_id: v.version.id, panel: 'A' })).json()).toMatchObject({ reason: 'different_file' });
    expect((await call('alice', 'POST', `/api/papers/${s.p}/evidence/${ev2.id}/figure-link`, { figure_version_id: s.v1.id, panel: 'Z' })).statusCode).toBe(422);
    expect((await call('alice', 'POST', `/api/papers/${s.p}/evidence/${s.ev.id}/figure-link`, { figure_version_id: s.v1.id, panel: 'A' })).statusCode).toBe(409);
    expect((await call('alice', 'GET', `/api/papers/${s.p}/figures/${s.fig.id}/versions`, undefined, 200)).json().versions.map((x: { version_no: number }) => x.version_no)).toEqual([1]);
  });
});

describe('TST-036B: a new version, unit or group change is never applied silently', () => {
  test('a unit change flags the paragraph that mentions the figure, the claim and the fact; nothing else', async () => {
    const s = await setup();
    const r = (await call('alice', 'POST', `/api/papers/${s.p}/figures/${s.fig.id}/versions`, { caption: 'ABC1 induction in roots.', panels: [{ panel: 'A', unit: 'log2 fold', groups: ['WT', 'abc1'] }], asset_id: s.file1.asset_id }, 201)).json();
    expect(r.changes).toEqual(['unit_changed:A']);
    const flags = (await call('alice', 'GET', `/api/papers/${s.p}/review-flags`, undefined, 200)).json().flags;
    expect(flags.map((f: { target_kind: string }) => f.target_kind).sort()).toEqual(['claim', 'fact', 'paragraph']);
    expect(flags.find((f: { target_kind: string }) => f.target_kind === 'paragraph')).toMatchObject({ block_id: s.b1, document_id: s.doc.id, reasons: ['unit_changed:A'], from_version_no: 1, to_version_no: 2 });
    expect(flags.find((f: { target_kind: string }) => f.target_kind === 'fact')).toMatchObject({ fact_id: s.fact.id, reasons: ['unit_changed:A', 'fact_unit_differs:A'] });
    expect(flags.some((f: { block_id: string | null }) => f.block_id === s.b2)).toBe(false);
    // the trace shows the evidence was read from an older version, and the open flag
    const t = (await call('alice', 'GET', `/api/papers/${s.p}/claims/${s.claim.id}/trace`, undefined, 200)).json();
    expect(t.links[0].figure).toMatchObject({ version_no: 1, current_version_no: 2, outdated: true });
    expect(t.open_flags).toHaveLength(1);
    // the manuscript text itself was not changed
    const head = (await pool.query('SELECT r.content_json FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.id = $1', [s.doc.id])).rows[0].content_json;
    expect(JSON.stringify(head)).toContain('ABC1 was induced (');
  });

  test('group changes, a new file, added/removed panels and caption changes are each named', async () => {
    const s = await setup();
    const file2 = (await uploadFile(s.p, s.fig.id, PNG('v2'))).json();
    const r = (await call('alice', 'POST', `/api/papers/${s.p}/figures/${s.fig.id}/versions`, { caption: 'ABC1 induction (corrected).', panels: [{ panel: 'A', unit: 'fold', groups: ['WT', 'abc1', 'abc2'] }, { panel: 'B', unit: 'mm' }], asset_id: file2.asset_id }, 201)).json();
    expect(r.changes).toEqual(['new_file', 'caption_changed', 'groups_changed:A', 'panel_added:B']);
    expect(versionChanges({ caption: 'x', panels: [{ panel: 'A', unit: '', groups: [], description: '' }], asset_revision_id: null }, { caption: 'x', panels: [], asset_revision_id: null })).toEqual(['panel_removed:A']);
    // an identical version is refused (nothing to review)
    expect((await call('alice', 'POST', `/api/papers/${s.p}/figures/${s.fig.id}/versions`, { caption: 'ABC1 induction (corrected).', panels: [{ panel: 'A', unit: 'fold', groups: ['WT', 'abc1', 'abc2'] }, { panel: 'B', unit: 'mm' }], asset_id: file2.asset_id })).json()).toMatchObject({ reason: 'unchanged' });
  });

  test('only the owner closes a flag, once, with a note; closed flags stay on record', async () => {
    const s = await setup();
    await call('alice', 'POST', `/api/papers/${s.p}/figures/${s.fig.id}/versions`, { caption: 'Changed caption.', panels: [{ panel: 'A', unit: 'fold', groups: ['WT', 'abc1'] }], asset_id: s.file1.asset_id }, 201);
    const [f] = (await call('alice', 'GET', `/api/papers/${s.p}/review-flags`, undefined, 200)).json().flags;
    expect((await call('bob', 'POST', `/api/papers/${s.p}/review-flags/${f.id}/resolve`, { note: 'x' })).statusCode).toBe(404);
    expect((await call('alice', 'POST', `/api/papers/${s.p}/review-flags/${f.id}/resolve`, { note: 'caption wording only' }, 200)).json()).toMatchObject({ status: 'resolved' });
    expect((await call('alice', 'POST', `/api/papers/${s.p}/review-flags/${f.id}/resolve`, {})).statusCode).toBe(404);
    expect((await call('alice', 'GET', `/api/papers/${s.p}/review-flags?status=all`, undefined, 200)).json().flags.find((x: { id: string }) => x.id === f.id)).toMatchObject({ status: 'resolved' });
    await expect(pool.query("UPDATE figure_review_flags SET status = 'open', resolved_at = NULL WHERE id = $1", [f.id])).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM figure_review_flags WHERE id = $1', [f.id])).rejects.toThrow(/immutable/);
    await expect(pool.query('UPDATE figure_versions SET caption = $1', ['x'])).rejects.toThrow(/immutable/);
  });

  test('figure files are checked by content; SVG/HTML are not accepted', async () => {
    const s = await setup();
    expect((await uploadFile(s.p, s.fig.id, Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml')).statusCode).toBe(415);
    expect((await uploadFile(s.p, s.fig.id, Buffer.from('GIF89a not a png'))).json()).toMatchObject({ reason: 'not_png' });
    expect((await uploadFile(s.p, s.fig.id, Buffer.from('a,b\n1,\u0000'), 'text/csv')).json()).toMatchObject({ reason: 'not_utf8_text' });
    expect((await uploadFile(s.p, s.fig.id, Buffer.from('group,value\nWT,1.0\n'), 'text/csv')).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/papers/${s.p}/figures/${s.fig.id}/files`, headers: { ...H.bob, 'content-type': 'image/png' }, payload: PNG('bob') })).statusCode).toBe(404);
    // a figure of another paper is not this paper's figure
    const other = await setup();
    expect((await uploadFile(s.p, other.fig.id, PNG('cross'))).statusCode).toBe(404);
  });
});
