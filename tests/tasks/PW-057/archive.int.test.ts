// PW-057 — the reading PDF and the source archive through the API, against a temporary database and asset
// store. The archive is made from a named snapshot (later edits do not reach it), carries only the originals
// its purpose allows, is downloaded from the store against its recorded hash, and verifies on its own.
// TST-057A: the archive alone verifies the snapshot's references and outputs.
// TST-057B: an original without the right to share stays out of a share bundle; a missing blob makes the
//   archive 'incomplete', never a success.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { blobPath } from '../../../packages/domain/src/asset-policy/store.ts';
import { verifyArchive } from '../../../packages/exports/src/archive/index.ts';
import { createArchiveExport } from '../../../packages/exports/src/archive/service.ts';
import { findSoffice } from '../../../packages/exports/src/pdf/index.ts';
import { openZip } from '../../../packages/domain/src/imports/docx/zip.ts';
import { PAPER_V1, PAPER_V2 } from '../PW-035/fixtures.ts';
import { createProposal } from '../../../packages/domain/src/proposals/index.ts';
import { parseDocument, snapshotSelection } from '../../../packages/editor-core/src/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
let dir: string;
const H: Record<string, Record<string, string>> = {};
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 6 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw057-assets-'));
  app = buildServer({ pool, allowedOrigins: [ORIGIN], assets: { dir } });
  await app.ready();
  for (const u of ['alice', 'bob']) {
    await createOwner(pool, { username: u, password: 'correct horse battery' });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: u, password: 'correct horse battery' } });
    H[u] = { cookie: String(res.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': res.json().csrfToken, origin: ORIGIN };
  }
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const call = (method: 'GET' | 'POST', url: string, payload?: unknown, who = 'alice') => app.inject({ method, url, headers: H[who], payload: payload as object | undefined });
const t = (text: string) => ({ type: 'text', text });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const PNG = (seed: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`synthetic image ${seed}`)]);

// a paper with a reference, a figure with its image file and caption, two source PDFs (cc-by-nc and cc-by),
// a manuscript citing the reference and the figure, and a named snapshot
async function paper() {
  const p = (await call('POST', '/api/papers', { working_title: 'archive paper', article_type: 'research_article' })).json();
  const ref = (await call('POST', `/api/papers/${p.id}/references`, { title: 'Root signals under drought', authors: [{ family: 'Kim', given: 'Jiyoon' }], year: 2020, container: 'Journal of Plant Studies', doi: '10.1234/jps.2020.1' })).json();
  const fig = (await call('POST', `/api/papers/${p.id}/figures`, { kind: 'figure', title: 'Root induction' })).json();
  const png = PNG(randomUUID());
  const file = (await app.inject({ method: 'POST', url: `/api/papers/${p.id}/figures/${fig.id}/files?name=fig.png`, headers: { ...H.alice, 'content-type': 'image/png' }, payload: png })).json();
  const v = await call('POST', `/api/papers/${p.id}/figures/${fig.id}/versions`, { caption: 'ABC1 induction in roots (n = 3).', panels: [], asset_id: file.asset_id });
  expect(v.statusCode, v.body).toBe(201);
  const upload = async (bytes: Buffer, license: string) => {
    const r = await app.inject({ method: 'POST', url: `/api/papers/${p.id}/assets?license=${license}`, headers: { ...H.alice, 'content-type': 'application/pdf' }, payload: bytes });
    expect(r.statusCode, r.body).toBe(201);
    return { ...r.json(), bytes };
  };
  const nc = await upload(PAPER_V1(), 'cc-by-nc');
  const by = await upload(PAPER_V2(), 'cc-by');
  const d = (await call('POST', `/api/papers/${p.id}/documents`, { kind: 'manuscript' })).json();
  const content = { type: 'doc', content: [
    { type: 'heading', attrs: { id: randomUUID(), level: 1 }, content: [t('Results')] },
    { type: 'paragraph', attrs: { id: randomUUID() }, content: [t('Roots respond '), { type: 'citation', attrs: { referenceId: ref.id, locator: null } }, t(' ('), { type: 'figure_ref', attrs: { targetId: fig.id } }, t(').')] },
  ] };
  const saved = await call('POST', `/api/papers/${p.id}/documents/${d.document.id}/saves`, { schema_version: 1, reason: 'manual', expected_head_revision_id: d.head.id, content_json: content });
  expect(saved.statusCode, saved.body).toBe(201);
  const snap = await call('POST', `/api/papers/${p.id}/snapshots`, { label: 'submitted v1' });
  expect(snap.statusCode, snap.body).toBe(201);
  return { paperId: p.id as string, documentId: d.document.id as string, head: saved.json().id as string, refId: ref.id as string, png, pngSha: sha(png), nc, by, snapshotId: snap.json().id as string };
}
const download = async (paperId: string, id: string) => {
  const f = await call('GET', `/api/papers/${paperId}/exports/${id}/file`);
  return f;
};

describe('TST-057A/B: the source archive', () => {
  test('a share archive of the snapshot: only shareable originals, verified by the archive alone, unaffected by later edits', async () => {
    const w = await paper();
    // an edit after the snapshot does not reach the archive
    const later = await call('POST', `/api/papers/${w.paperId}/documents/${w.documentId}/saves`, { schema_version: 1, reason: 'manual', expected_head_revision_id: w.head, content_json: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: randomUUID() }, content: [t('rewritten after the snapshot')] }] } });
    expect(later.statusCode, later.body).toBe(201);
    const r = await call('POST', `/api/papers/${w.paperId}/exports`, { format: 'source_archive', snapshot_id: w.snapshotId, purpose: 'share' });
    expect(r.statusCode, r.body).toBe(201);
    const e = r.json();
    expect(e).toMatchObject({ format: 'source_archive', purpose: 'share', snapshot_id: w.snapshotId, revision_id: w.head, status: 'clean' });
    expect(e.report.verification).toMatchObject({ ok: true, reproduced: true });
    expect(e.report.excluded.map((x: { sha256: string; reason: string }) => [x.sha256, x.reason]).sort()).toEqual([[sha(w.nc.bytes), 'licence_does_not_allow_sharing'], [w.pngSha, 'licence_unknown']].sort());
    const f = await download(w.paperId, e.id);
    expect(f.statusCode).toBe(200);
    expect(f.headers['content-type']).toBe('application/zip');
    expect(String(f.headers['content-disposition'])).toContain('source-archive-share.zip');
    expect(sha(f.rawPayload)).toBe(e.sha256);
    // the archive alone
    const v = verifyArchive(f.rawPayload);
    expect(v).toMatchObject({ ok: true, status: 'complete', reproduced: true, problems: [] });
    const z = openZip(f.rawPayload);
    expect(z.names).toContain(`assets/${sha(w.by.bytes)}`);
    expect(z.names).not.toContain(`assets/${sha(w.nc.bytes)}`);
    expect(z.names).not.toContain(`assets/${w.pngSha}`);
    const docJson = JSON.parse(z.read(`documents/${w.documentId}.json`)!.toString());
    expect(docJson).toMatchObject({ revision_id: w.head, schema_version: 1 });
    expect(JSON.stringify(docJson.content)).not.toContain('rewritten after the snapshot');
    const csl = JSON.parse(z.read('references.csl.json')!.toString());
    expect(csl).toEqual([expect.objectContaining({ id: w.refId, title: 'Root signals under drought', 'pw:bibliographic_revision_id': expect.any(String) })]);
    expect(JSON.parse(z.read('figures.json')!.toString())).toEqual([expect.objectContaining({ title: 'Root induction', caption: 'ABC1 induction in roots (n = 3).' })]);
    expect(v.manifest!.snapshot).toMatchObject({ id: w.snapshotId, label: 'submitted v1', citation_style: 'numeric' });
  });

  test('a private archive keeps every original; listing and the record say so', async () => {
    const w = await paper();
    const e = (await call('POST', `/api/papers/${w.paperId}/exports`, { format: 'source_archive', snapshot_id: w.snapshotId, purpose: 'private' })).json();
    expect(e).toMatchObject({ status: 'clean', purpose: 'private' });
    expect(e.report.excluded).toEqual([]);
    const z = openZip((await download(w.paperId, e.id)).rawPayload);
    for (const h of [sha(w.nc.bytes), sha(w.by.bytes), w.pngSha]) expect(z.names).toContain(`assets/${h}`);
    const list = (await call('GET', `/api/papers/${w.paperId}/exports`)).json();
    expect(list.map((x: { id: string }) => x.id)).toContain(e.id);
  });

  test('a blob missing from the store: the archive is incomplete, names it, and does not verify', async () => {
    const w = await paper();
    fs.unlinkSync(blobPath(dir, sha(w.by.bytes)));
    const r = await call('POST', `/api/papers/${w.paperId}/exports`, { format: 'source_archive', snapshot_id: w.snapshotId, purpose: 'share' });
    expect(r.statusCode, r.body).toBe(201);
    const e = r.json();
    expect(e.status).toBe('incomplete');
    expect(e.report.missing).toEqual([expect.objectContaining({ sha256: sha(w.by.bytes), reason: 'missing_in_store' })]);
    expect(e.report.verification.ok).toBe(false);
    const f = await download(w.paperId, e.id);
    expect(String(f.headers['content-disposition'])).toContain('-incomplete');
    expect(verifyArchive(f.rawPayload)).toMatchObject({ ok: false, status: 'incomplete' });
  });

  test('a damaged blob is reported as damaged, and an archive whose own bytes are gone from the store is not served', async () => {
    const w = await paper();
    const p = blobPath(dir, sha(w.by.bytes));
    fs.chmodSync(p, 0o600);
    fs.writeFileSync(p, 'damaged');
    const e = (await call('POST', `/api/papers/${w.paperId}/exports`, { format: 'source_archive', snapshot_id: w.snapshotId, purpose: 'share' })).json();
    expect(e.report.missing).toEqual([expect.objectContaining({ reason: 'damaged_in_store' })]);
    fs.unlinkSync(blobPath(dir, e.sha256));
    const f = await download(w.paperId, e.id);
    expect(f.statusCode).toBe(410);
    expect(f.json()).toMatchObject({ error: 'file_missing', sha256: e.sha256 });
  });

  test('the captions are those of the snapshot, not later ones', async () => {
    const w = await paper();
    const fig = (await pool.query('SELECT figure_id FROM snapshot_figures WHERE snapshot_id = $1', [w.snapshotId])).rows[0].figure_id;
    const v = await call('POST', `/api/papers/${w.paperId}/figures/${fig}/versions`, { caption: 'A caption written after the snapshot.', panels: [] });
    expect(v.statusCode, v.body).toBe(201);
    const e = (await call('POST', `/api/papers/${w.paperId}/exports`, { format: 'source_archive', snapshot_id: w.snapshotId, purpose: 'share' })).json();
    const z = openZip((await download(w.paperId, e.id)).rawPayload);
    expect(JSON.parse(z.read('figures.json')!.toString())).toEqual([expect.objectContaining({ caption: 'ABC1 induction in roots (n = 3).' })]);
  });

  test('an archive its own verifier does not accept is never stored as passed', async () => {
    const w = await paper();
    const owner = (await pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [w.paperId])).rows[0].owner_id;
    const e = await createArchiveExport(pool, { paperId: w.paperId, ownerId: owner, snapshotId: w.snapshotId, purpose: 'share', assetDir: dir },
      (b) => ({ ...verifyArchive(b), ok: false, problems: ['synthetic verifier failure'] }));
    expect(e.status).toBe('draft_with_errors');
    expect((e.report as { verification: { ok: boolean; problems: string[] } }).verification).toMatchObject({ ok: false, problems: ['synthetic verifier failure'] });
  });

  test('refused: a bad purpose, an unknown snapshot, another owner\'s paper; rows stay unchangeable', async () => {
    const w = await paper();
    expect((await call('POST', `/api/papers/${w.paperId}/exports`, { format: 'source_archive', snapshot_id: w.snapshotId, purpose: 'public' })).statusCode).toBe(422);
    expect((await call('POST', `/api/papers/${w.paperId}/exports`, { format: 'source_archive', snapshot_id: randomUUID(), purpose: 'share' })).statusCode).toBe(404);
    expect((await call('POST', `/api/papers/${w.paperId}/exports`, { format: 'source_archive', purpose: 'share' })).statusCode).toBe(404);
    expect((await call('POST', `/api/papers/${w.paperId}/exports`, { format: 'source_archive', snapshot_id: w.snapshotId, purpose: 'share' }, 'bob')).statusCode).toBe(404);
    const other = await paper();
    expect((await call('POST', `/api/papers/${w.paperId}/exports`, { format: 'source_archive', snapshot_id: other.snapshotId, purpose: 'share' })).statusCode).toBe(404);
    const e = (await call('POST', `/api/papers/${w.paperId}/exports`, { format: 'source_archive', snapshot_id: w.snapshotId, purpose: 'share' })).json();
    await expect(pool.query("UPDATE exports SET status = 'clean' WHERE id = $1", [e.id])).rejects.toThrow();
    // the row's shape: an archive without its snapshot, or a DOCX kept in the store, is refused by the database
    const owner = (await pool.query('SELECT created_by FROM exports WHERE id = $1', [e.id])).rows[0].created_by;
    await expect(pool.query(
      `INSERT INTO exports (paper_id, format, status, style, style_version, renderer_version, report_json, file_bytes, in_asset_store, sha256, byte_size, created_by, purpose)
       VALUES ($1, 'source_archive', 'clean', 'numeric', 'v', 'r', '{}', NULL, true, $2, 0, $3, 'share')`, [w.paperId, 'a'.repeat(64), owner])).rejects.toThrow(/exports_archive_shape/);
    await expect(pool.query(
      `INSERT INTO exports (paper_id, document_id, revision_id, format, status, style, style_version, renderer_version, report_json, file_bytes, in_asset_store, sha256, byte_size, created_by)
       VALUES ($1, $2, $3, 'docx', 'incomplete', 'numeric', 'v', 'r', '{}', '\\x00', false, $4, 1, $5)`, [w.paperId, w.documentId, w.head, 'a'.repeat(64), owner])).rejects.toThrow(/exports_archive_shape/);
  });
});

describe('the AI-assistance audit in the archive', () => {
  test('lists the AI proposals applied by the snapshot, and none applied after it or never applied', async () => {
    const P = randomUUID();
    const p = (await call('POST', '/api/papers', { working_title: 'audit paper', article_type: 'research_article' })).json();
    const d = (await call('POST', `/api/papers/${p.id}/documents`, { kind: 'manuscript' })).json();
    let head = (await call('POST', `/api/papers/${p.id}/documents/${d.document.id}/saves`, { schema_version: 1, reason: 'manual', expected_head_revision_id: d.head.id,
      content_json: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P }, content: [t('It was very very clear. Roots respond fast.')] }] } })).json().id as string;
    const propose = async (quote: string, text: string) => {
      const doc = parseDocument((await pool.query('SELECT content_json FROM document_revisions WHERE id = $1', [head])).rows[0].content_json, 1);
      let from = -1;
      doc.forEach((n) => { if (n.attrs.id === P) from = n.textBetween(0, n.content.size, '\n', '\ufffc').indexOf(quote); });
      const selection = await snapshotSelection(doc, { blockId: P, from, to: from + quote.length });
      const h = (await call('POST', `/api/papers/${p.id}/documents/${d.document.id}/selection-handles`, { base_revision_id: head, selection })).json();
      return createProposal(pool, { paperId: p.id, handleId: h.id, intent: 'concise', replacement: [t(text)], explanation: 'shorter', origin: 'worker:test' });
    };
    const applyIt = async (x: { id: string; proposal_hash: string; base_revision_id: string }) => {
      const r = await call('POST', `/api/papers/${p.id}/proposals/${x.id}/apply`, { proposal_hash: x.proposal_hash, expected_revision_id: x.base_revision_id, idempotency_key: randomUUID().replaceAll('-', '') });
      expect(r.statusCode, r.body).toBe(201);
      head = r.json().revision.id;
    };
    const before = await propose('very very clear', 'clear');
    await applyIt(before);
    const pending = await propose('Roots respond', 'Roots react');
    const snap = (await call('POST', `/api/papers/${p.id}/snapshots`, { label: 'v1' })).json();
    const after = await propose('fast', 'quickly');
    await applyIt(after);
    const e = (await call('POST', `/api/papers/${p.id}/exports`, { format: 'source_archive', snapshot_id: snap.id, purpose: 'share' })).json();
    const z = openZip((await download(p.id, e.id)).rawPayload);
    const audit = JSON.parse(z.read('ai-assistance.json')!.toString());
    expect(audit).toEqual([expect.objectContaining({ kind: 'selection_edit', proposal_id: before.id, base_revision_id: before.base_revision_id, generator: 'worker:test', mode: 'concise' })]);
    expect(JSON.stringify(audit)).not.toContain(pending.id);
    expect(JSON.stringify(audit)).not.toContain(after.id);
    expect(JSON.parse(z.read('profile.json')!.toString())).toBeNull();
    expect(verifyArchive((await download(p.id, e.id)).rawPayload)).toMatchObject({ ok: true });
  });
});

const soffice = await findSoffice();
describe('the reading PDF through the API', () => {
  test('made from the head\'s DOCX by the local LibreOffice, stored with the converter version and text check', async () => {
    expect(soffice, 'LibreOffice (soffice) is needed for the PDF tests: install it or set PW_SOFFICE').toBeTruthy();
    const w = await paper();
    const r = await call('POST', `/api/papers/${w.paperId}/exports`, { format: 'pdf', document_id: w.documentId });
    expect(r.statusCode, r.body).toBe(201);
    const e = r.json();
    expect(e).toMatchObject({ format: 'pdf', revision_id: w.head, status: 'clean', renderer_version: expect.stringMatching(/^pw-docx-export-1\+libreoffice-\d/) });
    expect(e.report.pdf).toMatchObject({ converter: { name: 'libreoffice' }, text_check: { status: 'passed' } });
    const f = await download(w.paperId, e.id);
    expect(f.headers['content-type']).toBe('application/pdf');
    expect(f.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(sha(f.rawPayload)).toBe(e.sha256);
  }, 180_000);

  test('no LibreOffice: a plain 409 naming it, and nothing stored', async () => {
    const w = await paper();
    const before = (await call('GET', `/api/papers/${w.paperId}/exports`)).json().length;
    const old = process.env.PW_SOFFICE;
    process.env.PW_SOFFICE = '/nonexistent/soffice';
    try {
      const r = await call('POST', `/api/papers/${w.paperId}/exports`, { format: 'pdf', document_id: w.documentId });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ reason: 'PDF_CONVERTER_UNAVAILABLE', message: expect.stringContaining('LibreOffice') });
    } finally {
      if (old === undefined) delete process.env.PW_SOFFICE; else process.env.PW_SOFFICE = old;
    }
    expect((await call('GET', `/api/papers/${w.paperId}/exports`)).json()).toHaveLength(before);
    expect((await call('POST', `/api/papers/${w.paperId}/exports`, { format: 'pdf', document_id: randomUUID() })).statusCode).toBe(404);
  });
});
