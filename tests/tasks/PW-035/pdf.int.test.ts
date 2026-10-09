// PW-035 — PDF text extraction and confirmed evidence locations (spec 05 "PDF 파이프라인", "PDF anchor").
// TST-035A: a confirmed sentence can be re-opened with its page, quadpoints, quote and source hash.
// TST-035B: an extraction failure, rotation or a new PDF revision never leads to a guessed location.
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
import { blobPath } from '../../../packages/domain/src/asset-policy/store.ts';
import { quadsFor } from '../../../packages/domain/src/pdf/index.ts';
import { PAPER_V1, PAPER_V2, SENTENCE, makePdf } from './fixtures.ts';

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw035-assets-'));
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

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, headers: H[who], payload: payload as object | undefined });
const newPaper = async () => (await call('alice', 'POST', '/api/papers', { working_title: 'pdf paper', article_type: 'research_article' })).json().id as string;
const upload = async (paperId: string, bytes: Buffer) => {
  const r = await app.inject({ method: 'POST', url: `/api/papers/${paperId}/assets?license=cc-by`, headers: { ...H.alice, 'content-type': 'application/pdf' }, payload: bytes });
  expect(r.statusCode, r.body).toBeLessThan(300);
  return r.json() as { id: string; sha256: string };
};
async function extract(paperId: string, assetId: string, limits?: { timeoutMs?: number }) {
  const r = await call('alice', 'POST', `/api/papers/${paperId}/assets/${assetId}/extract`, { idempotency_key: randomUUID() });
  expect(r.statusCode, r.body).toBeLessThan(300);
  const job = r.json().job;
  await processDelivery(pool, { job_id: job.id, paper_id: paperId, intent: 'parse_source' }, { workerId: 'w', leaseMs: 60_000, handlers: pdfHandlers(pool, { assetDir: dir, limits }) });
  return { job: (await pool.query('SELECT status, last_error, result FROM jobs WHERE id = $1', [job.id])).rows[0], view: (await call('alice', 'GET', `/api/papers/${paperId}/assets/${assetId}/extraction`)).json() };
}
const anchor = (paperId: string, assetId: string, body: unknown, who = 'alice') => call(who, 'POST', `/api/papers/${paperId}/assets/${assetId}/anchors`, body);

describe('TST-035A: a confirmed sentence re-opens with page, quadpoints, quote and source hash', () => {
  test('extraction stores every page with its text, size, rotation and reading-order flags', async () => {
    const p = await newPaper();
    const a = await upload(p, PAPER_V1());
    const { job, view } = await extract(p, a.id);
    expect(job.status).toBe('SUCCEEDED');
    expect(view.extraction).toMatchObject({ status: 'ok', page_count: 2, extractor: 'pdfjs-dist@6.4.299/pw-pdf-1' });
    expect(view.pages[0]).toMatchObject({ page_index: 0, rotate: 0, view_box: [0, 0, 612, 792] });
    expect(view.pages[0].text).toContain(SENTENCE);
    expect(view.pages[1]).toMatchObject({ page_index: 1, rotate: 90, flags: ['page_rotated'] });
    // a second request does not extract again
    const again = await extract(p, a.id);
    expect(again.job.result).toMatchObject({ already: true, extraction_id: view.extraction.id });
    await expect(pool.query('UPDATE pdf_pages SET text = $1', ['x'])).rejects.toThrow(/immutable/);
  });

  test('a selected quote becomes an anchor with page, quadpoints, quote, context, hash and extractor; it re-opens the same', async () => {
    const p = await newPaper();
    const a = await upload(p, PAPER_V1());
    const { view } = await extract(p, a.id);
    const r = await anchor(p, a.id, { page_index: 0, exact: 'induced 2.4-fold' });
    expect(r.statusCode, r.body).toBe(201);
    const an = r.json();
    expect(an).toMatchObject({ asset_revision_id: a.id, sha256: a.sha256, page_index: 0, exact: 'induced 2.4-fold', prefix: 'ABC1 was ', suffix: ' under drought.\nRoots were sampl', extractor: 'pdfjs-dist@6.4.299/pw-pdf-1', status: 'ok', page: { rotate: 0, view_box: [0, 0, 612, 792] } });
    // geometry: the run "ABC1 was induced …" starts at (72, 720) in 12 pt; the quote is one box on that baseline, right of x = 72
    expect(an.quadpoints).toHaveLength(1);
    const [ulx, uly, urx, ury, llx, lly, lrx, lry] = an.quadpoints[0];
    expect(lly).toBeCloseTo(720 / 792, 4);
    expect(uly).toBeCloseTo(732 / 792, 4);
    expect(ury).toBeCloseTo(uly, 6);
    expect(lry).toBeCloseTo(lly, 6);
    expect(llx).toBeCloseTo(ulx, 6);
    expect(lrx).toBeCloseTo(urx, 6);
    expect(ulx).toBeGreaterThan(72 / 612);
    expect(view.pages[0].text.slice(0, 9)).toBe('ABC1 was ');
    // re-open: the same record
    const again = (await call('alice', 'GET', `/api/papers/${p}/anchors/${an.id}`)).json();
    expect(again).toEqual(an);
    expect((await call('alice', 'GET', `/api/papers/${p}/assets/${a.id}/anchors`)).json().anchors.map((x: { id: string }) => x.id)).toEqual([an.id]);
    expect((await call('bob', 'GET', `/api/papers/${p}/anchors/${an.id}`)).statusCode).toBe(404);
    expect((await anchor(p, a.id, { page_index: 0, exact: 'Roots' }, 'bob')).statusCode).toBe(404);
    await expect(pool.query('UPDATE pdf_anchors SET page_index = 1 WHERE id = $1', [an.id])).rejects.toThrow(/immutable/);
  });

  test('quadpoints follow the text run geometry (unit)', () => {
    const r6 = (v: number) => Math.round(v * 1e5) / 1e5;
    // equal-width characters: characters 2–5 of 10 over a 60 pt run
    const q = quadsFor([{ o: 0, n: 10, t: [12, 0, 0, 12, 100, 200], w: 60, h: 12 }], 'nnnnnnnnnn', [0, 0, 600, 800], 2, 5);
    expect(q).toEqual([[(100 + 12) / 600, 212 / 800, (100 + 30) / 600, 212 / 800, 112 / 600, 200 / 800, 130 / 600, 200 / 800].map(r6)]);
    // narrow characters take less of the run than wide ones
    const mixed = quadsFor([{ o: 0, n: 8, t: [12, 0, 0, 12, 0, 0], w: 80, h: 12 }], 'iiiiMMMM', [0, 0, 100, 100], 0, 4)[0]!;
    expect(mixed[2]! - mixed[0]!).toBeLessThan(0.25);
    // vertical text (rotated 90°): the box runs up the page
    const v = quadsFor([{ o: 0, n: 10, t: [0, 12, -12, 0, 300, 300], w: 60, h: 12 }], 'nnnnnnnnnn', [0, 0, 600, 800], 0, 10);
    expect(v[0]!.slice(4)).toEqual([300 / 600, 300 / 800, 300 / 600, 360 / 800].map(r6));
    // a quote across two runs: two quads
    expect(quadsFor([{ o: 0, n: 4, t: [12, 0, 0, 12, 0, 0], w: 24, h: 12 }, { o: 5, n: 4, t: [12, 0, 0, 12, 0, -20], w: 24, h: 12 }], 'abcd\nefgh', [0, 0, 100, 100], 2, 7)).toHaveLength(2);
  });

  test('on a rotated page the location is kept in page space with the rotation, not re-computed', async () => {
    const p = await newPaper();
    const a = await upload(p, PAPER_V1());
    await extract(p, a.id);
    const an = (await anchor(p, a.id, { page_index: 1, exact: 'ABC1 in leaves' })).json();
    expect(an).toMatchObject({ page_index: 1, page: { rotate: 90, flags: ['page_rotated'] }, status: 'ok' });
    // same user-space position as on an unrotated page: the viewer applies /Rotate
    expect(an.quadpoints[0][5]).toBeCloseTo(720 / 792, 4);
  });
});

describe('TST-035B: failures, rotation and new revisions never produce a guessed location', () => {
  test('a quote that is missing or occurs more than once is refused; context makes it unique', async () => {
    const p = await newPaper();
    const a = await upload(p, PAPER_V1());
    await extract(p, a.id);
    expect((await anchor(p, a.id, { page_index: 0, exact: 'induced 3.1-fold' })).json()).toMatchObject({ reason: 'quote_not_found' });
    expect((await anchor(p, a.id, { page_index: 1, exact: SENTENCE })).json()).toMatchObject({ reason: 'quote_not_found' });
    const amb = await anchor(p, a.id, { page_index: 0, exact: 'induced' });
    expect(amb.statusCode).toBe(409);
    expect(amb.json()).toMatchObject({ reason: 'ambiguous', count: 2 });
    expect((await anchor(p, a.id, { page_index: 0, exact: 'induced', prefix: 'was not ' })).statusCode).toBe(201);
    expect((await anchor(p, a.id, { page_index: 9, exact: 'induced' })).statusCode).toBe(404);
    expect((await anchor(p, a.id, { page_index: 0, exact: 'Roots', extra: 1 })).statusCode).toBe(422);
  });

  test('a PDF with no text (an image or drawing) is "no_text": no location can be confirmed, nothing is guessed', async () => {
    const p = await newPaper();
    const a = await upload(p, makePdf([{ raw: '0 0 1 rg 100 100 200 200 re f' }]));
    const { view } = await extract(p, a.id);
    expect(view.extraction).toMatchObject({ status: 'no_text' });
    expect(view.pages[0].flags).toContain('no_text');
    expect((await anchor(p, a.id, { page_index: 0, exact: 'anything' })).json()).toMatchObject({ reason: 'no_text' });
  });

  test('a PDF that cannot be parsed is "failed" with no pages; a timeout is a failure too', async () => {
    const p = await newPaper();
    const broken = await upload(p, makePdf([{ lines: [[72, 720, 'x']] }], { brokenCatalog: true }));
    const { view } = await extract(p, broken.id);
    expect(view.extraction).toMatchObject({ status: 'failed', page_count: null });
    expect(view.extraction.failure_reason).toMatch(/could not be parsed \(InvalidPDFException/);
    expect(view.pages).toEqual([]);
    expect((await anchor(p, broken.id, { page_index: 0, exact: 'x' })).json()).toMatchObject({ reason: 'failed' });
    const slow = await upload(p, makePdf([{ lines: [[72, 720, 'slow']] }]));
    const t = await extract(p, slow.id, { timeoutMs: 1 });
    expect(t.view.extraction).toMatchObject({ status: 'failed' });
    expect(t.view.extraction.failure_reason).toMatch(/longer than/);
  });

  test('rotated text runs are flagged on the page (reading order may differ from what is shown)', async () => {
    const p = await newPaper();
    const a = await upload(p, makePdf([{ raw: 'BT /F1 12 Tf 0 1 -1 0 300 300 Tm (Vertical label) Tj ET' }]));
    const { view } = await extract(p, a.id);
    expect(view.pages[0].flags).toContain('rotated_text');
  });

  test('a new PDF revision gets no location automatically: the anchor stays on its revision; the other gives unconfirmed candidates only', async () => {
    const p = await newPaper();
    const v1 = await upload(p, PAPER_V1());
    const v2 = await upload(p, PAPER_V2());
    await extract(p, v1.id);
    const an = (await anchor(p, v1.id, { page_index: 0, exact: SENTENCE })).json();
    let c = (await call('alice', 'GET', `/api/papers/${p}/anchors/${an.id}/candidates?asset_id=${v2.id}`)).json();
    expect(c).toMatchObject({ status: 'not_extracted', confirmed: false, candidates: [] });
    await extract(p, v2.id);
    c = (await call('alice', 'GET', `/api/papers/${p}/anchors/${an.id}/candidates?asset_id=${v2.id}`)).json();
    expect(c).toMatchObject({ status: 'ok', confirmed: false, candidates: [{ page_index: 1, start: 0, context_matches: false }] });
    // nothing was stored for the new revision, and the anchor still names its own revision and bytes
    expect((await call('alice', 'GET', `/api/papers/${p}/assets/${v2.id}/anchors`)).json().anchors).toEqual([]);
    expect((await call('alice', 'GET', `/api/papers/${p}/anchors/${an.id}`)).json()).toMatchObject({ asset_revision_id: v1.id, sha256: v1.sha256, page_index: 0, status: 'ok' });
  });

  test('an original with an unknown keep right is not parsed; a changed file on disk fails the job', async () => {
    const p = await newPaper();
    const r = await app.inject({ method: 'POST', url: `/api/papers/${p}/assets?keep_right=unknown`, headers: { ...H.alice, 'content-type': 'application/pdf' }, payload: makePdf([{ lines: [[72, 720, 'kept?']] }]) });
    const unknown = r.json();
    expect((await call('alice', 'POST', `/api/papers/${p}/assets/${unknown.id}/extract`, { idempotency_key: randomUUID() })).json()).toMatchObject({ reason: 'keep_right_unknown' });
    const a = await upload(p, makePdf([{ lines: [[72, 720, 'tampered later']] }]));
    const f = blobPath(dir, a.sha256);
    fs.chmodSync(f, 0o644);
    fs.writeFileSync(f, makePdf([{ lines: [[72, 720, 'something else']] }]));
    const { job, view } = await extract(p, a.id);
    expect(job.status).toBe('FAILED');
    expect(job.last_error).toMatch(/integrity/);
    expect(view.extraction).toBeNull();
  });
});

describe('closing gaps found by mutation', () => {
  test('in a document with text, a page without text still refuses a location', async () => {
    const p = await newPaper();
    const a = await upload(p, makePdf([{ lines: [[72, 720, 'Text on page one.']] }, { raw: '0 0 1 rg 100 100 200 200 re f' }]));
    const { view } = await extract(p, a.id);
    expect(view.extraction.status).toBe('ok');
    expect(view.pages[1].flags).toContain('no_text');
    expect((await anchor(p, a.id, { page_index: 1, exact: 'Text on page one.' })).json()).toMatchObject({ reason: 'no_text' });
  });

  test('a page whose content the parser cannot read fails the whole extraction (no partial text is used)', async () => {
    const p = await newPaper();
    const a = await upload(p, makePdf([{ raw: 'BT /F1 12 Tf 72 720 Td (before) Tj ET /Im9 Do BT /F1 12 Tf 72 700 Td (after) Tj ET' }]));
    const { view } = await extract(p, a.id);
    expect(view.extraction).toMatchObject({ status: 'failed' });
    expect(view.pages).toEqual([]);
  });

  test('a stored location whose record no longer matches its page text shows as stale, not as confirmed', async () => {
    const p = await newPaper();
    const a = await upload(p, PAPER_V1());
    await extract(p, a.id);
    const an = (await anchor(p, a.id, { page_index: 0, exact: 'Roots were sampled' })).json();
    // simulate a damaged record (the table is immutable; the trigger is lifted only for this check)
    await pool.query('ALTER TABLE pdf_anchors DISABLE TRIGGER pdf_anchors_immutable_row');
    try {
      await pool.query("UPDATE pdf_anchors SET exact = 'Roots were planted' WHERE id = $1", [an.id]);
    } finally {
      await pool.query('ALTER TABLE pdf_anchors ENABLE TRIGGER pdf_anchors_immutable_row');
    }
    expect((await call('alice', 'GET', `/api/papers/${p}/anchors/${an.id}`)).json()).toMatchObject({ status: 'stale' });
  });
});
