// Selection handles, edit proposals and idempotent apply (PW-017, spec 04 "AI proposal 경로").
// - A selection handle is re-derived by the server from the stored revision; the browser's hashes
//   must match exactly or the handle is refused.
// - A proposal names a handle and replacement content only (ai_replacement v1). The server builds the
//   canonical EditProposal v2, runs the replacement checks (guard.ts) and records its status.
// - RFC-003: before the outline is approved only conservative corrections (grammar, concise) exist.
// - Apply is one transaction: expected revision = proposal base = current head (v1 never rebases),
//   same proposal hash, an idempotency key that maps to exactly one result. A resent apply returns
//   that result; a second apply with another key is refused with the existing result.
import { createHash, randomUUID } from 'node:crypto';
import {
  EDITOR_SCHEMA_VERSION, atomNodesIn, buildReplacement, canonicalJson, findBlock, parseDocument, snapshotSelection, validateDocument,
  ReplacementError, SelectionError,
} from '@pw/editor-core';
import { DomainError, UUID_RE, inTransaction, storable, type Queryable, type TxPool } from '../shared/db.ts';
import { appendRevisionIn, contentHash, getRevision, lockDocumentHead } from '../revisions/index.ts';
import { checkReplacement, type CheckResult, type ProposalIntent } from './guard.ts';

export type { CheckResult, ProposalIntent };
export const PROPOSAL_INTENTS: readonly ProposalIntent[] = ['grammar', 'concise', 'rewrite'];
export const PREAPPROVAL_INTENTS: readonly ProposalIntent[] = ['grammar', 'concise'];
export type ProposalStatus = 'PENDING' | 'APPLIED' | 'REJECTED' | 'STALE' | 'CHECK_FAILED';

const HEX64 = /^[0-9a-f]{64}$/;
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const setActor = (tx: Queryable, actor: string) => tx.query("SELECT set_config('pw.actor', $1, true)", [actor]);

export interface SelectionHandle {
  id: string; paper_id: string; document_id: string; base_revision_id: string; block_id: string;
  from_pos: number; to_pos: number; expected_block_hash: string; selected_slice_hash: string; quote: string;
  atoms: unknown[]; created_by: string; created_at: string;
}
const HANDLE = 'id, paper_id, document_id, base_revision_id, block_id, from_pos, to_pos, expected_block_hash, selected_slice_hash, quote, atoms, created_by, created_at';

async function storedDoc(db: Queryable, paperId: string, documentId: string, revisionId: string) {
  const { rows } = await db.query<{ content_json: unknown; schema_version: number }>(
    'SELECT content_json, schema_version FROM document_revisions WHERE paper_id = $1 AND document_id = $2 AND id = $3', [paperId, documentId, revisionId]);
  if (!rows[0]) return null;
  if (rows[0].schema_version !== EDITOR_SCHEMA_VERSION) throw new DomainError('INVALID', 'this revision uses another document format and must be migrated first');
  return parseDocument(rows[0].content_json, rows[0].schema_version);
}

// Re-derives a selection the browser froze (PW-016) from the stored revision; any difference is
// refused. Used for selection handles and comment anchors.
export async function verifySelection(db: Queryable, a: { paperId: string; documentId: unknown; baseRevisionId: unknown; selection: unknown }) {
  if (typeof a.documentId !== 'string' || !UUID_RE.test(a.documentId) || typeof a.baseRevisionId !== 'string' || !UUID_RE.test(a.baseRevisionId)) throw new DomainError('NOT_FOUND', 'document revision not found');
  const s = a.selection as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || typeof s.block_id !== 'string' || !Number.isInteger(s.from) || !Number.isInteger(s.to) || typeof s.expected_block_hash !== 'string' || typeof s.selected_slice_hash !== 'string') {
    throw new DomainError('INVALID', 'selection needs block_id, from, to, expected_block_hash and selected_slice_hash', 'selection');
  }
  const doc = await storedDoc(db, a.paperId, a.documentId, a.baseRevisionId);
  if (!doc) throw new DomainError('NOT_FOUND', 'document revision not found');
  let snap;
  try {
    snap = await snapshotSelection(doc, { blockId: s.block_id, from: s.from, to: s.to });
  } catch (e) {
    if (e instanceof SelectionError) throw new DomainError('INVALID', e.message, 'selection', { details: { reason: e.code } });
    throw e;
  }
  if (snap.expected_block_hash !== s.expected_block_hash || snap.selected_slice_hash !== s.selected_slice_hash) {
    throw new DomainError('CONFLICT', 'the selection does not match the stored revision (it changed or was computed differently); select again', 'selection', { details: { reason: 'SELECTION_MISMATCH' } });
  }
  return { doc, snap, documentId: a.documentId, revisionId: a.baseRevisionId };
}

export async function createSelectionHandle(db: Queryable, a: { paperId: string; documentId: unknown; ownerId: string; baseRevisionId: unknown; selection: unknown }): Promise<SelectionHandle> {
  const { snap } = await verifySelection(db, a);
  const { rows } = await db.query<SelectionHandle>(
    `INSERT INTO selection_handles (paper_id, document_id, base_revision_id, block_id, from_pos, to_pos, expected_block_hash, selected_slice_hash, quote, atoms, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${HANDLE}`,
    [a.paperId, a.documentId, a.baseRevisionId, snap.block_id, snap.from, snap.to, snap.expected_block_hash, snap.selected_slice_hash, snap.quote, JSON.stringify(snap.atoms), a.ownerId],
  );
  return rows[0]!;
}

// The stored text of a handle as replacement items (text runs with their marks, atoms as
// preserve_atom): what an AI receives and edits; it can never carry positions or new atoms.
export async function selectionSlice(db: Queryable, paperId: string, handleId: string) {
  const h = await getSelectionHandle(db, paperId, handleId);
  if (!h) throw new DomainError('NOT_FOUND', 'selection handle not found');
  const doc = await storedDoc(db, paperId, h.document_id, h.base_revision_id);
  const { node: block } = findBlock(doc!, h.block_id);
  const items: ({ type: 'text'; text: string; marks?: string[] } | { type: 'preserve_atom'; atom_index: number })[] = [];
  let atom = 0;
  block.content.cut(h.from_pos, h.to_pos).forEach((n) => {
    if (n.isText) items.push(n.marks.length ? { type: 'text', text: n.text!, marks: n.marks.map((m) => m.type.name) } : { type: 'text', text: n.text! });
    else items.push({ type: 'preserve_atom', atom_index: atom++ });
  });
  return { handle: h, items };
}

export async function getSelectionHandle(db: Queryable, paperId: string, handleId: string): Promise<SelectionHandle | null> {
  if (!UUID_RE.test(handleId)) return null;
  const { rows } = await db.query<SelectionHandle>(`SELECT ${HANDLE} FROM selection_handles WHERE paper_id = $1 AND id = $2`, [paperId, handleId]);
  return rows[0] ?? null;
}

export interface Proposal {
  id: string; paper_id: string; document_id: string; selection_handle_id: string; base_revision_id: string; outline_revision_id: string | null;
  intent: ProposalIntent; mode: 'preapproval' | 'approved_outline'; replacement: unknown[]; proposal: Record<string, unknown>; proposal_hash: string;
  checks: CheckResult[]; explanation: string | null; origin: string; status: ProposalStatus; status_reason: string | null;
  applied_revision_id: string | null; decided_by: string | null; decided_at: string | null; created_at: string;
}
const PROPOSAL = 'id, paper_id, document_id, selection_handle_id, base_revision_id, outline_revision_id, intent, mode, replacement, proposal, proposal_hash, checks, explanation, origin, status, status_reason, applied_revision_id, decided_by, decided_at, created_at';

// Creates a proposal for a stored handle from an AI replacement (or another non-canonical source).
// Never throws for check failures or staleness: those are recorded so the user sees why.
type ProposalInput = { paperId: string; handleId: string; intent: unknown; replacement: unknown; explanation?: unknown; origin: string; id?: string };

export async function createProposal(pool: TxPool, a: ProposalInput): Promise<Proposal> {
  return inTransaction(pool, (tx) => createProposalIn(tx, a));
}

// The same inside a caller's transaction (e.g. a job's fenced completion: a cancelled run leaves nothing).
export async function createProposalIn(tx: Queryable, a: ProposalInput): Promise<Proposal> {
  if (!PROPOSAL_INTENTS.includes(a.intent as ProposalIntent)) throw new DomainError('INVALID', `intent must be one of ${PROPOSAL_INTENTS.join(', ')}`, 'intent');
  const intent = a.intent as ProposalIntent;
  if (a.explanation !== undefined && a.explanation !== null && (typeof a.explanation !== 'string' || a.explanation.length > 4000 || !storable(a.explanation))) throw new DomainError('INVALID', 'explanation must be text up to 4000 characters', 'explanation');
  {
    await setActor(tx, a.origin);
    const handle = await getSelectionHandle(tx, a.paperId, a.handleId);
    if (!handle) throw new DomainError('NOT_FOUND', 'selection handle not found');
    // the approval state at creation decides the mode (RFC-003): the same condition as the draft gate
    // (PW-010): an APPROVED outline built on the active, APPROVED story. An outline waiting for impact
    // review after a story change does not count.
    const outline = await approvedOutline(tx, a.paperId);
    if (!outline && !PREAPPROVAL_INTENTS.includes(intent)) {
      throw new DomainError('FORBIDDEN', 'academic rewrite needs an approved outline; before approval only grammar and concise corrections are allowed', 'intent', { details: { reason: 'OUTLINE_NOT_APPROVED' } });
    }
    const doc = await storedDoc(tx, a.paperId, handle.document_id, handle.base_revision_id);
    const { node: block } = findBlock(doc!, handle.block_id);
    let newBlock;
    try {
      newBlock = replaceInBlock(block, handle.from_pos, handle.to_pos, buildReplacement(a.replacement, atomNodesIn(block, handle.from_pos, handle.to_pos)));
    } catch (e) {
      if (e instanceof ReplacementError) throw new DomainError('INVALID', e.message, 'replacement');
      throw e;
    }
    // the checks compare the whole paragraph before and after: a replacement next to a number or unit
    // (e.g. only the "." of 2.5, or the "m" of mg) changes that quantity even though the slice has none
    const children = (n: typeof block) => { const out: (typeof block)[] = []; n.forEach((c) => out.push(c)); return out; };
    const checks = checkReplacement(children(block), children(newBlock), intent);
    const head = (await tx.query<{ head_revision_id: string }>('SELECT head_revision_id FROM documents WHERE paper_id = $1 AND id = $2', [a.paperId, handle.document_id])).rows[0]!.head_revision_id;
    const failed = checks.filter((c) => c.result === 'fail');
    const status: ProposalStatus = failed.length ? 'CHECK_FAILED' : head !== handle.base_revision_id ? 'STALE' : 'PENDING';
    const reason = failed.length ? failed.map((c) => `${c.check}: ${c.details ?? ''}`).join('; ') : status === 'STALE' ? 'the manuscript changed after the selection was made (late answer)' : null;
    const id = a.id ?? randomUUID();
    const proposal = {
      schema_version: 2,
      proposal_id: id,
      paper_id: a.paperId,
      document_id: handle.document_id,
      base_revision_id: handle.base_revision_id,
      outline_revision_id: outline,
      intent,
      operation: {
        type: 'replace_selection',
        selection_handle_id: handle.id,
        block_id: handle.block_id,
        expected_block_hash: handle.expected_block_hash,
        selected_slice_hash: handle.selected_slice_hash,
        from: handle.from_pos,
        to: handle.to_pos,
        replacement: a.replacement,
      },
      source_evidence_ids: [],
      checks,
      ...(typeof a.explanation === 'string' ? { explanation: a.explanation } : {}),
    };
    const { rows } = await tx.query<Proposal>(
      `INSERT INTO edit_proposals (id, paper_id, document_id, selection_handle_id, base_revision_id, outline_revision_id, intent, mode, replacement, proposal, proposal_hash, checks, explanation, origin, status, status_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING ${PROPOSAL}`,
      [id, a.paperId, handle.document_id, handle.id, handle.base_revision_id, outline, intent, outline ? 'approved_outline' : 'preapproval',
        JSON.stringify(a.replacement), JSON.stringify(proposal), sha256(canonicalJson(proposal)), JSON.stringify(checks),
        typeof a.explanation === 'string' ? a.explanation : null, a.origin, status, reason],
    );
    return rows[0]!;
  }
}

export async function getProposal(db: Queryable, paperId: string, proposalId: string): Promise<Proposal | null> {
  if (!UUID_RE.test(proposalId)) return null;
  const { rows } = await db.query<Proposal>(`SELECT ${PROPOSAL} FROM edit_proposals WHERE paper_id = $1 AND id = $2`, [paperId, proposalId]);
  return rows[0] ?? null;
}

export async function listProposals(db: Queryable, paperId: string, documentId: string, status?: string): Promise<Proposal[]> {
  if (!UUID_RE.test(documentId)) return [];
  const { rows } = await db.query<Proposal>(
    `SELECT ${PROPOSAL} FROM edit_proposals WHERE paper_id = $1 AND document_id = $2 AND ($3::text IS NULL OR status = $3) ORDER BY created_at DESC LIMIT 200`,
    [paperId, documentId, status ?? null]);
  return rows;
}

// The block with [from, to) replaced (adjacent text with the same marks is joined, as in the editor).
function replaceInBlock(block: ReturnType<typeof atomNodesIn>[number], from: number, to: number, replacement: ReturnType<typeof atomNodesIn>) {
  const children: typeof replacement = [];
  block.content.cut(0, from).forEach((n) => children.push(n));
  children.push(...replacement);
  block.content.cut(to).forEach((n) => children.push(n));
  return block.type.create(block.attrs, children, block.marks);
}

export async function approvedOutline(tx: Queryable, paperId: string): Promise<string | null> {
  const lock = await tx.query('SELECT 1 FROM paper_projects WHERE id = $1 FOR SHARE', [paperId]);
  if (!lock.rows[0]) throw new DomainError('NOT_FOUND', 'paper not found');
  const { rows } = await tx.query<{ id: string }>(
    `SELECT o.id FROM paper_projects p
     JOIN story_revisions s ON s.id = p.active_story_revision_id AND s.status = 'APPROVED'
     JOIN outline_revisions o ON o.id = p.active_outline_revision_id AND o.status = 'APPROVED' AND o.story_revision_id = p.active_story_revision_id
     WHERE p.id = $1`, [paperId]);
  return rows[0]?.id ?? null;
}

// The document after applying a proposal to its base revision (also used for the diff preview).
async function appliedDocument(db: Queryable, p: Proposal) {
  const doc = await storedDoc(db, p.paper_id, p.document_id, p.base_revision_id);
  const op = p.proposal.operation as { block_id: string; from: number; to: number; expected_block_hash: string; selected_slice_hash: string };
  const handle = (await getSelectionHandle(db, p.paper_id, p.selection_handle_id))!;
  // re-verify the stored handle against the base revision before touching anything
  const snap = await snapshotSelection(doc!, { blockId: op.block_id, from: op.from, to: op.to });
  if (snap.expected_block_hash !== handle.expected_block_hash || snap.selected_slice_hash !== handle.selected_slice_hash) {
    throw new DomainError('CONFLICT', 'the selection no longer matches its revision', undefined, { details: { reason: 'SELECTION_MISMATCH' } });
  }
  const { node: block } = findBlock(doc!, op.block_id);
  const newBlock = replaceInBlock(block, op.from, op.to, buildReplacement(p.replacement, atomNodesIn(block, op.from, op.to)));
  const blocks: (typeof block)[] = [];
  doc!.forEach((n) => blocks.push(n.attrs.id === op.block_id ? newBlock : n));
  const result = doc!.type.create(doc!.attrs, blocks).toJSON();
  const valid = validateDocument(result, EDITOR_SCHEMA_VERSION);
  if (!valid.ok) throw new DomainError('INVALID', 'the proposal would produce an invalid document', undefined, { details: { errors: valid.errors } });
  return { before: block.toJSON(), after: newBlock.toJSON(), content: result };
}

export async function previewProposal(db: Queryable, paperId: string, proposalId: string) {
  const p = await getProposal(db, paperId, proposalId);
  if (!p) return null;
  const { before, after } = await appliedDocument(db, p);
  return { proposal: p, before_block: before, after_block: after };
}

export interface ApplyResult { proposal: Proposal; revision: { id: string; parent_revision_id: string; content_json: unknown; content_hash: string }; replayed: boolean }

export async function applyProposal(pool: TxPool, a: { paperId: string; proposalId: string; ownerId: string; proposalHash: unknown; expectedRevisionId: unknown; idempotencyKey: unknown }): Promise<ApplyResult> {
  if (typeof a.idempotencyKey !== 'string' || !KEY_RE.test(a.idempotencyKey)) throw new DomainError('INVALID', 'idempotency_key must be 16–128 letters, digits, _ or -', 'idempotency_key');
  if (typeof a.proposalHash !== 'string' || !HEX64.test(a.proposalHash)) throw new DomainError('INVALID', 'proposal_hash is required', 'proposal_hash');
  if (typeof a.expectedRevisionId !== 'string' || !UUID_RE.test(a.expectedRevisionId)) throw new DomainError('INVALID', 'expected_revision_id is required', 'expected_revision_id');
  return inTransaction(pool, async (tx) => {
    await setActor(tx, `owner:${a.ownerId}`);
    const p0 = await getProposal(tx, a.paperId, a.proposalId);
    if (!p0) throw new DomainError('NOT_FOUND', 'proposal not found');
    // one apply at a time per document: lock the document, then re-read the proposal under the lock
    const head = (await tx.query<{ head_revision_id: string }>('SELECT head_revision_id FROM documents WHERE paper_id = $1 AND id = $2 FOR UPDATE', [a.paperId, p0.document_id])).rows[0]!.head_revision_id;
    const p = (await tx.query<Proposal>(`SELECT ${PROPOSAL} FROM edit_proposals WHERE paper_id = $1 AND id = $2 FOR UPDATE`, [a.paperId, a.proposalId])).rows[0]!;
    const prior = (await tx.query<{ proposal_id: string; result_revision_id: string }>('SELECT proposal_id, result_revision_id FROM proposal_applies WHERE paper_id = $1 AND idempotency_key = $2', [a.paperId, a.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.proposal_id !== p.id) throw new DomainError('CONFLICT', 'this idempotency key was used for another proposal', 'idempotency_key');
      return { proposal: p, revision: await revisionMeta(tx, a.paperId, prior.result_revision_id), replayed: true };
    }
    if (p.status === 'APPLIED') throw new DomainError('CONFLICT', 'the proposal was already applied', undefined, { details: { reason: 'ALREADY_APPLIED', applied_revision_id: p.applied_revision_id } });
    if (p.status !== 'PENDING') throw new DomainError('CONFLICT', `the proposal is ${p.status} and cannot be applied${p.status_reason ? ` (${p.status_reason})` : ''}`, undefined, { details: { reason: p.status } });
    if (a.proposalHash !== p.proposal_hash) throw new DomainError('CONFLICT', 'the proposal differs from the one shown; reload it', 'proposal_hash', { details: { reason: 'PROPOSAL_CHANGED' } });
    // the client names another revision than the proposal's base: refuse without changing anything
    if (a.expectedRevisionId !== p.base_revision_id) throw new DomainError('CONFLICT', 'expected_revision_id is not the revision this proposal was made for; reload it', 'expected_revision_id', { details: { reason: 'EXPECTED_REVISION_MISMATCH' } });
    if (head !== p.base_revision_id) {
      // v1: never rebase; the manuscript moved on, so this proposal is stale for good
      await tx.query("UPDATE edit_proposals SET status = 'STALE', status_reason = $3 WHERE paper_id = $1 AND id = $2", [a.paperId, p.id, 'the manuscript changed after the proposal was made']);
      return { stale: true } as never;
    }
    const { content } = await appliedDocument(tx, p);
    const revId = randomUUID();
    const { rows } = await tx.query<ApplyResult['revision']>(
      `INSERT INTO document_revisions (id, paper_id, document_id, parent_revision_id, content_json, schema_version, content_hash, created_by, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ai_apply') RETURNING id, parent_revision_id, content_json, content_hash`,
      [revId, a.paperId, p.document_id, head, JSON.stringify(content), EDITOR_SCHEMA_VERSION, contentHash(content), a.ownerId],
    );
    await tx.query('UPDATE documents SET head_revision_id = $3 WHERE paper_id = $1 AND id = $2', [a.paperId, p.document_id, revId]);
    const applied = (await tx.query<Proposal>(
      `UPDATE edit_proposals SET status = 'APPLIED', applied_revision_id = $3, decided_by = $4 WHERE paper_id = $1 AND id = $2 RETURNING ${PROPOSAL}`,
      [a.paperId, p.id, revId, a.ownerId])).rows[0]!;
    await tx.query('INSERT INTO proposal_applies (paper_id, idempotency_key, proposal_id, document_id, result_revision_id, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [a.paperId, a.idempotencyKey, p.id, p.document_id, revId, a.ownerId]);
    return { proposal: applied, revision: rows[0]!, replayed: false };
  }).then((r) => {
    if ((r as { stale?: boolean }).stale) throw new DomainError('CONFLICT', 'the manuscript changed after this proposal was made; it is now STALE and must be generated again from the current text', undefined, { details: { reason: 'STALE' } });
    return r;
  });
}

async function revisionMeta(db: Queryable, paperId: string, id: string) {
  const { rows } = await db.query<ApplyResult['revision']>('SELECT id, parent_revision_id, content_json, content_hash FROM document_revisions WHERE paper_id = $1 AND id = $2', [paperId, id]);
  return rows[0]!;
}

export async function rejectProposal(pool: TxPool, a: { paperId: string; proposalId: string; ownerId: string }): Promise<Proposal> {
  return inTransaction(pool, async (tx) => {
    await setActor(tx, `owner:${a.ownerId}`);
    const { rows } = await tx.query<Proposal>(
      `UPDATE edit_proposals SET status = 'REJECTED', decided_by = $3 WHERE paper_id = $1 AND id = $2 AND status = 'PENDING' RETURNING ${PROPOSAL}`,
      [a.paperId, a.proposalId, a.ownerId]);
    if (rows[0]) return rows[0];
    const p = await getProposal(tx, a.paperId, a.proposalId);
    if (!p) throw new DomainError('NOT_FOUND', 'proposal not found');
    throw new DomainError('CONFLICT', `the proposal is ${p.status} and cannot be rejected`, undefined, { details: { reason: p.status } });
  });
}

// ---- Undo of an applied edit (PW-021) -------------------------------------------------------------
// Undo puts the paragraph an applied proposal changed back to its state before the proposal, as a new
// head revision (reason 'undo'); nothing is deleted. Only while that paragraph is still exactly as the
// proposal left it: otherwise later work would be lost, and the owner restores or edits by hand instead.
// Other paragraphs keep their later edits. One undo per proposal.
type RawBlock = { type?: string; attrs?: { id?: unknown } };
const rawBlocks = (content: unknown) => (((content as { content?: unknown[] })?.content ?? []) as RawBlock[]);
const rawBlock = (content: unknown, id: string) => rawBlocks(content).find((b) => b.attrs?.id === id) ?? null;

async function undoState(db: Queryable, p: Proposal, headContent: unknown) {
  const handle = (await getSelectionHandle(db, p.paper_id, p.selection_handle_id))!;
  const base = (await getRevision(db, p.paper_id, p.document_id, p.base_revision_id))!;
  const applied = (await getRevision(db, p.paper_id, p.document_id, p.applied_revision_id!))!;
  const before = rawBlock(base.content_json, handle.block_id);
  const after = rawBlock(applied.content_json, handle.block_id);
  const now = rawBlock(headContent, handle.block_id);
  const unchanged = !!after && !!now && canonicalJson(after) === canonicalJson(now);
  return { blockId: handle.block_id, before, after, unchanged };
}

export async function undoProposal(pool: TxPool, a: { paperId: string; proposalId: string; ownerId: string; expectedHead: unknown }) {
  if (!UUID_RE.test(a.proposalId)) throw new DomainError('NOT_FOUND', 'proposal not found');
  return inTransaction(pool, async (tx) => {
    await setActor(tx, `owner:${a.ownerId}`);
    const p = await getProposal(tx, a.paperId, a.proposalId);
    if (!p) throw new DomainError('NOT_FOUND', 'proposal not found');
    // the same lock order as apply: document head first
    const head = await lockDocumentHead(tx, a.paperId, p.document_id, a.expectedHead);
    const fresh = (await tx.query<Proposal>(`SELECT ${PROPOSAL} FROM edit_proposals WHERE id = $1`, [p.id])).rows[0]!;
    if (fresh.status !== 'APPLIED' || !fresh.applied_revision_id) throw new DomainError('CONFLICT', 'only an applied proposal can be undone', undefined, { details: { reason: 'NOT_APPLIED' } });
    if ((await tx.query('SELECT 1 FROM proposal_undos WHERE proposal_id = $1', [p.id])).rows[0]) throw new DomainError('CONFLICT', 'this edit was already undone', undefined, { details: { reason: 'ALREADY_UNDONE' } });
    const headRev = (await getRevision(tx, a.paperId, p.document_id, head))!;
    const st = await undoState(tx, fresh, headRev.content_json);
    if (!st.unchanged || !st.before) {
      throw new DomainError('CONFLICT', 'the paragraph changed after this edit was applied; compare versions and restore or edit it by hand', undefined, { details: { reason: 'CHANGED_SINCE_APPLY' } });
    }
    const content = { ...headRev.content_json, content: rawBlocks(headRev.content_json).map((b) => (b.attrs?.id === st.blockId ? st.before : b)) };
    const revision = await appendRevisionIn(tx, { paperId: a.paperId, documentId: p.document_id, parent: head, content, schemaVersion: headRev.schema_version, ownerId: a.ownerId, reason: 'undo' });
    await tx.query('INSERT INTO proposal_undos (proposal_id, paper_id, document_id, revision_id, created_by) VALUES ($1, $2, $3, $4, $5)', [p.id, a.paperId, p.document_id, revision.id, a.ownerId]);
    return { proposal: fresh, revision };
  });
}

// Applied edits of a document, newest first, with what undo would do now.
export async function listAppliedEdits(db: Queryable, paperId: string, documentId: string) {
  if (!UUID_RE.test(documentId)) return null;
  const doc = (await db.query<{ head_revision_id: string }>('SELECT head_revision_id FROM documents WHERE paper_id = $1 AND id = $2', [paperId, documentId])).rows[0];
  if (!doc) return null;
  const head = (await getRevision(db, paperId, documentId, doc.head_revision_id))!;
  const { rows } = await db.query<Proposal & { undo_revision_id: string | null }>(
    `SELECT ${PROPOSAL.split(', ').map((c) => `p.${c}`).join(', ')}, u.revision_id AS undo_revision_id FROM edit_proposals p
     LEFT JOIN proposal_undos u ON u.proposal_id = p.id
     WHERE p.paper_id = $1 AND p.document_id = $2 AND p.status = 'APPLIED' ORDER BY p.decided_at DESC, p.id LIMIT 100`, [paperId, documentId]);
  return Promise.all(rows.map(async (p) => {
    const st = await undoState(db, p, head.content_json);
    return {
      proposal_id: p.id, intent: p.intent, origin: p.origin, explanation: p.explanation, applied_revision_id: p.applied_revision_id, applied_at: p.decided_at,
      undo_revision_id: p.undo_revision_id, can_undo: !p.undo_revision_id && st.unchanged && !!st.before,
      before_block: st.before, after_block: st.after,
    };
  }));
}
