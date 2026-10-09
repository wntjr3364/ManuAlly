// Text extracted from source PDFs and confirmed evidence locations (PW-035, spec 05 "PDF 파이프라인",
// "PDF anchor").
// - An extraction is asked for as a job (parse_source); only originals whose keep right is known are
//   parsed.
// - An anchor is created only for a quote the owner selected and that occurs exactly once (with its
//   prefix/suffix) on that page of that extraction. No text, a failed extraction, an ambiguous or
//   missing quote: refused, never guessed.
// - An anchor records asset revision, sha256, 0-based page, normalized quadpoints, exact quote,
//   prefix/suffix and extractor version. It is never moved to another PDF revision: for a new revision
//   only unconfirmed candidates are listed.
import { DomainError, UUID_RE, type Queryable, type TxPool } from '../shared/db.ts';
import { enqueueJob } from '../jobs/index.ts';
import { getSourceAsset } from '../asset-policy/index.ts';

export const CURRENT_EXTRACTOR = 'pdfjs-dist@6.4.299/pw-pdf-1';

interface Run { o: number; n: number; t: number[]; w: number; h: number }
export interface PageView { page_index: number; view_box: number[]; rotate: number; text: string; flags: string[] }
export interface ExtractionView { id: string; status: 'ok' | 'no_text' | 'failed'; failure_reason: string | null; page_count: number | null; extractor: string; created_at: string }

export async function requestExtraction(pool: TxPool, a: { paperId: string; ownerId: string; assetId: string; idempotencyKey: unknown }) {
  const asset = await getSourceAsset(pool, a.paperId, a.assetId);
  if (!asset) throw new DomainError('NOT_FOUND', 'asset not found');
  if (asset.policy.keep_right === 'unknown') throw new DomainError('FORBIDDEN', 'state on what basis this original is kept (keep_right) before it is parsed', 'keep_right', { details: { reason: 'keep_right_unknown' } });
  return enqueueJob(pool, { paperId: a.paperId, ownerId: a.ownerId, intent: 'parse_source', idempotencyKey: a.idempotencyKey, payload: { kind: 'parse_pdf', asset_id: asset.id } });
}

// The extracted text is a copy of the original: shown only while the basis for keeping it is known.
const keepKnown = async (db: Queryable, paperId: string, assetId: string) => {
  const asset = await getSourceAsset(db, paperId, assetId);
  if (!asset) throw new DomainError('NOT_FOUND', 'asset not found');
  if (asset.policy.keep_right === 'unknown') throw new DomainError('FORBIDDEN', 'state on what basis this original is kept (keep_right) before its text is used', 'keep_right', { details: { reason: 'keep_right_unknown' } });
  return asset;
};

export async function extractionView(db: Queryable, paperId: string, assetId: string): Promise<{ extraction: ExtractionView | null; pages: PageView[] }> {
  if (!UUID_RE.test(assetId)) throw new DomainError('NOT_FOUND', 'asset not found');
  await keepKnown(db, paperId, assetId);
  const x = (await db.query<ExtractionView>(
    'SELECT id, status, failure_reason, page_count, extractor, created_at FROM pdf_extractions WHERE paper_id = $1 AND asset_revision_id = $2 AND extractor = $3', [paperId, assetId, CURRENT_EXTRACTOR])).rows[0];
  if (!x) return { extraction: null, pages: [] };
  const pages = (await db.query<PageView>('SELECT page_index, view_box, rotate, text, flags FROM pdf_pages WHERE extraction_id = $1 ORDER BY page_index', [x.id])).rows;
  return { extraction: x, pages };
}

// Relative character widths (Helvetica AFM, per mille) for placing a quote inside a text run: the run's
// measured width is shared out by these weights. An approximation (the real font may differ), better
// than equal widths; CJK and other wide scripts count as full width.
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
export function charWeight(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (c >= 32 && c <= 126) return HELVETICA[c - 32]!;
  return c >= 0x1100 ? 1000 : 556;
}

// Normalized quadpoints (PDF QuadPoints order: upper-left, upper-right, lower-left, lower-right; in
// unrotated page space, 0..1 from the view box's lower-left corner) for text offsets [start, end),
// interpolated within each text run by character weights.
export function quadsFor(runs: Run[], text: string, viewBox: number[], start: number, end: number): number[][] {
  const [x0, y0, x1, y1] = viewBox as [number, number, number, number];
  const W = x1 - x0 || 1;
  const H = y1 - y0 || 1;
  const quads: number[][] = [];
  for (const r of runs) {
    const a = Math.max(start, r.o);
    const b = Math.min(end, r.o + r.n);
    if (a >= b) continue;
    const [ta, tb, tc, td, te, tf] = r.t as [number, number, number, number, number, number];
    const dl = Math.hypot(ta, tb) || 1;
    const ul = Math.hypot(tc, td) || 1;
    const dir = [ta / dl, tb / dl];
    const up = [tc / ul, td / ul];
    const chars = [...text.slice(r.o, r.o + r.n)];
    const weights = chars.length === r.n ? chars.map(charWeight) : new Array<number>(r.n).fill(1);
    const total = weights.reduce((x, y) => x + y, 0) || 1;
    const upTo = (k: number) => weights.slice(0, k).reduce((x, y) => x + y, 0);
    const from = (r.w * upTo(a - r.o)) / total;
    const to = (r.w * upTo(b - r.o)) / total;
    const p = (s: number, h: number) => [(te + dir[0]! * s + up[0]! * h - x0) / W, (tf + dir[1]! * s + up[1]! * h - y0) / H];
    const round = (v: number) => Math.round(v * 1e5) / 1e5;
    quads.push([...p(from, r.h), ...p(to, r.h), ...p(from, 0), ...p(to, 0)].map(round));
  }
  return quads;
}

const CONTEXT = 32;
export async function createAnchor(pool: TxPool, a: { paperId: string; ownerId: string; assetId: string; body: unknown }) {
  const b = (a.body ?? {}) as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !['page_index', 'exact', 'prefix', 'suffix'].includes(k));
  if (extra.length) throw new DomainError('INVALID', `unknown fields: ${extra.join(', ').slice(0, 100)}`, extra[0]);
  if (!Number.isInteger(b.page_index) || (b.page_index as number) < 0) throw new DomainError('INVALID', 'page_index must be a 0-based page number', 'page_index');
  if (typeof b.exact !== 'string' || !b.exact.trim() || b.exact.length > 2000) throw new DomainError('INVALID', 'exact must be the selected text (1–2000 characters)', 'exact');
  const prefix = typeof b.prefix === 'string' ? b.prefix.slice(-CONTEXT * 4) : '';
  const suffix = typeof b.suffix === 'string' ? b.suffix.slice(0, CONTEXT * 4) : '';
  if (!UUID_RE.test(a.assetId)) throw new DomainError('NOT_FOUND', 'asset not found');
  const asset = await keepKnown(pool, a.paperId, a.assetId);
  const x = (await pool.query<{ id: string; status: string; extractor: string; sha256: string }>(
    'SELECT id, status, extractor, sha256 FROM pdf_extractions WHERE paper_id = $1 AND asset_revision_id = $2 AND extractor = $3', [a.paperId, asset.id, CURRENT_EXTRACTOR])).rows[0];
  if (!x) throw new DomainError('CONFLICT', 'the text of this PDF has not been extracted yet', undefined, { details: { reason: 'not_extracted' } });
  if (x.status !== 'ok') throw new DomainError('CONFLICT', `this PDF has no usable text (${x.status}); a location cannot be confirmed from it`, undefined, { details: { reason: x.status } });
  if (x.sha256 !== asset.sha256) throw new DomainError('CONFLICT', 'the extraction does not belong to these bytes', undefined, { details: { reason: 'hash_mismatch' } });
  const page = (await pool.query<{ text: string; runs: Run[]; view_box: number[]; flags: string[] }>('SELECT text, runs, view_box, flags FROM pdf_pages WHERE extraction_id = $1 AND page_index = $2', [x.id, b.page_index])).rows[0];
  if (!page) throw new DomainError('NOT_FOUND', 'page not found', 'page_index');
  if (page.flags.includes('no_text')) throw new DomainError('CONFLICT', 'this page has no extracted text (an image?); a location cannot be confirmed on it', undefined, { details: { reason: 'no_text' } });
  // every occurrence of the quote whose surroundings agree with the given prefix/suffix
  const hits: number[] = [];
  for (let i = page.text.indexOf(b.exact); i >= 0; i = page.text.indexOf(b.exact, i + 1)) {
    if (prefix && !page.text.slice(0, i).endsWith(prefix)) continue;
    if (suffix && !page.text.slice(i + b.exact.length).startsWith(suffix)) continue;
    hits.push(i);
  }
  if (!hits.length) throw new DomainError('NOT_FOUND', 'the quote is not on this page of the extracted text', 'exact', { details: { reason: 'quote_not_found' } });
  if (hits.length > 1) throw new DomainError('CONFLICT', `the quote occurs ${hits.length} times on this page; select more text`, 'exact', { details: { reason: 'ambiguous', count: hits.length } });
  const start = hits[0]!;
  const end = start + b.exact.length;
  const quads = quadsFor(page.runs, page.text, page.view_box, start, end);
  if (!quads.length) throw new DomainError('CONFLICT', 'the quote has no position on the page (layout text only)', 'exact', { details: { reason: 'no_position' } });
  const row = (await pool.query<{ id: string }>(
    `INSERT INTO pdf_anchors (paper_id, asset_revision_id, sha256, extraction_id, extractor, page_index, start_offset, end_offset, exact, prefix, suffix, quadpoints, precision, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'run_interpolated', $13) RETURNING id`,
    [a.paperId, asset.id, asset.sha256, x.id, x.extractor, b.page_index, start, end, b.exact, page.text.slice(Math.max(0, start - CONTEXT), start), page.text.slice(end, end + CONTEXT), JSON.stringify(quads), a.ownerId])).rows[0]!;
  return (await resolveAnchor(pool, a.paperId, row.id))!;
}

export interface AnchorView {
  id: string; asset_revision_id: string; sha256: string; page_index: number; quadpoints: number[][]; exact: string; prefix: string; suffix: string; extractor: string;
  precision: string; created_at: string; page: { view_box: number[]; rotate: number; flags: string[] }; status: 'ok' | 'stale';
}
const ANCHOR = `SELECT a.id, a.asset_revision_id, a.sha256, a.page_index, a.quadpoints, a.exact, a.prefix, a.suffix, a.extractor, a.precision, a.created_at, a.start_offset, a.end_offset,
  json_build_object('view_box', p.view_box, 'rotate', p.rotate, 'flags', p.flags) AS page, p.text AS page_text, r.sha256 AS asset_sha
  FROM pdf_anchors a JOIN pdf_pages p ON p.extraction_id = a.extraction_id AND p.page_index = a.page_index JOIN asset_revisions r ON r.id = a.asset_revision_id`;
type AnchorRow = AnchorView & { start_offset: number; end_offset: number; page_text: string; asset_sha: string };
const view = ({ start_offset, end_offset, page_text, asset_sha, ...r }: AnchorRow): AnchorView => ({
  ...r, status: asset_sha === r.sha256 && page_text.slice(start_offset, end_offset) === r.exact ? 'ok' : 'stale',
});

// Re-open a confirmed location: the same bytes (sha256) and the same text at the same place, or "stale".
export async function resolveAnchor(db: Queryable, paperId: string, anchorId: string): Promise<AnchorView | null> {
  if (!UUID_RE.test(anchorId)) return null;
  const r = (await db.query<AnchorRow>(`${ANCHOR} WHERE a.paper_id = $1 AND a.id = $2`, [paperId, anchorId])).rows[0];
  return r ? view(r) : null;
}
export async function listAnchors(db: Queryable, paperId: string, assetId: string): Promise<AnchorView[]> {
  if (!UUID_RE.test(assetId)) return [];
  return (await db.query<AnchorRow>(`${ANCHOR} WHERE a.paper_id = $1 AND a.asset_revision_id = $2 ORDER BY a.page_index, a.start_offset, a.id`, [paperId, assetId])).rows.map(view);
}

// Where the same quote appears in another PDF revision: candidates only, never confirmed or stored.
export async function candidatesInRevision(db: Queryable, paperId: string, anchorId: string, otherAssetId: string) {
  const anchor = await resolveAnchor(db, paperId, anchorId);
  if (!anchor) throw new DomainError('NOT_FOUND', 'anchor not found');
  const other = await extractionView(db, paperId, otherAssetId);
  if (!other.extraction) return { status: 'not_extracted' as const, confirmed: false, candidates: [] };
  if (other.extraction.status !== 'ok') return { status: other.extraction.status, confirmed: false, candidates: [] };
  const candidates: { page_index: number; start: number; context_matches: boolean }[] = [];
  for (const p of other.pages) {
    for (let i = p.text.indexOf(anchor.exact); i >= 0; i = p.text.indexOf(anchor.exact, i + 1)) {
      candidates.push({ page_index: p.page_index, start: i, context_matches: p.text.slice(0, i).endsWith(anchor.prefix) && p.text.slice(i + anchor.exact.length).startsWith(anchor.suffix) });
    }
  }
  return { status: 'ok' as const, confirmed: false, candidates: candidates.slice(0, 20) };
}
