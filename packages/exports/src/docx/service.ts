// Exports as records (PW-056): made from the current head revision of a manuscript (read once; revisions never
// change), from the stored
// references (and their CSL-JSON), the figures in the owner's order with their latest captions, and the
// paper's citation style; stored with the revision, the check report, the renderer and style versions and the
// file's SHA-256, then never changed. Downloads return the stored bytes.
import { createHash } from 'node:crypto';
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '@pw/domain/shared/db.ts';
import { getCitationStyle, listFigures, listReferences } from '@pw/domain/references/index.ts';
import { noticesOf } from '@pw/domain/literature/index.ts';
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
  // the head as of now; a revision never changes once written, so the export is made from it without holding
  // the document (saves do not wait for the export; review n1) and the record names exactly that revision
  const head = (await pool.query<{ revision_id: string; content_json: unknown }>(
    `SELECT r.id AS revision_id, r.content_json FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id
     WHERE d.paper_id = $1 AND d.id = $2 AND d.kind = 'manuscript'`, [a.paperId, documentId])).rows[0];
  if (!head) throw new DomainError('NOT_FOUND', 'document not found');
  const style = await getCitationStyle(pool, a.paperId);
  const refs = await listReferences(pool, a.paperId);
  // cited references the library knows to be retracted (PW-032 notices)
  const retracted = new Set<string>();
  for (const r of refs) if ((await noticesOf(pool, a.ownerId, r.id)).some((n) => n.kind === 'retracted')) retracted.add(r.id);
  let bytes: Buffer;
  let status: ExportStatus;
  let report: Record<string, unknown>;
  let styleVersion: string;
  if (a.format === 'docx') {
    const figures = await listFigures(pool, a.paperId);
    const captions = new Map((await pool.query<{ figure_id: string; caption: string }>(
      'SELECT DISTINCT ON (figure_id) figure_id, caption FROM figure_versions WHERE paper_id = $1 ORDER BY figure_id, version_no DESC', [a.paperId])).rows.map((r) => [r.figure_id, r.caption]));
    const out = renderDocx({ doc: head.content_json, refs, figures: figures.map((f) => ({ ...f, caption: captions.get(f.id)?.trim() || null })), style, retracted });
    bytes = out.bytes;
    status = out.report.status;
    report = out.report as unknown as Record<string, unknown>;
    styleVersion = out.report.style_version;
  } else {
    const stored = new Map((await pool.query<{ id: string; csl_json: Record<string, unknown> }>(
      `SELECT DISTINCT ON (pr.reference_id) pr.reference_id AS id, b.csl_json FROM project_references pr JOIN bibliographic_revisions b ON b.reference_id = pr.reference_id
       WHERE pr.paper_id = $1 AND pr.removed_at IS NULL ORDER BY pr.reference_id, b.created_at DESC, b.id DESC`, [a.paperId])).rows.map((r) => [r.id, r.csl_json]));
    const csl = cslJson(head.content_json, refs, stored, style);
    bytes = Buffer.from(`${JSON.stringify(csl.items, null, 2)}\n`, 'utf8');
    // the same check as the DOCX for the references (a citation without a stored reference is missing here too)
    const docx = renderDocx({ doc: head.content_json, refs, figures: [], style, retracted });
    const issues = docx.report.issues.filter((i) => ['unresolved_citation', 'citation_like_text', 'incomplete_reference', 'retracted_reference'].includes(i.kind));
    if (csl.missing.length) issues.push({ kind: 'missing_csl', severity: 'warning', count: csl.missing.length, examples: csl.missing.slice(0, 5), note: '저장된 CSL 기록이 없는 인용 문헌이 있어 CSL-JSON에서 빠졌습니다 — 문헌 정보를 다시 저장하세요' });
    status = issues.some((i) => i.severity === 'error') ? 'draft_with_errors' : issues.length ? 'needs_attention' : 'clean';
    report = { status, issues, items: csl.items.length, style, renderer_version: RENDERER_VERSION };
    styleVersion = docx.report.style_version;
  }
  const sha = createHash('sha256').update(bytes).digest('hex');
  const id = await inTransaction(pool, async (tx) => {
    await tx.query("SELECT set_config('pw.actor', $1, true)", [`owner:${a.ownerId}`]);
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
