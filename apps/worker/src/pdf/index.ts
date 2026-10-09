// parse_source jobs (PW-035): extract the text of a stored PDF original once per extractor version.
// The bytes are read from the content-addressed store and verified; the result (ok / no_text /
// failed) is stored with the job's fenced completion, all pages or none.
import type { TxPool } from '@pw/domain/shared/db.ts';
import { UUID_RE } from '@pw/domain/shared/db.ts';
import { IntegrityError, readVerified } from '@pw/domain/asset-policy/store.ts';
import { JobOutcomeError, type JobHandler } from '../queue/index.ts';
import { EXTRACTOR, extractPdf, type ExtractLimits } from './extract.ts';

export { EXTRACTOR } from './extract.ts';

export function pdfHandlers(pool: TxPool, opts: { assetDir: string; limits?: ExtractLimits }): Record<'parse_source', JobHandler> {
  const parse: JobHandler = async (job) => {
    const p = job.payload as { kind?: unknown; asset_id?: unknown };
    if (p.kind !== 'parse_pdf' || typeof p.asset_id !== 'string' || !UUID_RE.test(p.asset_id) || Object.keys(p).some((k) => !['kind', 'asset_id'].includes(k))) {
      throw new JobOutcomeError('parse_source payload must be { kind: "parse_pdf", asset_id }', 'FAILED');
    }
    const asset = (await pool.query<{ id: string; sha256: string; keep_right: string }>(
      `SELECT a.id, a.sha256, (SELECT q.keep_right FROM asset_policy_revisions q WHERE q.asset_revision_id = a.id ORDER BY q.created_at DESC, q.id DESC LIMIT 1) AS keep_right
       FROM asset_revisions a JOIN asset_sources s ON s.asset_revision_id = a.id WHERE a.paper_id = $1 AND a.id = $2 AND s.kind = 'source_pdf'`, [job.paper_id, p.asset_id])).rows[0];
    if (!asset) throw new JobOutcomeError('the source document is not in this paper', 'FAILED');
    // checked again when the job runs: the owner may have withdrawn the basis for keeping it
    if (asset.keep_right === 'unknown') throw new JobOutcomeError('the basis for keeping this original is unknown; it is not parsed', 'FAILED');
    const existing = (await pool.query<{ id: string; status: string }>('SELECT id, status FROM pdf_extractions WHERE asset_revision_id = $1 AND extractor = $2', [asset.id, EXTRACTOR])).rows[0];
    if (existing) return { result: { kind: 'pdf_extraction', extraction_id: existing.id, status: existing.status, already: true } };
    let bytes: Buffer;
    try {
      bytes = await readVerified(opts.assetDir, asset.sha256);
    } catch (e) {
      if (e instanceof IntegrityError) throw new JobOutcomeError(`the stored original failed its integrity check: ${e.message}`, 'FAILED');
      throw e;
    }
    const x = await extractPdf(bytes, opts.limits);
    // a failure that may depend on the moment is not recorded as the file's result: it can be asked again
    if (x.status === 'failed' && x.transient) throw new JobOutcomeError(`extraction did not finish: ${x.reason}`, 'FAILED');
    const result: Record<string, unknown> = { kind: 'pdf_extraction', status: x.status, pages: x.status === 'failed' ? 0 : x.pages.length };
    return {
      result,
      apply: async (tx) => {
        const id = (await tx.query<{ id: string }>(
          `INSERT INTO pdf_extractions (paper_id, asset_revision_id, sha256, extractor, status, failure_reason, page_count, job_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (asset_revision_id, extractor) DO NOTHING RETURNING id`,
          [job.paper_id, asset.id, asset.sha256, EXTRACTOR, x.status, x.status === 'failed' ? x.reason.slice(0, 500) : null, x.status === 'failed' ? null : x.pages.length, job.id])).rows[0]?.id;
        if (!id) { result.already = true; return; }
        result.extraction_id = id;
        if (x.status === 'failed') return;
        for (const [i, pg] of x.pages.entries()) {
          await tx.query('INSERT INTO pdf_pages (extraction_id, page_index, view_box, rotate, text, runs, flags) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [id, i, pg.view_box, pg.rotate, pg.text, JSON.stringify(pg.runs), pg.flags]);
        }
      },
    };
  };
  return { parse_source: parse };
}
