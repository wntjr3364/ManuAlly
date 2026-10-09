// Comment threads (PW-018, spec 04 "Comment / Highlight"). A thread starts on a selection the server
// verifies against the stored revision (like a selection handle). Its anchor is resolved against the
// current head on every read (anchor.ts): attached only where certain, otherwise ORPHANED until the
// owner attaches it again. Resolve/reopen is the owner's decision and independent of edits or AI
// proposals (rejecting a proposal never touches comments).
import { EDITOR_SCHEMA_VERSION, parseDocument } from '@pw/editor-core';
import { DomainError, UUID_RE, inTransaction, storable, type Queryable, type TxPool } from '../shared/db.ts';
import { verifySelection } from '../proposals/index.ts';
import { makeAnchor, resolveAnchor, type Anchor, type Resolved } from './anchor.ts';

export type { Anchor, Resolved };
const setActor = (tx: Queryable, actor: string) => tx.query("SELECT set_config('pw.actor', $1, true)", [actor]);

export interface CommentMessage { id: string; body: string; author_id: string; created_at: string }
export interface CommentThread {
  id: string; document_id: string; state: 'OPEN' | 'RESOLVED'; created_by: string; created_at: string; state_changed_at: string | null;
  anchor: Anchor & { revision_id: string };
  resolved: Resolved;
  messages: CommentMessage[];
}

function checkBody(body: unknown): string {
  if (typeof body !== 'string' || !body.trim() || body.length > 10000 || !storable(body)) throw new DomainError('INVALID', 'a comment is 1–10000 characters of text', 'body');
  return body.trim();
}

async function insertAnchor(tx: Queryable, a: { paperId: string; threadId: string; ownerId: string; documentId: unknown; baseRevisionId: unknown; selection: unknown }) {
  const v = await verifySelection(tx, { paperId: a.paperId, documentId: a.documentId, baseRevisionId: a.baseRevisionId, selection: a.selection });
  const anchor = makeAnchor(v.doc, v.snap.block_id, v.snap.from, v.snap.to);
  await tx.query(
    `INSERT INTO comment_anchors (paper_id, document_id, thread_id, revision_id, block_id, from_pos, to_pos, quote, prefix, suffix, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [a.paperId, v.documentId, a.threadId, v.revisionId, anchor.block_id, anchor.from, anchor.to, anchor.quote, anchor.prefix, anchor.suffix, a.ownerId],
  );
}

export async function createThread(pool: TxPool, a: { paperId: string; documentId: unknown; ownerId: string; baseRevisionId: unknown; selection: unknown; body: unknown }) {
  const body = checkBody(a.body);
  if (typeof a.documentId !== 'string' || !UUID_RE.test(a.documentId)) throw new DomainError('NOT_FOUND', 'document not found');
  const id = await inTransaction(pool, async (tx) => {
    await setActor(tx, `owner:${a.ownerId}`);
    const doc = await tx.query('SELECT 1 FROM documents WHERE paper_id = $1 AND id = $2', [a.paperId, a.documentId]);
    if (!doc.rows[0]) throw new DomainError('NOT_FOUND', 'document not found');
    const { rows } = await tx.query<{ id: string }>('INSERT INTO comment_threads (paper_id, document_id, created_by) VALUES ($1, $2, $3) RETURNING id', [a.paperId, a.documentId, a.ownerId]);
    const threadId = rows[0]!.id;
    await insertAnchor(tx, { ...a, threadId });
    await tx.query('INSERT INTO comment_messages (paper_id, thread_id, body, author_id) VALUES ($1, $2, $3, $4)', [a.paperId, threadId, body, a.ownerId]);
    return threadId;
  });
  return (await getThread(pool, a.paperId, id))!;
}

async function threadRow(db: Queryable, paperId: string, threadId: string) {
  if (!UUID_RE.test(threadId)) return null;
  const { rows } = await db.query<{ id: string; document_id: string }>('SELECT id, document_id FROM comment_threads WHERE paper_id = $1 AND id = $2', [paperId, threadId]);
  return rows[0] ?? null;
}

export async function addMessage(pool: TxPool, a: { paperId: string; threadId: string; ownerId: string; body: unknown }) {
  const body = checkBody(a.body);
  if (!(await threadRow(pool, a.paperId, a.threadId))) throw new DomainError('NOT_FOUND', 'comment not found');
  await pool.query('INSERT INTO comment_messages (paper_id, thread_id, body, author_id) VALUES ($1, $2, $3, $4)', [a.paperId, a.threadId, body, a.ownerId]);
  return (await getThread(pool, a.paperId, a.threadId))!;
}

export async function setThreadState(pool: TxPool, a: { paperId: string; threadId: string; ownerId: string; state: 'OPEN' | 'RESOLVED' }) {
  await inTransaction(pool, async (tx) => {
    await setActor(tx, `owner:${a.ownerId}`);
    if (!(await threadRow(tx, a.paperId, a.threadId))) throw new DomainError('NOT_FOUND', 'comment not found');
    const { rowCount } = await tx.query('UPDATE comment_threads SET state = $3, state_changed_by = $4 WHERE paper_id = $1 AND id = $2 AND state <> $3', [a.paperId, a.threadId, a.state, a.ownerId]);
    if (!rowCount) throw new DomainError('CONFLICT', `the comment is already ${a.state === 'OPEN' ? 'open' : 'resolved'}`);
  });
  return (await getThread(pool, a.paperId, a.threadId))!;
}

// The owner attaches a comment again (e.g. after it was ORPHANED) to a new selection.
export async function reanchorThread(pool: TxPool, a: { paperId: string; threadId: string; ownerId: string; baseRevisionId: unknown; selection: unknown }) {
  await inTransaction(pool, async (tx) => {
    await setActor(tx, `owner:${a.ownerId}`);
    const t = await threadRow(tx, a.paperId, a.threadId);
    if (!t) throw new DomainError('NOT_FOUND', 'comment not found');
    await insertAnchor(tx, { paperId: a.paperId, threadId: t.id, ownerId: a.ownerId, documentId: t.document_id, baseRevisionId: a.baseRevisionId, selection: a.selection });
  });
  return (await getThread(pool, a.paperId, a.threadId))!;
}

async function headDoc(db: Queryable, paperId: string, documentId: string) {
  const { rows } = await db.query<{ id: string; content_json: unknown; schema_version: number }>(
    'SELECT r.id, r.content_json, r.schema_version FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.paper_id = $1 AND d.id = $2', [paperId, documentId]);
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, doc: r.schema_version === EDITOR_SCHEMA_VERSION ? parseDocument(r.content_json, r.schema_version) : null };
}

const THREAD = 'id, document_id, state, created_by, created_at, state_changed_at';

async function hydrate(db: Queryable, paperId: string, threads: Omit<CommentThread, 'anchor' | 'resolved' | 'messages'>[], head: { id: string; doc: ReturnType<typeof parseDocument> | null }) {
  if (!threads.length) return [];
  const ids = threads.map((t) => t.id);
  const anchors = (await db.query<{ thread_id: string; revision_id: string; block_id: string; from_pos: number; to_pos: number; quote: string; prefix: string; suffix: string }>(
    `SELECT DISTINCT ON (thread_id) thread_id, revision_id, block_id, from_pos, to_pos, quote, prefix, suffix FROM comment_anchors
     WHERE paper_id = $1 AND thread_id = ANY($2::uuid[]) ORDER BY thread_id, created_at DESC, id DESC`, [paperId, ids])).rows;
  const messages = (await db.query<CommentMessage & { thread_id: string }>(
    'SELECT id, thread_id, body, author_id, created_at FROM comment_messages WHERE paper_id = $1 AND thread_id = ANY($2::uuid[]) ORDER BY created_at, id', [paperId, ids])).rows;
  return threads.map((t): CommentThread => {
    const a = anchors.find((x) => x.thread_id === t.id)!;
    const anchor = { revision_id: a.revision_id, block_id: a.block_id, from: a.from_pos, to: a.to_pos, quote: a.quote, prefix: a.prefix, suffix: a.suffix };
    return {
      ...t,
      anchor,
      resolved: head.doc ? resolveAnchor(head.doc, anchor) : { state: 'ORPHANED', reason: 'TEXT_CHANGED' },
      messages: messages.filter((m) => m.thread_id === t.id).map(({ thread_id: _t, ...m }) => { void _t; return m; }),
    };
  });
}

export async function getThread(db: Queryable, paperId: string, threadId: string): Promise<CommentThread | null> {
  if (!UUID_RE.test(threadId)) return null;
  const t = (await db.query<Omit<CommentThread, 'anchor' | 'resolved' | 'messages'>>(`SELECT ${THREAD} FROM comment_threads WHERE paper_id = $1 AND id = $2`, [paperId, threadId])).rows[0];
  if (!t) return null;
  const head = await headDoc(db, paperId, t.document_id);
  return (await hydrate(db, paperId, [t], head!))[0]!;
}

// Threads of a document with their anchors resolved against the current head revision.
export async function listThreads(db: Queryable, paperId: string, documentId: string) {
  if (!UUID_RE.test(documentId)) return null;
  const head = await headDoc(db, paperId, documentId);
  if (!head) return null;
  const threads = (await db.query<Omit<CommentThread, 'anchor' | 'resolved' | 'messages'>>(`SELECT ${THREAD} FROM comment_threads WHERE paper_id = $1 AND document_id = $2 ORDER BY created_at, id`, [paperId, documentId])).rows;
  return { head_revision_id: head.id, threads: await hydrate(db, paperId, threads, head) };
}
