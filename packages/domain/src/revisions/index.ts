// Documents, immutable revisions and named snapshots. Revisions are append-only (DB triggers);
// the document head moves only by compare-and-set inside a transaction. Restore never rewrites
// history: it appends a new revision whose content equals the restored one.
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '../shared/db.ts';

export type { TxPool };

// Canonical JSON (sorted keys) → sha256. PW-012 moves canonicalisation into editor-core.
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
export const contentHash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');

export const DOCUMENT_KINDS = ['manuscript', 'notes', 'response_letter', 'supplement'] as const;
// reasons a client may request directly; 'restore'/'initial' are internal, 'ai_apply' only via an approved proposal (PW-017)
export const CLIENT_SAVE_REASONS = ['manual', 'autosave', 'import'] as const;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

export interface Revision {
  id: string;
  paper_id: string;
  document_id: string;
  parent_revision_id: string | null;
  restored_from_revision_id: string | null;
  content_json: Record<string, unknown>;
  schema_version: number;
  content_hash: string;
  created_by: string;
  reason: string;
  created_at: string;
}
export type RevisionMeta = Omit<Revision, 'content_json'>;
const META = 'id, paper_id, document_id, parent_revision_id, restored_from_revision_id, schema_version, content_hash, created_by, reason, created_at';

function validateContent(content: unknown, schemaVersion: unknown) {
  if (!content || typeof content !== 'object' || Array.isArray(content) || (content as { type?: unknown }).type !== 'doc') {
    throw new DomainError('INVALID', 'content_json must be a document object with type "doc"', 'content_json');
  }
  if (Buffer.byteLength(JSON.stringify(content)) > MAX_CONTENT_BYTES) throw new DomainError('INVALID', 'content_json is larger than 2 MB', 'content_json');
  if (!Number.isInteger(schemaVersion) || (schemaVersion as number) < 1) throw new DomainError('INVALID', 'schema_version must be a positive integer', 'schema_version');
}

const ids = (...v: unknown[]) => v.every((x) => typeof x === 'string' && UUID_RE.test(x));

async function lockHead(tx: Queryable, paperId: string, documentId: string, expectedHead: unknown): Promise<string> {
  if (!ids(documentId)) throw new DomainError('NOT_FOUND', 'document not found');
  const { rows } = await tx.query<{ head_revision_id: string }>('SELECT head_revision_id FROM documents WHERE id = $1 AND paper_id = $2 FOR UPDATE', [documentId, paperId]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'document not found');
  if (typeof expectedHead !== 'string') throw new DomainError('INVALID', 'expected_head_revision_id is required', 'expected_head_revision_id');
  if (rows[0].head_revision_id !== expectedHead) throw new DomainError('CONFLICT', 'the document changed since you loaded it (stale head); reload before saving');
  return rows[0].head_revision_id;
}

async function append(tx: Queryable, r: { paperId: string; documentId: string; parent: string | null; restoredFrom?: string | null; content: object; schemaVersion: number; ownerId: string; reason: string; id?: string }): Promise<Revision> {
  const { rows } = await tx.query<Revision>(
    `INSERT INTO document_revisions (id, paper_id, document_id, parent_revision_id, restored_from_revision_id, content_json, schema_version, content_hash, created_by, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${META}, content_json`,
    [r.id ?? randomUUID(), r.paperId, r.documentId, r.parent, r.restoredFrom ?? null, JSON.stringify(r.content), r.schemaVersion, contentHash(r.content), r.ownerId, r.reason],
  );
  await tx.query('UPDATE documents SET head_revision_id = $2 WHERE id = $1', [r.documentId, rows[0]!.id]);
  return rows[0]!;
}

export async function createDocument(pool: TxPool, paperId: string, ownerId: string, kind: unknown) {
  if (!DOCUMENT_KINDS.includes(kind as (typeof DOCUMENT_KINDS)[number])) throw new DomainError('INVALID', `kind must be one of ${DOCUMENT_KINDS.join(', ')}`, 'kind');
  return inTransaction(pool, async (tx) => {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const { rows } = await tx.query('INSERT INTO documents (id, paper_id, kind, head_revision_id) VALUES ($1, $2, $3, $4) RETURNING id, paper_id, kind, head_revision_id, created_at', [documentId, paperId, kind, revisionId]);
    const head = await append(tx, { id: revisionId, paperId, documentId, parent: null, content: { type: 'doc', content: [] }, schemaVersion: 1, ownerId, reason: 'initial' });
    return { document: { ...rows[0], head_revision_id: head.id }, head };
  });
}

export async function getDocument(db: Queryable, paperId: string, documentId: string) {
  if (!ids(documentId)) return null;
  const { rows } = await db.query<{ id: string; head_revision_id: string }>('SELECT id, paper_id, kind, head_revision_id, created_at FROM documents WHERE id = $1 AND paper_id = $2', [documentId, paperId]);
  if (!rows[0]) return null;
  return { document: rows[0], head: await getRevision(db, paperId, documentId, rows[0].head_revision_id) };
}

export async function listDocuments(db: Queryable, paperId: string) {
  const { rows } = await db.query('SELECT id, paper_id, kind, head_revision_id, created_at FROM documents WHERE paper_id = $1 ORDER BY created_at', [paperId]);
  return rows;
}

export async function getRevision(db: Queryable, paperId: string, documentId: string, revisionId: string): Promise<Revision | null> {
  if (!ids(documentId, revisionId)) return null;
  const { rows } = await db.query<Revision>(`SELECT ${META}, content_json FROM document_revisions WHERE id = $1 AND paper_id = $2 AND document_id = $3`, [revisionId, paperId, documentId]);
  return rows[0] ?? null;
}

export async function listRevisions(db: Queryable, paperId: string, documentId: string): Promise<RevisionMeta[]> {
  if (!ids(documentId)) return [];
  const { rows } = await db.query<RevisionMeta>(`SELECT ${META} FROM document_revisions WHERE paper_id = $1 AND document_id = $2 ORDER BY created_at DESC, id`, [paperId, documentId]);
  return rows;
}

export async function saveRevision(pool: TxPool, a: { paperId: string; documentId: string; ownerId: string; expectedHead: unknown; content: unknown; schemaVersion: unknown; reason: unknown }) {
  if (!CLIENT_SAVE_REASONS.includes(a.reason as (typeof CLIENT_SAVE_REASONS)[number])) throw new DomainError('INVALID', `reason must be one of ${CLIENT_SAVE_REASONS.join(', ')}`, 'reason');
  validateContent(a.content, a.schemaVersion);
  return inTransaction(pool, async (tx) => {
    const head = await lockHead(tx, a.paperId, a.documentId, a.expectedHead);
    return append(tx, { paperId: a.paperId, documentId: a.documentId, parent: head, content: a.content as object, schemaVersion: a.schemaVersion as number, ownerId: a.ownerId, reason: a.reason as string });
  });
}

export async function restoreRevision(pool: TxPool, a: { paperId: string; documentId: string; ownerId: string; revisionId: unknown; expectedHead: unknown }) {
  return inTransaction(pool, async (tx) => {
    const head = await lockHead(tx, a.paperId, a.documentId, a.expectedHead);
    const old = typeof a.revisionId === 'string' ? await getRevision(tx, a.paperId, a.documentId, a.revisionId) : null;
    if (!old) throw new DomainError('NOT_FOUND', 'revision not found in this document');
    return append(tx, { paperId: a.paperId, documentId: a.documentId, parent: head, restoredFrom: old.id, content: old.content_json, schemaVersion: old.schema_version, ownerId: a.ownerId, reason: 'restore' });
  });
}

// A snapshot pins the current head of every document plus the latest bibliographic revision of
// every project reference and the latest revision of every asset, by id.
export async function createSnapshot(pool: TxPool, paperId: string, ownerId: string, label: unknown) {
  if (typeof label !== 'string' || !label.trim() || label.length > 200) throw new DomainError('INVALID', 'label must be 1–200 characters', 'label');
  return inTransaction(pool, async (tx) => {
    // lock documents so heads cannot move while the manifest is written
    await tx.query('SELECT id FROM documents WHERE paper_id = $1 FOR SHARE', [paperId]);
    const { rows } = await tx.query<{ id: string }>('INSERT INTO paper_snapshots (paper_id, label, created_by) VALUES ($1, $2, $3) RETURNING id, paper_id, label, created_by, created_at', [paperId, label.trim(), ownerId]);
    const snap = rows[0]!;
    await tx.query('INSERT INTO snapshot_document_revisions (snapshot_id, paper_id, document_id, revision_id) SELECT $1, paper_id, id, head_revision_id FROM documents WHERE paper_id = $2', [snap.id, paperId]);
    await tx.query(
      `INSERT INTO snapshot_reference_revisions (snapshot_id, paper_id, reference_id, bibliographic_revision_id)
       SELECT DISTINCT ON (pr.reference_id) $1, pr.paper_id, pr.reference_id, b.id
       FROM project_references pr JOIN bibliographic_revisions b ON b.reference_id = pr.reference_id
       WHERE pr.paper_id = $2 ORDER BY pr.reference_id, b.created_at DESC, b.id`,
      [snap.id, paperId],
    );
    await tx.query(
      `INSERT INTO snapshot_asset_revisions (snapshot_id, paper_id, asset_revision_id)
       SELECT DISTINCT ON (asset_key) $1, paper_id, id FROM asset_revisions WHERE paper_id = $2 ORDER BY asset_key, created_at DESC, id`,
      [snap.id, paperId],
    );
    return snap;
  });
}

export async function listSnapshots(db: Queryable, paperId: string) {
  const { rows } = await db.query('SELECT id, paper_id, label, created_by, created_at FROM paper_snapshots WHERE paper_id = $1 ORDER BY created_at DESC', [paperId]);
  return rows;
}

export async function getSnapshot(db: Queryable, paperId: string, snapshotId: string) {
  if (!ids(snapshotId)) return null;
  const { rows } = await db.query('SELECT id, paper_id, label, created_by, created_at FROM paper_snapshots WHERE id = $1 AND paper_id = $2', [snapshotId, paperId]);
  if (!rows[0]) return null;
  const docs = await db.query<{ document_id: string; revision_id: string }>('SELECT document_id, revision_id FROM snapshot_document_revisions WHERE snapshot_id = $1 AND paper_id = $2 ORDER BY document_id', [snapshotId, paperId]);
  const documents = [];
  for (const d of docs.rows) documents.push({ document_id: d.document_id, revision: await getRevision(db, paperId, d.document_id, d.revision_id) });
  const refs = await db.query('SELECT reference_id, bibliographic_revision_id FROM snapshot_reference_revisions WHERE snapshot_id = $1 AND paper_id = $2', [snapshotId, paperId]);
  const assets = await db.query('SELECT asset_revision_id FROM snapshot_asset_revisions WHERE snapshot_id = $1 AND paper_id = $2', [snapshotId, paperId]);
  return { ...rows[0], documents, references: refs.rows, assets: assets.rows };
}
