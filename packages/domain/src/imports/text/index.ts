// Text/Markdown import (PW-021, spec 10 "가져오기"): the file is stored as received (with its hash), parsed
// into a preview with a loss report, and applied only by an explicit owner action:
//   * new_manuscript — only when the paper has no manuscript yet
//   * replace_manuscript — a new version of the manuscript; needs confirm_replace and the head the owner
//     saw (expected head). The previous text stays as a revision and can be restored.
// An import is applied at most once. Nothing here deletes or rewrites history.
import { createHash } from 'node:crypto';
import { DomainError, UUID_RE, inTransaction, storable, type Queryable, type TxPool } from '../../shared/db.ts';
import { appendRevisionIn, createDocumentIn, lockDocumentHead, type Revision } from '../../revisions/index.ts';
import { IMPORT_FORMATS, ImportError, PARSER_VERSION, parseImport, type ImportFormat, type ImportReport } from './parse.ts';

export { IMPORT_FORMATS, PARSER_VERSION, parseImport };
export const MAX_IMPORT_BYTES = 900_000;
const setActor = (tx: Queryable, actor: string) => tx.query("SELECT set_config('pw.actor', $1, true)", [actor]);

export interface ImportView {
  id: string; format: ImportFormat; filename: string | null; byte_size: number; source_sha256: string; parser_version: string;
  preview: { type: 'doc'; content: unknown[] }; report: ImportReport; created_at: string;
  applied: { document_id: string; revision_id: string; mode: string; created_at: string } | null;
}
const VIEW = `i.id, i.format, i.filename, i.byte_size, i.source_sha256, i.parser_version, i.preview_json AS preview, i.report_json AS report, i.created_at,
  CASE WHEN a.import_id IS NULL THEN NULL ELSE jsonb_build_object('document_id', a.document_id, 'revision_id', a.revision_id, 'mode', a.mode, 'created_at', a.created_at) END AS applied`;

// The file is sent as bytes (content_base64) or, for pasted text, as text. Bytes must be UTF-8: a file in
// another encoding (e.g. EUC-KR) is refused instead of being stored with broken characters.
export async function createImport(pool: TxPool, a: { paperId: string; ownerId: string; format: unknown; filename: unknown; text?: unknown; contentBase64?: unknown }): Promise<ImportView> {
  if (!IMPORT_FORMATS.includes(a.format as ImportFormat)) throw new DomainError('INVALID', `format must be one of ${IMPORT_FORMATS.join(', ')} (DOCX import comes later)`, 'format');
  const filename = a.filename ?? null;
  if (filename !== null && (typeof filename !== 'string' || !filename.trim() || filename.length > 255 || !storable(filename))) throw new DomainError('INVALID', 'filename must be 1–255 characters', 'filename');
  let raw: Buffer;
  let text: string;
  if (a.contentBase64 !== undefined && a.contentBase64 !== null) {
    if (typeof a.contentBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.contentBase64)) throw new DomainError('INVALID', 'content_base64 must be base64', 'content_base64');
    raw = Buffer.from(a.contentBase64, 'base64');
    if (raw.length > MAX_IMPORT_BYTES) throw new DomainError('INVALID', `the file is larger than ${MAX_IMPORT_BYTES} bytes`, 'content_base64');
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new DomainError('INVALID', 'the file is not UTF-8 text (e.g. EUC-KR/CP949); save it as UTF-8 and import again', 'content_base64', { details: { reason: 'NOT_UTF8' } });
    }
  } else {
    if (typeof a.text !== 'string') throw new DomainError('INVALID', 'send the file as content_base64 or the pasted text as text', 'text');
    text = a.text;
    raw = Buffer.from(text, 'utf8');
    if (raw.length > MAX_IMPORT_BYTES) throw new DomainError('INVALID', `the text is larger than ${MAX_IMPORT_BYTES} bytes`, 'text');
  }
  if (!storable(text)) throw new DomainError('INVALID', 'the file contains a NUL character or invalid UTF-16; save it as UTF-8 text', 'text');
  const bytes = raw.length;
  let parsed;
  try {
    parsed = parseImport(text, a.format as ImportFormat);
  } catch (e) {
    if (e instanceof ImportError) throw new DomainError('INVALID', e.message, 'text');
    throw e;
  }
  const id = await inTransaction(pool, async (tx) => {
    await setActor(tx, `owner:${a.ownerId}`);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO import_sources (paper_id, format, filename, source_text, source_bytes, source_sha256, byte_size, parser_version, preview_json, report_json, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [a.paperId, a.format, filename, text, raw, createHash('sha256').update(raw).digest('hex'), bytes, PARSER_VERSION, JSON.stringify(parsed.doc), JSON.stringify(parsed.report), a.ownerId],
    );
    return rows[0]!.id;
  });
  return (await getImport(pool, a.paperId, id))!;
}

export async function getImport(db: Queryable, paperId: string, importId: string): Promise<ImportView | null> {
  if (!UUID_RE.test(importId)) return null;
  const { rows } = await db.query<ImportView>(`SELECT ${VIEW} FROM import_sources i LEFT JOIN import_applications a ON a.import_id = i.id WHERE i.paper_id = $1 AND i.id = $2`, [paperId, importId]);
  return rows[0] ?? null;
}

export async function listImports(db: Queryable, paperId: string) {
  const { rows } = await db.query<Omit<ImportView, 'preview'>>(
    `SELECT i.id, i.format, i.filename, i.byte_size, i.source_sha256, i.parser_version, i.report_json AS report, i.created_at,
       CASE WHEN a.import_id IS NULL THEN NULL ELSE jsonb_build_object('document_id', a.document_id, 'revision_id', a.revision_id, 'mode', a.mode, 'created_at', a.created_at) END AS applied
     FROM import_sources i LEFT JOIN import_applications a ON a.import_id = i.id WHERE i.paper_id = $1 ORDER BY i.created_at DESC LIMIT 50`, [paperId]);
  return rows;
}

export async function applyImport(pool: TxPool, a: { paperId: string; ownerId: string; importId: string; mode: unknown; documentId?: unknown; expectedHead?: unknown; confirmReplace?: unknown }): Promise<{ import: ImportView; revision: Revision; document_id: string }> {
  if (a.mode !== 'new_manuscript' && a.mode !== 'replace_manuscript') throw new DomainError('INVALID', 'mode must be new_manuscript or replace_manuscript', 'mode');
  if (a.mode === 'replace_manuscript' && a.confirmReplace !== true) {
    throw new DomainError('INVALID', 'replacing the manuscript needs explicit confirmation (confirm_replace: true); the current text stays as an earlier version', 'confirm_replace', { details: { reason: 'CONFIRM_REQUIRED' } });
  }
  const out = await inTransaction(pool, async (tx) => {
    await setActor(tx, `owner:${a.ownerId}`);
    if (!(await getImport(tx, a.paperId, a.importId))) throw new DomainError('NOT_FOUND', 'import not found');
    // locks: a new manuscript takes the paper row (keeps "no manuscript yet" true until commit); a
    // replacement takes only the document row, as saves do (the paper lock after the document lock
    // would deadlock with a snapshot, which locks documents and then the paper)
    if (a.mode === 'new_manuscript' && !(await tx.query('SELECT 1 FROM paper_projects WHERE id = $1 FOR UPDATE', [a.paperId])).rows[0]) throw new DomainError('NOT_FOUND', 'paper not found');
    const manuscripts = (await tx.query<{ id: string }>("SELECT id FROM documents WHERE paper_id = $1 AND kind = 'manuscript' ORDER BY created_at", [a.paperId])).rows;
    let documentId: string;
    let parent: string;
    if (a.mode === 'new_manuscript') {
      if (manuscripts.length) throw new DomainError('CONFLICT', 'this paper already has a manuscript; replace it as a new version instead', undefined, { details: { reason: 'MANUSCRIPT_EXISTS' } });
      const created = await createDocumentIn(tx, a.paperId, a.ownerId, 'manuscript');
      documentId = (created.document as unknown as { id: string }).id;
      parent = created.head.id;
    } else {
      if (typeof a.documentId !== 'string' || !manuscripts.some((m) => m.id === a.documentId)) throw new DomainError('NOT_FOUND', 'manuscript not found');
      documentId = a.documentId;
      parent = await lockDocumentHead(tx, a.paperId, documentId, a.expectedHead);
    }
    // read under the lock: applied at most once (the primary key backs this up)
    const imp = (await getImport(tx, a.paperId, a.importId))!;
    if (imp.applied) throw new DomainError('CONFLICT', 'this import was already applied', undefined, { details: { reason: 'ALREADY_APPLIED' } });
    const revision = await appendRevisionIn(tx, { paperId: a.paperId, documentId, parent, content: imp.preview, schemaVersion: 1, ownerId: a.ownerId, reason: 'import' });
    await tx.query('INSERT INTO import_applications (import_id, paper_id, document_id, revision_id, mode, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [imp.id, a.paperId, documentId, revision.id, a.mode, a.ownerId]);
    return { revision, document_id: documentId };
  });
  return { ...out, import: (await getImport(pool, a.paperId, a.importId))! };
}
