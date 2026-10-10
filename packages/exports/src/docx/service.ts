// Exports as records (PW-056): made from the current head revision of a manuscript, from the stored
// references (and their CSL-JSON), the figures in the owner's order with their latest captions, and the
// paper's citation style; stored with the revision, the check report, the renderer and style versions and the
// file's SHA-256, then never changed. Downloads return the stored bytes.
import { createHash } from 'node:crypto';
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '@pw/domain/shared/db.ts';
import { getCitationStyle, listFigures, listReferences } from '@pw/domain/references/index.ts';
import { cslJson, renderDocx, RENDERER_VERSION, type ExportReport, type ExportStatus } from './index.ts';

export const EXPORT_FORMATS = ['docx', 'csl_json'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export interface ExportRecord {
  id: string; document_id: string; revision_id: string; format: ExportFormat; status: ExportStatus; style: string; style_version: string;
  renderer_version: string; report: ExportReport | Record<string, unknown>; sha256: string; byte_size: number; created_at: string;
}
const COLS = 'id, document_id, revision_id, format, status, style, style_version, renderer_version, report_json AS report, sha256, byte_size, created_at';

export async function createExport(pool: TxPool, a: { paperId: string; ownerId: string; documentId: unknown; format: unknown }): Promise<ExportRecord> {
  if (!EXPORT_FORMATS.includes(a.format as ExportFormat)) throw new DomainError('INVALID', `format must be one of ${EXPORT_FORMATS.join(', ')}`, 'format');
  if (typeof a.documentId !== 'string' || !UUID_RE.test(a.documentId)) throw new DomainError('NOT_FOUND', 'document not found');
  const documentId = a.documentId;
  const id = await inTransaction(pool, async (tx) => {
    await tx.query("SELECT set_config('pw.actor', $1, true)", [`owner:${a.ownerId}`]);
    // the head as of now, read under a share lock so the export names exactly what it was made from
    const head = (await tx.query<{ revision_id: string; content_json: unknown }>(
      `SELECT r.id AS revision_id, r.content_json FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id
       WHERE d.paper_id = $1 AND d.id = $2 AND d.kind = 'manuscript' FOR SHARE OF d`, [a.paperId, documentId])).rows[0];
    if (!head) throw new DomainError('NOT_FOUND', 'document not found');
    const style = await getCitationStyle(tx, a.paperId);
    const refs = await listReferences(tx, a.paperId);
    let bytes: Buffer;
    let status: ExportStatus;
    let report: Record<string, unknown>;
    let styleVersion: string;
    if (a.format === 'docx') {
      const figures = await listFigures(tx, a.paperId);
      const captions = new Map((await tx.query<{ figure_id: string; caption: string }>(
        'SELECT DISTINCT ON (figure_id) figure_id, caption FROM figure_versions WHERE paper_id = $1 ORDER BY figure_id, version_no DESC', [a.paperId])).rows.map((r) => [r.figure_id, r.caption]));
      const out = renderDocx({ doc: head.content_json, refs, figures: figures.map((f) => ({ ...f, caption: captions.get(f.id)?.trim() || null })), style });
      bytes = out.bytes;
      status = out.report.status;
      report = out.report as unknown as Record<string, unknown>;
      styleVersion = out.report.style_version;
    } else {
      const stored = new Map((await tx.query<{ id: string; csl_json: Record<string, unknown> }>(
        `SELECT DISTINCT ON (pr.reference_id) pr.reference_id AS id, b.csl_json FROM project_references pr JOIN bibliographic_revisions b ON b.reference_id = pr.reference_id
         WHERE pr.paper_id = $1 AND pr.removed_at IS NULL ORDER BY pr.reference_id, b.created_at DESC, b.id DESC`, [a.paperId])).rows.map((r) => [r.id, r.csl_json]));
      const items = cslJson(head.content_json, refs, stored, style);
      bytes = Buffer.from(`${JSON.stringify(items, null, 2)}\n`, 'utf8');
      // the same check as the DOCX (a citation without a stored reference is missing from this file too)
      const docx = renderDocx({ doc: head.content_json, refs, figures: [], style });
      const issues = docx.report.issues.filter((i) => i.kind === 'unresolved_citation' || i.kind === 'citation_like_text' || i.kind === 'incomplete_reference');
      status = issues.some((i) => i.severity === 'error') ? 'draft_with_errors' : issues.length ? 'needs_attention' : 'clean';
      report = { status, issues, items: items.length, style, renderer_version: RENDERER_VERSION };
      styleVersion = docx.report.style_version;
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    return (await tx.query<{ id: string }>(
      `INSERT INTO exports (paper_id, document_id, revision_id, format, status, style, style_version, renderer_version, report_json, file_bytes, sha256, byte_size, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [a.paperId, documentId, head.revision_id, a.format, status, style, styleVersion, RENDERER_VERSION, JSON.stringify(report), bytes, sha, bytes.length, a.ownerId])).rows[0]!.id;
  });
  return (await getExport(pool, a.paperId, id))!;
}

export async function getExport(db: Queryable, paperId: string, exportId: string): Promise<ExportRecord | null> {
  if (!UUID_RE.test(exportId)) return null;
  return (await db.query<ExportRecord>(`SELECT ${COLS} FROM exports WHERE paper_id = $1 AND id = $2`, [paperId, exportId])).rows[0] ?? null;
}
export async function listExports(db: Queryable, paperId: string): Promise<ExportRecord[]> {
  return (await db.query<ExportRecord>(`SELECT ${COLS} FROM exports WHERE paper_id = $1 ORDER BY created_at DESC, id LIMIT 100`, [paperId])).rows;
}
export async function exportFile(db: Queryable, paperId: string, exportId: string): Promise<{ format: ExportFormat; bytes: Buffer; sha256: string; status: ExportStatus } | null> {
  if (!UUID_RE.test(exportId)) return null;
  const r = (await db.query<{ format: ExportFormat; bytes: Buffer; sha256: string; status: ExportStatus }>('SELECT format, file_bytes AS bytes, sha256, status FROM exports WHERE paper_id = $1 AND id = $2', [paperId, exportId])).rows[0];
  return r ?? null;
}
