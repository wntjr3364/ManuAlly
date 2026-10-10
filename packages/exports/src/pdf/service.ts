// The reading PDF as an export record (PW-057): the manuscript's head rendered to DOCX exactly as the DOCX
// export does (PW-056), converted by the local LibreOffice, checked for the manuscript's headings, and stored
// with the DOCX's check report, the converter's version and the file's SHA-256. A DOCX with errors carries its
// draft notice into the PDF (the notice is in the DOCX header). At most two conversions run at once.
import { createHash } from 'node:crypto';
import { DomainError, inTransaction, type TxPool } from '@pw/domain/shared/db.ts';
import { getExport, headDocx, manuscriptHead, type ExportRecord } from '../docx/service.ts';
import type { Issue } from '../docx/check.ts';
import { docxToPdf, PdfFailed, PdfUnavailable, textCheck } from './index.ts';

const MAX_CONVERSIONS = 2;
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONVERSIONS) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally {
    running--;
    waiting.shift()?.();
  }
}

type Heading = { type?: string; content?: { text?: string }[] };
const headingsOf = (doc: unknown) => (((doc as { content?: Heading[] })?.content ?? []).filter((b) => b.type === 'heading').map((b) => (b.content ?? []).map((i) => i.text ?? '').join('')).filter(Boolean));

export async function createPdfExport(pool: TxPool, a: { paperId: string; ownerId: string; documentId: unknown; env?: NodeJS.ProcessEnv }): Promise<ExportRecord> {
  const head = await manuscriptHead(pool, a.paperId, a.documentId);
  const docx = await headDocx(pool, { paperId: a.paperId, ownerId: a.ownerId, head });
  let pdf;
  try {
    pdf = await slot(() => docxToPdf(docx.bytes, { env: a.env }));
  } catch (e) {
    if (e instanceof PdfUnavailable) throw new DomainError('CONFLICT', e.message, 'format', { details: { reason: 'PDF_CONVERTER_UNAVAILABLE' } });
    if (e instanceof PdfFailed) throw new DomainError('CONFLICT', `PDF 변환에 실패했습니다: ${e.message}`.slice(0, 500), 'format', { details: { reason: 'PDF_CONVERSION_FAILED' } });
    throw e;
  }
  const check = textCheck(pdf.text, headingsOf(head.content_json));
  const issues: (Issue | (Omit<Issue, 'kind'> & { kind: 'pdf_text_missing' | 'pdf_text_not_checked' }))[] = [...docx.report.issues];
  // text never read back is not a pass (review m2)
  if (check.status === 'not_run') issues.push({ kind: 'pdf_text_not_checked', severity: 'warning', count: 1, examples: [], note: 'PDF 본문을 확인하지 못했습니다(pdftotext 없음) — PDF를 직접 열어 확인하세요' });
  if (check.status === 'failed') issues.push({ kind: 'pdf_text_missing', severity: 'warning', count: check.missing.length, examples: check.missing.slice(0, 5), note: 'PDF에서 일부 제목을 찾지 못했습니다 — 글꼴이나 변환 결과를 확인하세요' });
  const status = docx.report.status === 'draft_with_errors' ? 'draft_with_errors' : issues.length ? 'needs_attention' : 'clean';
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const report = { ...docx.report, status, issues, pdf: { converter: pdf.converter, text_check: check, docx_sha256: sha(docx.bytes) } };
  const renderer = `${docx.report.renderer_version}+libreoffice-${pdf.converter.version}`.slice(0, 100);
  const id = await inTransaction(pool, async (tx) => {
    await tx.query("SELECT set_config('pw.actor', $1, true)", [`owner:${a.ownerId}`]);
    return (await tx.query<{ id: string }>(
      `INSERT INTO exports (paper_id, document_id, revision_id, format, status, style, style_version, renderer_version, report_json, file_bytes, sha256, byte_size, created_by)
       VALUES ($1, $2, $3, 'pdf', $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [a.paperId, head.document_id, head.revision_id, status, docx.style, docx.report.style_version, renderer, JSON.stringify(report), pdf.bytes, sha(pdf.bytes), pdf.bytes.length, a.ownerId])).rows[0]!.id;
  });
  return (await getExport(pool, a.paperId, id))!;
}
