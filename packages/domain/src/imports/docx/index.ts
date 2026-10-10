// DOCX import (PW-055, spec 10 "가져오기"): the file is converted into a preview with a loss report
// (./parse.ts); its bytes are stored as received (with their hash) in the same transaction as that preview —
// a file that cannot be read, or whose tracked changes still need the owner's choice, is refused and nothing
// is stored (the owner still has the file; review m3, RFC-014). It is applied only by the owner's
// explicit action through the same path as text imports (imports/text applyImport: a new manuscript, or a new
// version of the current one with confirmation — the current text stays a revision). With unresolved tracked
// changes the owner first chooses which text to take. The original stays downloadable; nothing claims the
// conversion is a round trip.
import { createHash } from 'node:crypto';
import { DomainError, UUID_RE, inTransaction, storable, type Queryable, type TxPool } from '../../shared/db.ts';
import { getImport, type ImportView } from '../text/index.ts';
import { DocxError, DOCX_PARSER_VERSION, parseDocx, type TrackedChoice } from './parse.ts';

export { DocxError, DOCX_PARSER_VERSION, parseDocx };
export type { DocxReport, DocxLoss, TrackedChoice } from './parse.ts';
export const MAX_DOCX_BYTES = 10 * 1024 * 1024;

export async function createDocxImport(pool: TxPool, a: { paperId: string; ownerId: string; filename: unknown; contentBase64: unknown; trackedChanges?: unknown }): Promise<ImportView> {
  const filename = a.filename ?? null;
  if (filename !== null && (typeof filename !== 'string' || !filename.trim() || filename.length > 255 || !storable(filename))) throw new DomainError('INVALID', 'filename must be 1–255 characters', 'filename');
  if (typeof a.contentBase64 !== 'string' || !a.contentBase64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.contentBase64)) throw new DomainError('INVALID', 'send the .docx file as content_base64', 'content_base64');
  const raw = Buffer.from(a.contentBase64, 'base64');
  if (raw.length > MAX_DOCX_BYTES) throw new DomainError('INVALID', `the file is larger than ${MAX_DOCX_BYTES} bytes`, 'content_base64', { details: { reason: 'TOO_LARGE' } });
  const tracked = a.trackedChanges ?? undefined;
  if (tracked !== undefined && tracked !== 'accept' && tracked !== 'reject') throw new DomainError('INVALID', 'tracked_changes must be accept or reject', 'tracked_changes');
  let parsed;
  try {
    parsed = parseDocx(raw, { trackedChanges: tracked as TrackedChoice | undefined });
  } catch (e) {
    if (e instanceof DocxError) throw new DomainError('INVALID', e.message, e.reason === 'TRACKED_CHANGES_CHOICE' || e.reason === 'NO_TRACKED_CHANGES' ? 'tracked_changes' : 'content_base64', { details: { reason: e.reason, ...e.details } });
    throw e;
  }
  const id = await inTransaction(pool, async (tx) => {
    await tx.query("SELECT set_config('pw.actor', $1, true)", [`owner:${a.ownerId}`]);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO import_sources (paper_id, format, filename, source_text, source_bytes, source_sha256, byte_size, parser_version, preview_json, report_json, created_by)
       VALUES ($1, 'docx', $2, NULL, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [a.paperId, filename, raw, createHash('sha256').update(raw).digest('hex'), raw.length, DOCX_PARSER_VERSION, JSON.stringify(parsed.doc), JSON.stringify(parsed.report), a.ownerId],
    );
    return rows[0]!.id;
  });
  return (await getImport(pool, a.paperId, id))!;
}

// the file as it was received, for download (any import format)
export async function importOriginal(db: Queryable, paperId: string, importId: string): Promise<{ filename: string | null; format: string; sha256: string; bytes: Buffer } | null> {
  if (!UUID_RE.test(importId)) return null;
  const r = (await db.query<{ filename: string | null; format: string; sha256: string; bytes: Buffer | null; text: string | null }>(
    'SELECT filename, format, source_sha256 AS sha256, source_bytes AS bytes, source_text AS text FROM import_sources WHERE paper_id = $1 AND id = $2', [paperId, importId])).rows[0];
  if (!r) return null;
  return { filename: r.filename, format: r.format, sha256: r.sha256, bytes: r.bytes ?? Buffer.from(r.text ?? '', 'utf8') };
}
