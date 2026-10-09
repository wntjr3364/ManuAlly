// Paragraph proposals from the Writer (PW-042, spec 06 "ParagraphContract", "수정 모드"; spec 04 "AI
// proposal 경로"). The owner asks for one paragraph from one approved outline node, at one place of
// one manuscript revision: a new paragraph after a block (draft), or an existing paragraph corrected
// (conservative) or rewritten (rewrite). The request passes the draft gate (PW-010/PW-040) and pins the
// base revision; the worker builds the contract and stores what the writer answered as a proposal. The
// manuscript changes only when the owner applies a PENDING proposal: same proposal hash, the base is
// still the head (otherwise it becomes STALE, never rebased), the gate still passes — one transaction.
import { randomUUID } from 'node:crypto';
import { EDITOR_SCHEMA_VERSION, ReplacementError, atomNodesIn, blockHash, buildReplacement, findBlock, parseDocument, schema, validateDocument } from '@pw/editor-core';
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '../shared/db.ts';
import { enqueueJob } from '../jobs/index.ts';
import { checkDraftGate } from '../outlines/index.ts';
import { contentHash } from '../revisions/index.ts';

export const WRITER_MODES = ['draft', 'conservative', 'rewrite'] as const;
export type WriterMode = (typeof WRITER_MODES)[number];
type PMNode = ReturnType<typeof parseDocument>;

export interface ParagraphProposal {
  id: string; paper_id: string; job_id: string; document_id: string; base_revision_id: string; outline_revision_id: string; node_id: string;
  mode: WriterMode; after_block_id: string | null; block_id: string | null; expected_block_hash: string | null;
  contract: Record<string, unknown>; contract_hash: string; paragraph: Record<string, unknown> | null; missing: string[];
  checks: { check: string; result: string; details?: string }[]; warnings: string[]; claim_ids: string[]; fact_ids: string[];
  generator: string; generator_label: string | null; proposal_hash: string; status: string; status_reason: string | null;
  applied_revision_id: string | null; new_block_id: string | null; decided_at: string | null; created_at: string;
}
const COLUMNS = `id, paper_id, job_id, document_id, base_revision_id, outline_revision_id, node_id, mode, after_block_id, block_id, expected_block_hash, contract, contract_hash,
  paragraph, missing, checks, warnings, claim_ids, fact_ids, generator, generator_label, proposal_hash, status, status_reason, applied_revision_id, new_block_id, decided_at, created_at`;

export async function documentAt(db: Queryable, paperId: string, documentId: string, revisionId: string): Promise<PMNode | null> {
  const r = (await db.query<{ content_json: unknown; schema_version: number }>('SELECT content_json, schema_version FROM document_revisions WHERE paper_id = $1 AND document_id = $2 AND id = $3', [paperId, documentId, revisionId])).rows[0];
  if (!r) return null;
  if (r.schema_version !== EDITOR_SCHEMA_VERSION) throw new DomainError('INVALID', 'this revision uses another document format and must be migrated first');
  return parseDocument(r.content_json, r.schema_version);
}
const topBlock = (doc: PMNode, id: string): PMNode | null => {
  let found: PMNode | null = null;
  doc.forEach((n) => { if (n.attrs.id === id) found = n; });
  return found;
};

// A whole paragraph as writer items: text runs with their marks, citations by reference, other atoms
// (math, figure references) as preserve_atom — never anything the writer could alter by position.
export function paragraphItems(block: PMNode) {
  const items: ({ type: 'text'; text: string; marks?: string[] } | { type: 'citation'; reference_id: string; locator: string | null } | { type: 'preserve_atom'; atom_index: number })[] = [];
  let atom = 0;
  block.forEach((n) => {
    if (n.isText) items.push(n.marks.length ? { type: 'text', text: n.text!, marks: n.marks.map((m) => m.type.name) } : { type: 'text', text: n.text! });
    else if (n.type.name === 'citation') items.push({ type: 'citation', reference_id: n.attrs.referenceId as string, locator: (n.attrs.locator as string | null) ?? null });
    else items.push({ type: 'preserve_atom', atom_index: atom++ });
  });
  return items;
}
// The paragraph a writer's items make (the block id is set when applied). For a correction, the
// original's non-citation atoms are the only ones that can be placed (preserve_atom).
export function buildParagraph(items: unknown, original: PMNode | null): PMNode {
  const atoms = original ? atomNodesIn(original, 0, original.content.size).filter((n) => n.type.name !== 'citation') : [];
  try {
    return schema.nodes.paragraph!.create({ id: original ? original.attrs.id : null }, buildReplacement(items, atoms));
  } catch (e) {
    if (e instanceof ReplacementError) throw new DomainError('INVALID', e.message, 'paragraph');
    throw e;
  }
}
export const blockText = (n: PMNode | null) => {
  if (!n) return '';
  let t = '';
  n.forEach((c) => { t += c.isText ? c.text : ' '; });
  return t.trim();
};

export async function requestParagraph(pool: TxPool, a: { paperId: string; ownerId: string; body: unknown }) {
  const b = (a.body ?? {}) as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !['mode', 'outline_revision_id', 'node_id', 'document_id', 'base_revision_id', 'after_block_id', 'block_id', 'instruction', 'idempotency_key'].includes(k));
  if (extra.length) throw new DomainError('INVALID', `unknown fields: ${extra.join(', ')}`, extra[0]);
  if (!WRITER_MODES.includes(b.mode as WriterMode)) throw new DomainError('INVALID', `mode must be one of ${WRITER_MODES.join(', ')}`, 'mode');
  const mode = b.mode as WriterMode;
  const instruction = b.instruction === undefined || b.instruction === null ? '' : b.instruction;
  if (typeof instruction !== 'string' || instruction.length > 2000) throw new DomainError('INVALID', 'instruction must be text up to 2000 characters', 'instruction');
  // the draft gate (approved story, the active approved outline, this approved node, no open impact)
  const gate = await checkDraftGate(pool, a.paperId, { instruction: instruction.trim() || `${mode} paragraph`, node_id: b.node_id, outline_revision_id: b.outline_revision_id ?? null });
  if (typeof b.document_id !== 'string' || !UUID_RE.test(b.document_id)) throw new DomainError('NOT_FOUND', 'document not found');
  const doc = (await pool.query<{ head_revision_id: string }>('SELECT head_revision_id FROM documents WHERE paper_id = $1 AND id = $2', [a.paperId, b.document_id])).rows[0];
  if (!doc) throw new DomainError('NOT_FOUND', 'document not found');
  if (b.base_revision_id !== doc.head_revision_id) throw new DomainError('CONFLICT', 'base_revision_id is not the current manuscript; reload it', 'base_revision_id', { details: { reason: 'STALE_BASE' } });
  const content = (await documentAt(pool, a.paperId, b.document_id, doc.head_revision_id))!;
  const id = (v: unknown, field: string) => {
    if (typeof v !== 'string' || !UUID_RE.test(v)) throw new DomainError('INVALID', `${field} must name a block of the manuscript`, field);
    const n = topBlock(content, v.toLowerCase());
    if (!n) throw new DomainError('INVALID', `${field} is not a block of this revision`, field);
    return n;
  };
  let place: { after_block_id: string | null; block_id: string | null; expected_block_hash: string | null };
  if (mode === 'draft') {
    if (b.block_id !== undefined && b.block_id !== null) throw new DomainError('INVALID', 'a new paragraph is placed with after_block_id', 'block_id');
    place = { after_block_id: b.after_block_id === undefined || b.after_block_id === null ? null : (id(b.after_block_id, 'after_block_id').attrs.id as string), block_id: null, expected_block_hash: null };
  } else {
    if (b.after_block_id !== undefined && b.after_block_id !== null) throw new DomainError('INVALID', 'a correction names the paragraph with block_id', 'after_block_id');
    const n = id(b.block_id, 'block_id');
    if (n.type.name !== 'paragraph') throw new DomainError('INVALID', 'only a paragraph can be corrected or rewritten here', 'block_id');
    place = { after_block_id: null, block_id: n.attrs.id as string, expected_block_hash: await blockHash(n) };
  }
  return enqueueJob(pool, {
    paperId: a.paperId, ownerId: a.ownerId, intent: 'draft_paragraph', idempotencyKey: b.idempotency_key,
    payload: { mode, outline_revision_id: gate.outline_revision_id, node_id: gate.node_id, document_id: b.document_id.toLowerCase(), base_revision_id: doc.head_revision_id, ...place, instruction },
  });
}

export async function insertParagraphProposalIn(tx: Queryable, p: Omit<ParagraphProposal, 'id' | 'proposal_hash' | 'status' | 'status_reason' | 'applied_revision_id' | 'new_block_id' | 'decided_at' | 'created_at'> & { status: 'PENDING' | 'CHECK_FAILED' | 'NEEDS_EVIDENCE' | 'NO_CHANGE' | 'STALE'; status_reason: string | null }) {
  const proposalHash = contentHash({ mode: p.mode, document_id: p.document_id, base_revision_id: p.base_revision_id, after_block_id: p.after_block_id, block_id: p.block_id, expected_block_hash: p.expected_block_hash, contract_hash: p.contract_hash, paragraph: p.paragraph, checks: p.checks });
  return (await tx.query<ParagraphProposal>(
    `INSERT INTO paragraph_proposals (paper_id, job_id, document_id, base_revision_id, outline_revision_id, node_id, mode, after_block_id, block_id, expected_block_hash, contract, contract_hash,
       paragraph, missing, checks, warnings, claim_ids, fact_ids, generator, generator_label, proposal_hash, status, status_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) RETURNING ${COLUMNS}`,
    [p.paper_id, p.job_id, p.document_id, p.base_revision_id, p.outline_revision_id, p.node_id, p.mode, p.after_block_id, p.block_id, p.expected_block_hash, JSON.stringify(p.contract), p.contract_hash,
      p.paragraph ? JSON.stringify(p.paragraph) : null, JSON.stringify(p.missing), JSON.stringify(p.checks), p.warnings, p.claim_ids, p.fact_ids, p.generator, p.generator_label, proposalHash, p.status, p.status_reason])).rows[0]!;
}

export async function listParagraphProposals(db: Queryable, paperId: string, documentId: unknown) {
  if (typeof documentId !== 'string' || !UUID_RE.test(documentId)) throw new DomainError('INVALID', 'document_id is required', 'document_id');
  return (await db.query<ParagraphProposal>(`SELECT ${COLUMNS} FROM paragraph_proposals WHERE paper_id = $1 AND document_id = $2 ORDER BY created_at DESC, id DESC LIMIT 100`, [paperId, documentId])).rows;
}
export async function getParagraphProposal(db: Queryable, paperId: string, id: string) {
  if (!UUID_RE.test(id)) return null;
  return (await db.query<ParagraphProposal>(`SELECT ${COLUMNS} FROM paragraph_proposals WHERE paper_id = $1 AND id = $2`, [paperId, id])).rows[0] ?? null;
}

const HEX64 = /^[0-9a-f]{64}$/;
export async function applyParagraphProposal(pool: TxPool, a: { paperId: string; ownerId: string; proposalId: string; body: unknown }) {
  const b = (a.body ?? {}) as Record<string, unknown>;
  if (b.intent !== 'apply_paragraph') throw new DomainError('INVALID', 'applying needs the explicit intent "apply_paragraph"', 'intent');
  if (Object.keys(b).some((k) => !['intent', 'proposal_hash', 'expected_revision_id'].includes(k))) throw new DomainError('INVALID', 'unknown fields', 'body');
  if (typeof b.proposal_hash !== 'string' || !HEX64.test(b.proposal_hash)) throw new DomainError('INVALID', 'proposal_hash is required', 'proposal_hash');
  if (typeof b.expected_revision_id !== 'string' || !UUID_RE.test(b.expected_revision_id)) throw new DomainError('INVALID', 'expected_revision_id is required', 'expected_revision_id');
  const p0 = await getParagraphProposal(pool, a.paperId, a.proposalId);
  if (!p0) throw new DomainError('NOT_FOUND', 'proposal not found');
  // the node may be written to only while its gate still passes (an impact may have appeared since)
  if (p0.status === 'PENDING') await checkDraftGate(pool, a.paperId, { instruction: 'apply paragraph', node_id: p0.node_id, outline_revision_id: p0.outline_revision_id });
  const out = await inTransaction(pool, async (tx) => {
    await tx.query("SELECT set_config('pw.actor', $1, true)", [`owner:${a.ownerId}`]);
    const head = (await tx.query<{ head_revision_id: string }>('SELECT head_revision_id FROM documents WHERE paper_id = $1 AND id = $2 FOR UPDATE', [a.paperId, p0.document_id])).rows[0]!.head_revision_id;
    const p = (await tx.query<ParagraphProposal>(`SELECT ${COLUMNS} FROM paragraph_proposals WHERE paper_id = $1 AND id = $2 FOR UPDATE`, [a.paperId, p0.id])).rows[0]!;
    if (p.status !== 'PENDING') throw new DomainError('CONFLICT', `the proposal is ${p.status} and cannot be applied${p.status_reason ? ` (${p.status_reason})` : ''}`, undefined, { details: { reason: p.status } });
    if (b.proposal_hash !== p.proposal_hash) throw new DomainError('CONFLICT', 'the proposal differs from the one shown; reload it', 'proposal_hash', { details: { reason: 'PROPOSAL_CHANGED' } });
    if (b.expected_revision_id !== p.base_revision_id) throw new DomainError('CONFLICT', 'expected_revision_id is not the revision this proposal was made for', 'expected_revision_id', { details: { reason: 'EXPECTED_REVISION_MISMATCH' } });
    if (head !== p.base_revision_id) {
      // never rebased: the manuscript moved on, so the proposal is stale for good (kept, not overwritten)
      await tx.query("UPDATE paragraph_proposals SET status = 'STALE', status_reason = 'the manuscript changed after the proposal was made' WHERE id = $1", [p.id]);
      return { stale: true as const };
    }
    const doc = (await documentAt(tx, a.paperId, p.document_id, head))!;
    const newId = p.mode === 'draft' ? randomUUID() : p.block_id!;
    const paragraph = schema.nodeFromJSON({ ...p.paragraph!, attrs: { id: newId } });
    const blocks: PMNode[] = [];
    if (p.mode === 'draft') {
      if (p.after_block_id === null) {
        doc.forEach((n) => blocks.push(n));
        blocks.push(paragraph);
      } else {
        doc.forEach((n) => { blocks.push(n); if (n.attrs.id === p.after_block_id) blocks.push(paragraph); });
      }
    } else {
      const { node } = findBlock(doc, p.block_id!);
      if ((await blockHash(node)) !== p.expected_block_hash) throw new DomainError('CONFLICT', 'the paragraph changed', undefined, { details: { reason: 'STALE' } });
      doc.forEach((n) => blocks.push(n.attrs.id === p.block_id ? paragraph : n));
    }
    const content = doc.type.create(doc.attrs, blocks).toJSON();
    const valid = validateDocument(content, EDITOR_SCHEMA_VERSION);
    if (!valid.ok) throw new DomainError('INVALID', 'the proposal would produce an invalid document', undefined, { details: { errors: valid.errors } });
    const revId = randomUUID();
    await tx.query(
      `INSERT INTO document_revisions (id, paper_id, document_id, parent_revision_id, content_json, schema_version, content_hash, created_by, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ai_apply')`,
      [revId, a.paperId, p.document_id, head, JSON.stringify(content), EDITOR_SCHEMA_VERSION, contentHash(content), a.ownerId]);
    await tx.query('UPDATE documents SET head_revision_id = $3 WHERE paper_id = $1 AND id = $2', [a.paperId, p.document_id, revId]);
    // the paragraph now belongs to its plan (PW-040 impacts follow it)
    await tx.query(
      `INSERT INTO outline_node_paragraphs (paper_id, outline_revision_id, node_id, document_id, block_id, origin, created_by) VALUES ($1, $2, $3, $4, $5, 'draft', $6)
       ON CONFLICT DO NOTHING`, [a.paperId, p.outline_revision_id, p.node_id, p.document_id, newId, a.ownerId]);
    const applied = (await tx.query<ParagraphProposal>(
      `UPDATE paragraph_proposals SET status = 'APPLIED', applied_revision_id = $2, new_block_id = $3, decided_by = $4, decided_at = clock_timestamp() WHERE id = $1 RETURNING ${COLUMNS}`,
      [p.id, revId, newId, a.ownerId])).rows[0]!;
    return { stale: false as const, proposal: applied, revision_id: revId, block_id: newId };
  });
  if (out.stale) throw new DomainError('CONFLICT', 'the manuscript changed after this proposal was made; it is now STALE — ask again from the current text', undefined, { details: { reason: 'STALE' } });
  return { proposal: out.proposal, revision_id: out.revision_id, block_id: out.block_id };
}

export async function rejectParagraphProposal(pool: TxPool, a: { paperId: string; ownerId: string; proposalId: string; body: unknown }) {
  const b = (a.body ?? {}) as Record<string, unknown>;
  if (b.intent !== 'reject_paragraph' || Object.keys(b).some((k) => k !== 'intent')) throw new DomainError('INVALID', 'rejecting needs the explicit intent "reject_paragraph"', 'intent');
  return inTransaction(pool, async (tx) => {
    const p = (await tx.query<{ id: string; status: string }>('SELECT id, status FROM paragraph_proposals WHERE paper_id = $1 AND id = $2 FOR UPDATE', [a.paperId, UUID_RE.test(a.proposalId) ? a.proposalId : null])).rows[0];
    if (!p) throw new DomainError('NOT_FOUND', 'proposal not found');
    if (p.status !== 'PENDING') throw new DomainError('CONFLICT', `the proposal is ${p.status}`);
    return (await tx.query<ParagraphProposal>(`UPDATE paragraph_proposals SET status = 'REJECTED', decided_by = $2, decided_at = clock_timestamp() WHERE id = $1 RETURNING ${COLUMNS}`, [p.id, a.ownerId])).rows[0]!;
  });
}
