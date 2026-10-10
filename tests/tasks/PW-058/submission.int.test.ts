// PW-058 — reviewer comments → edits → responses, and the submission freeze, through the API against a
// temporary database and asset store. All text is synthetic.
// TST-058A: a response that says "changed" is tied to a real revision and block locator; the frozen
//   submission never changes.
// TST-058B: an unchanged passage is never answered as changed, and a manuscript with a critical issue
//   (unresolved citation or figure reference — RFC-008 —, a failed scientific check, an open scientific
//   finding, an unanswered comment, a claimed change that is no longer there) is never marked
//   submission-ready.
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
import { verifyArchive } from '../../../packages/exports/src/archive/index.ts';
import { openZip } from '../../../packages/domain/src/imports/docx/zip.ts';

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw058-assets-'));
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

interface W { paperId: string; documentId: string; head: string; refId: string; figId: string; H1: string; P1: string; P2: string }
// a paper: a reference, a figure with a caption, and a manuscript (heading, a paragraph citing both, another)
async function paper(o: { year?: number | null } = {}): Promise<W> {
  const p = (await call('POST', '/api/papers', { working_title: 'submission paper', article_type: 'research_article' })).json();
  const ref = await call('POST', `/api/papers/${p.id}/references`, { title: 'Root signals under drought', authors: [{ family: 'Kim', given: 'Jiyoon' }], ...(o.year === null ? {} : { year: o.year ?? 2020 }), container: 'Journal of Plant Studies' });
  expect(ref.statusCode, ref.body).toBe(201);
  const fig = (await call('POST', `/api/papers/${p.id}/figures`, { kind: 'figure', title: 'Root induction' })).json();
  expect((await call('POST', `/api/papers/${p.id}/figures/${fig.id}/versions`, { caption: 'ABC1 induction in roots (n = 3).', panels: [] })).statusCode).toBe(201);
  const d = (await call('POST', `/api/papers/${p.id}/documents`, { kind: 'manuscript' })).json();
  const w = { paperId: p.id, documentId: d.document.id, head: d.head.id, refId: ref.json().id, figId: fig.id, H1: randomUUID(), P1: randomUUID(), P2: randomUUID() } as W;
  await save(w, body(w, 'Roots respond quickly'));
  return w;
}
const body = (w: W, p1: string, extra: unknown[] = [], p2 = 'A second paragraph stays as it is.') => ({ type: 'doc', content: [
  { type: 'heading', attrs: { id: w.H1, level: 1 }, content: [t('Results')] },
  { type: 'paragraph', attrs: { id: w.P1 }, content: [t(`${p1} `), { type: 'citation', attrs: { referenceId: w.refId, locator: null } }, t(' ('), { type: 'figure_ref', attrs: { targetId: w.figId } }, t(').')] },
  { type: 'paragraph', attrs: { id: w.P2 }, content: [t(p2)] },
  ...extra,
] });
async function save(w: W, content: unknown) {
  const r = await call('POST', `/api/papers/${w.paperId}/documents/${w.documentId}/saves`, { schema_version: 1, reason: 'manual', expected_head_revision_id: w.head, content_json: content });
  expect(r.statusCode, r.body).toBe(201);
  w.head = r.json().id;
  return w.head;
}
const comment = async (w: W, text = 'Please clarify how fast the roots respond.') => {
  const r = await call('POST', `/api/papers/${w.paperId}/review-comments`, { document_id: w.documentId, round: 'R1', reviewer: 'Reviewer 2', text });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string; base_revision_id: string; position: number };
};
const respond = (w: W, commentId: string, b: Record<string, unknown>) => call('POST', `/api/papers/${w.paperId}/review-comments/${commentId}/responses`, b);
const check = (w: W) => call('POST', `/api/papers/${w.paperId}/submissions/check`, { document_id: w.documentId });
const freeze = (w: W, o: Record<string, unknown> = {}) => call('POST', `/api/papers/${w.paperId}/submissions`, { intent: 'freeze_submission', document_id: w.documentId, expected_revision_id: w.head, status: 'submission_ready', label: 'Journal of Plant Studies, first submission', target: 'Journal of Plant Studies', ...o });
const kinds = (xs: { kind: string }[]) => xs.map((x) => x.kind);
// submission-ready with exactly the warnings the check showed confirmed
const freezeReady = async (w: W, o: Record<string, unknown> = {}) => freeze(w, { confirm_warnings: kinds((await check(w)).json().warnings), ...o });

describe('TST-058A: responses tied to real edits; the frozen submission never changes', () => {
  test('a comment records the revision it was made on; "addressed" needs a changed block in a later revision', async () => {
    const w = await paper();
    const c = await comment(w);
    expect(c).toMatchObject({ base_revision_id: w.head, position: 1 });
    // no link, or a link to the revision the comment was made on: refused
    expect((await respond(w, c.id, { status: 'addressed', text: 'We clarified the timing.', links: [] })).statusCode).toBe(422);
    const same = await respond(w, c.id, { status: 'addressed', text: 'We clarified the timing.', links: [{ revision_id: w.head, block_id: w.P1 }] });
    expect(same.statusCode).toBe(422);
    expect(same.json()).toMatchObject({ reason: 'LINK_NOT_AFTER_COMMENT' }); // the commented revision itself is not a later one
    // the edit, then the change list offers the changed block with its locator
    await save(w, body(w, 'Roots respond within two hours'));
    const changes = (await call('GET', `/api/papers/${w.paperId}/review-comments/${c.id}/changes`)).json();
    expect(changes).toEqual({ head_revision_id: w.head, blocks: [expect.objectContaining({ block_id: w.P1, change: 'changed', heading: 'Results', before: expect.stringContaining('Roots respond quickly'), after: expect.stringContaining('within two hours') })] });
    // an unchanged block is not a change
    const unchanged = await respond(w, c.id, { status: 'addressed', text: 'We clarified the timing.', links: [{ revision_id: w.head, block_id: w.P2 }] });
    expect(unchanged.statusCode).toBe(422);
    expect(unchanged.json()).toMatchObject({ reason: 'LINK_NOT_A_CHANGE' });
    const ok = await respond(w, c.id, { status: 'addressed', text: 'We now state that roots respond within two hours.', links: [{ revision_id: w.head, block_id: w.P1 }] });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ status: 'addressed', links: [{ revision_id: w.head, block_id: w.P1, change: 'changed', heading: 'Results' }] });
    const list = (await call('GET', `/api/papers/${w.paperId}/review-comments`)).json();
    expect(list).toEqual([expect.objectContaining({ id: c.id, reviewer: 'Reviewer 2', round: 'R1', response: expect.objectContaining({ status: 'addressed', holds_now: true }) })]);
  });

  test('links must be revisions of the same document made after the comment', async () => {
    const w = await paper();
    const before = w.head;
    await save(w, body(w, 'An early edit'));
    const c = await comment(w);
    // a revision older than the comment
    expect((await respond(w, c.id, { status: 'addressed', text: 'x', links: [{ revision_id: before, block_id: w.P1 }] })).json()).toMatchObject({ reason: 'LINK_NOT_AFTER_COMMENT' });
    // another paper's revision
    const other = await paper();
    expect((await respond(w, c.id, { status: 'addressed', text: 'x', links: [{ revision_id: other.head, block_id: other.P1 }] })).json()).toMatchObject({ reason: 'LINK_NOT_AFTER_COMMENT' });
    // a block that exists in neither
    await save(w, body(w, 'A later edit'));
    expect((await respond(w, c.id, { status: 'addressed', text: 'x', links: [{ revision_id: w.head, block_id: randomUUID() }] })).json()).toMatchObject({ reason: 'LINK_NOT_A_CHANGE' });
    // other answers carry no links; "disagree" with an explanation is recorded as such
    expect((await respond(w, c.id, { status: 'disagree', text: 'x', links: [{ revision_id: w.head, block_id: w.P1 }] })).statusCode).toBe(422);
    const d = await respond(w, c.id, { status: 'disagree', text: 'We respectfully keep the original wording because …', links: [] });
    expect(d.statusCode, d.body).toBe(201);
    expect((await respond(w, c.id, { status: 'done', text: 'x', links: [] })).statusCode).toBe(422);
  });

  test('freezing: snapshot, archive, DOCX hash and the response trace are stored once and never change', async () => {
    const w = await paper();
    const c = await comment(w);
    await save(w, body(w, 'Roots respond within two hours'));
    expect((await respond(w, c.id, { status: 'addressed', text: 'We now give the timing.', links: [{ revision_id: w.head, block_id: w.P1 }] })).statusCode).toBe(201);
    const frozenHead = w.head;
    const r = await freezeReady(w);
    expect(r.statusCode, r.body).toBe(201);
    const s = r.json();
    expect(s).toMatchObject({ status: 'submission_ready', revision_id: frozenHead, document_id: w.documentId, label: 'Journal of Plant Studies, first submission', target: 'Journal of Plant Studies', checks: { blocking: [] } });
    expect(s.responses).toEqual([expect.objectContaining({ comment_id: c.id, status: 'addressed', links: [expect.objectContaining({ block_id: w.P1, holds: true, heading: 'Results' })] })]);
    // the frozen archive: the same DOCX hash, verifiable on its own
    const file = await call('GET', `/api/papers/${w.paperId}/exports/${s.archive_export_id}/file`);
    expect(file.statusCode).toBe(200);
    expect(verifyArchive(file.rawPayload)).toMatchObject({ ok: true, reproduced: true });
    expect(sha(openZip(file.rawPayload).read('outputs/manuscript.docx')!)).toBe(s.docx_sha256);
    expect((await pool.query('SELECT revision_id FROM snapshot_document_revisions WHERE snapshot_id = $1 AND document_id = $2', [s.snapshot_id, w.documentId])).rows[0].revision_id).toBe(frozenHead);
    // later work does not reach it, and the row cannot be changed
    await save(w, body(w, 'Roots respond within two hours in the field'));
    expect((await call('GET', `/api/papers/${w.paperId}/submissions`)).json()).toEqual([expect.objectContaining({ id: s.id, revision_id: frozenHead, docx_sha256: s.docx_sha256, status: 'submission_ready' })]);
    await expect(pool.query("UPDATE submissions SET label = 'x' WHERE id = $1", [s.id])).rejects.toThrow();
    await expect(pool.query('DELETE FROM submissions WHERE id = $1', [s.id])).rejects.toThrow();
    // the response table of the submission (comment, answer, where)
    const table = await call('GET', `/api/papers/${w.paperId}/submissions/${s.id}/response-table`);
    expect(table.statusCode).toBe(200);
    expect(table.headers['content-type']).toContain('text/markdown');
    expect(table.body).toContain('Please clarify how fast the roots respond.');
    expect(table.body).toContain('We now give the timing.');
    expect(table.body).toContain('Results');
  });
});

describe('TST-058B: never "changed" for unchanged text; never submission-ready with a critical issue', () => {
  test('an unanswered comment blocks submission-ready; a draft freeze records it', async () => {
    const w = await paper();
    await comment(w);
    const before = (await pool.query('SELECT count(*)::int AS n FROM paper_snapshots WHERE paper_id = $1', [w.paperId])).rows[0].n;
    const r = await freeze(w);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ reason: 'NOT_SUBMISSION_READY' });
    expect(kinds(r.json().blocking)).toContain('comment_without_response');
    expect((await pool.query('SELECT count(*)::int AS n FROM paper_snapshots WHERE paper_id = $1', [w.paperId])).rows[0].n).toBe(before);
    const d = await freeze(w, { status: 'draft', label: 'internal draft' });
    expect(d.statusCode, d.body).toBe(201);
    expect(d.json()).toMatchObject({ status: 'draft' });
    expect(kinds(d.json().checks.blocking)).toContain('comment_without_response');
  });

  test('a claimed change that was undone afterwards is caught at freezing', async () => {
    const w = await paper();
    const c = await comment(w);
    await save(w, body(w, 'Roots respond within two hours'));
    expect((await respond(w, c.id, { status: 'addressed', text: 'Done.', links: [{ revision_id: w.head, block_id: w.P1 }] })).statusCode).toBe(201);
    await save(w, body(w, 'Roots respond quickly')); // back to the commented wording
    const k = (await check(w)).json();
    expect(kinds(k.blocking)).toContain('claimed_change_missing');
    expect((await call('GET', `/api/papers/${w.paperId}/review-comments`)).json()[0].response.holds_now).toBe(false);
    const r = await freeze(w);
    expect(r.statusCode).toBe(409);
    expect(kinds(r.json().blocking)).toContain('claimed_change_missing');
  });

  test('RFC-008: unresolved citations and figure references refuse submission-ready and are listed', async () => {
    const w = await paper();
    const ghostRef = randomUUID();
    const ghostFig = randomUUID();
    await save(w, body(w, 'Roots respond quickly', [{ type: 'paragraph', attrs: { id: randomUUID() }, content: [t('See '), { type: 'citation', attrs: { referenceId: ghostRef, locator: null } }, t(' and '), { type: 'figure_ref', attrs: { targetId: ghostFig } }, t('.')] }]));
    const r = await freeze(w);
    expect(r.statusCode).toBe(409);
    const b = r.json().blocking as { kind: string; examples: string[] }[];
    expect(b.find((x) => x.kind === 'unresolved_citation')!.examples).toContain(ghostRef);
    expect(b.find((x) => x.kind === 'unresolved_figure')!.examples).toContain(ghostFig);
  });

  test('a failed scientific check or an open scientific finding on an unchanged paragraph blocks; once the paragraph changes it is a warning', async () => {
    const w = await paper();
    const owner = (await pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [w.paperId])).rows[0].owner_id;
    await pool.query(`INSERT INTO scientific_check_runs (paper_id, document_id, revision_id, block_id, gate_version, status, findings, created_by) VALUES ($1, $2, $3, $4, 'synthetic-1', 'FAILED', '[{"kind":"number_mismatch"}]', $5)`, [w.paperId, w.documentId, w.head, w.P1, owner]);
    let k = (await check(w)).json();
    expect(kinds(k.blocking)).toContain('scientific_check_failed');
    expect((await freeze(w)).statusCode).toBe(409);
    await save(w, body(w, 'Roots respond within two hours'));
    k = (await check(w)).json();
    expect(kinds(k.blocking)).not.toContain('scientific_check_failed');
    expect(kinds(k.warnings)).toContain('scientific_check_stale');
    // an open scientific finding of a review run on the current wording
    const job = (await pool.query(`INSERT INTO jobs (paper_id, owner_id, intent, idempotency_key, payload, payload_hash) VALUES ($1, $2, 'review', $3, '{}', $4) RETURNING id`, [w.paperId, owner, randomUUID(), 'a'.repeat(64)])).rows[0].id;
    const run = (await pool.query(`INSERT INTO review_runs (paper_id, job_id, document_id, revision_id, block_id, block_hash, generator, independence, input_hash) VALUES ($1, $2, $3, $4, $5, $6, 'mock', 'different_model', $6) RETURNING id`, [w.paperId, job, w.documentId, w.head, w.P2, 'b'.repeat(64)])).rows[0].id;
    await pool.query(`INSERT INTO review_findings (paper_id, run_id, position, kind, category, quote, span_start, span_end, reason, confidence) VALUES ($1, $2, 1, 'scientific', 'overclaim', 'stays', 0, 5, 'synthetic', 'high')`, [w.paperId, run]);
    k = (await check(w)).json();
    expect(kinds(k.blocking)).toContain('open_scientific_finding');
  });

  test('warnings need the owner\'s confirmation of each kind shown; a stale expected revision, a missing intent or another owner are refused', async () => {
    const w = await paper({ year: null }); // a reference without a year: a warning, not a blocker
    const k = (await check(w)).json();
    expect(k.blocking).toEqual([]);
    expect(kinds(k.warnings)).toEqual(expect.arrayContaining(['incomplete_reference', 'scientific_check_not_run', 'consistency_not_checked']));
    const r = await freeze(w);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ reason: 'CONFIRM_WARNINGS', warnings: expect.arrayContaining([expect.objectContaining({ kind: 'incomplete_reference' })]) });
    // review m3: confirming some kinds is not confirming all; a blanket "yes" is not accepted
    const part = await freeze(w, { confirm_warnings: ['incomplete_reference'] });
    expect(part.statusCode).toBe(409);
    expect(part.json().unconfirmed).toEqual(expect.arrayContaining(['scientific_check_not_run', 'consistency_not_checked']));
    expect((await freeze(w, { confirm_warnings: true })).statusCode).toBe(422);
    const all = kinds(k.warnings);
    expect((await freeze(w, { expected_revision_id: randomUUID(), confirm_warnings: all })).json()).toMatchObject({ reason: 'STALE' });
    expect((await freeze(w, { intent: undefined, confirm_warnings: all })).statusCode).toBe(422);
    expect((await freeze(w, { status: 'final', confirm_warnings: all })).statusCode).toBe(422);
    // review n1: names are single lines
    expect((await freeze(w, { label: 'R2\n\n| fake | row |', confirm_warnings: all })).statusCode).toBe(422);
    expect((await call('POST', `/api/papers/${w.paperId}/submissions`, { intent: 'freeze_submission', document_id: w.documentId, expected_revision_id: w.head, status: 'submission_ready', label: 'x', confirm_warnings: all }, 'bob')).statusCode).toBe(404);
    const ok = await freeze(w, { confirm_warnings: all });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ status: 'submission_ready', checks: { blocking: [], warnings: expect.arrayContaining([expect.objectContaining({ kind: 'incomplete_reference' })]) }, confirmed_by: expect.any(String) });
  });

  test('review m1: a paragraph never checked, or checked on other wording, is not a pass', async () => {
    const w = await paper();
    const owner = (await pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [w.paperId])).rows[0].owner_id;
    const notRun = async () => ((await check(w)).json().warnings as { kind: string; count: number }[]).find((x) => x.kind === 'scientific_check_not_run')?.count ?? 0;
    expect(await notRun()).toBe(2); // both paragraphs
    await pool.query(`INSERT INTO scientific_check_runs (paper_id, document_id, revision_id, block_id, gate_version, status, findings, created_by) VALUES ($1, $2, $3, $4, 'synthetic-1', 'VERIFIED', '[]', $5)`, [w.paperId, w.documentId, w.head, w.P1, owner]);
    expect(await notRun()).toBe(1);
    await save(w, body(w, 'Roots respond within two hours'));
    expect(await notRun()).toBe(2); // checked on other wording
    // an undecided check on other wording is not a pass either
    await pool.query(`INSERT INTO scientific_check_runs (paper_id, document_id, revision_id, block_id, gate_version, status, findings, created_by) VALUES ($1, $2, $3, $4, 'synthetic-1', 'UNKNOWN', '[]', $5)`, [w.paperId, w.documentId, w.head, w.P2, owner]);
    expect(kinds((await check(w)).json().warnings)).toContain('scientific_check_unknown');
    await save(w, body(w, 'Roots respond within two hours', [], 'The second paragraph changed.'));
    expect(await notRun()).toBe(2);
  });

  test('review m2: text left to fill in blocks; "XX" asks; the unchecked whole-document consistency is always said', async () => {
    const w = await paper();
    await save(w, body(w, 'Roots respond in TODO hours', [], 'XX patients were enrolled [needs_input].'));
    const k = (await check(w)).json();
    const p = (k.blocking as { kind: string; examples: string[] }[]).find((x) => x.kind === 'placeholder_text')!;
    expect(p.examples).toEqual(expect.arrayContaining(['TODO', '[needs_input]']));
    expect(kinds(k.warnings)).toEqual(expect.arrayContaining(['placeholder_like_xx', 'consistency_not_checked']));
    expect((await freezeReady(w)).statusCode).toBe(409);
  });

  test('the database refuses a submission-ready row with a blocker', async () => {
    const w = await paper();
    const d = (await freeze(w, { status: 'draft', label: 'd' })).json();
    const row = (await pool.query('SELECT * FROM submissions WHERE id = $1', [d.id])).rows[0];
    await expect(pool.query(
      `INSERT INTO submissions (paper_id, label, status, snapshot_id, archive_export_id, document_id, revision_id, docx_sha256, checks, responses, versions, confirmed_by)
       VALUES ($1, 'x', 'submission_ready', $2, $3, $4, $5, $6, '{"blocking":[{"kind":"unresolved_citation"}],"warnings":[]}', '[]', '{}', $7)`,
      [w.paperId, row.snapshot_id, row.archive_export_id, row.document_id, row.revision_id, row.docx_sha256, row.confirmed_by])).rejects.toThrow(/submissions_ready_clean/);
  });
});
