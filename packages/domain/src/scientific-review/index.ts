// Review of a manuscript paragraph and the owner's decisions (PW-044, spec 06 "검증 층" B·C·D).
// - The owner asks for a review of one paragraph of one revision (an AI job, 'review'). The reviewer's
//   findings — an exact span, a reason, the record it rests on, a confidence, an alternative — are
//   stored as they were checked; there is no score and nothing in the manuscript changes.
// - The owner accepts or dismisses each finding, once.
// - A repair turns the accepted findings into one Writer request (PW-042, rewrite mode) for that
//   paragraph: at most one per review (a UNIQUE row), only while the paragraph is as it was reviewed
//   and belongs to an approved plan. Its result is an ordinary paragraph proposal with all PW-042/043
//   checks, which the owner applies or not; a repair that fails goes back to the owner, never into a
//   new attempt.
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '../shared/db.ts';
import { enqueueJob } from '../jobs/index.ts';
import { checkDraftGate } from '../outlines/index.ts';
import { blockHash } from '@pw/editor-core';
import { documentAt } from '../writer/index.ts';

// the rubric a reviewer files findings under (spec 06 B: scientific reviewer; C: writing reviewer)
export const FINDING_CATEGORIES = {
  scientific: ['overclaim', 'causal_language', 'logic_gap', 'missing_counterevidence', 'negation', 'section_role', 'evidence_mismatch', 'other'],
  writing: ['repetition', 'density', 'transition', 'length', 'concision', 'genre', 'clarity', 'other'],
} as const;

const topBlock = (doc: NonNullable<Awaited<ReturnType<typeof documentAt>>>, id: string) => {
  let found: typeof doc | null = null;
  doc.forEach((n) => { if (n.attrs.id === id) found = n; });
  return found as typeof doc | null;
};

export async function requestReview(pool: TxPool, a: { paperId: string; ownerId: string; body: unknown }) {
  const b = (a.body ?? {}) as Record<string, unknown>;
  if (Object.keys(b).some((k) => !['document_id', 'revision_id', 'block_id', 'idempotency_key'].includes(k))) throw new DomainError('INVALID', 'unknown fields', 'body');
  if (typeof b.document_id !== 'string' || !UUID_RE.test(b.document_id) || typeof b.revision_id !== 'string' || !UUID_RE.test(b.revision_id)) throw new DomainError('NOT_FOUND', 'document revision not found');
  const doc = await documentAt(pool, a.paperId, b.document_id.toLowerCase(), b.revision_id.toLowerCase());
  if (!doc) throw new DomainError('NOT_FOUND', 'document revision not found');
  const block = typeof b.block_id === 'string' && UUID_RE.test(b.block_id) ? topBlock(doc, b.block_id.toLowerCase()) : null;
  if (!block || block.type.name !== 'paragraph') throw new DomainError('INVALID', 'block_id must name a paragraph of that revision', 'block_id');
  return enqueueJob(pool, { paperId: a.paperId, ownerId: a.ownerId, intent: 'review', idempotencyKey: b.idempotency_key,
    payload: { document_id: b.document_id.toLowerCase(), revision_id: b.revision_id.toLowerCase(), block_id: (b.block_id as string).toLowerCase() } });
}

interface RunRow { id: string; job_id: string; document_id: string; revision_id: string; block_id: string; block_hash: string; generator: string; generator_label: string | null; independence: string; dropped: unknown[]; created_at: string }
interface FindingRow { id: string; run_id: string; position: number; kind: string; category: string; quote: string; span_start: number; span_end: number; reason: string; source_kind: string | null; source_id: string | null; confidence: string; alternative: string | null; warnings: string[]; decision: string; note: string | null; decided_at: string | null }
const FINDING = 'id, run_id, position, kind, category, quote, span_start, span_end, reason, source_kind, source_id, confidence, alternative, warnings, decision, note, decided_at';
const findingView = ({ span_start, span_end, source_kind, source_id, run_id: _r, ...f }: FindingRow) => ({ ...f, start: span_start, end: span_end, source: source_kind ? { kind: source_kind, id: source_id! } : null });

export async function reviewView(db: Queryable, paperId: string, documentId: unknown, blockId: unknown) {
  if (typeof documentId !== 'string' || !UUID_RE.test(documentId) || typeof blockId !== 'string' || !UUID_RE.test(blockId)) throw new DomainError('INVALID', 'document_id and block_id are required', 'block_id');
  const runs = (await db.query<RunRow>(
    'SELECT id, job_id, document_id, revision_id, block_id, block_hash, generator, generator_label, independence, dropped, created_at FROM review_runs WHERE paper_id = $1 AND document_id = $2 AND block_id = $3 ORDER BY created_at DESC, id DESC LIMIT 10',
    [paperId, documentId.toLowerCase(), blockId.toLowerCase()])).rows;
  if (!runs.length) return [];
  const findings = (await db.query<FindingRow>(`SELECT ${FINDING} FROM review_findings WHERE paper_id = $1 AND run_id = ANY($2::uuid[]) ORDER BY position`, [paperId, runs.map((r) => r.id)])).rows;
  const repairs = (await db.query<{ run_id: string; job_id: string; job_status: string; proposal_id: string | null; proposal_status: string | null }>(
    `SELECT r.run_id, r.job_id, j.status AS job_status, p.id AS proposal_id, p.status AS proposal_status
     FROM review_repairs r JOIN jobs j ON j.id = r.job_id LEFT JOIN paragraph_proposals p ON p.job_id = r.job_id
     WHERE r.paper_id = $1 AND r.run_id = ANY($2::uuid[])`, [paperId, runs.map((r) => r.id)])).rows;
  // a run on an older version of the paragraph: its spans point at text that is no longer there (review NIT)
  const head = (await db.query<{ head_revision_id: string }>('SELECT head_revision_id FROM documents WHERE paper_id = $1 AND id = $2', [paperId, documentId.toLowerCase()])).rows[0];
  const now = head ? await documentAt(db, paperId, documentId.toLowerCase(), head.head_revision_id) : null;
  const current = now ? topBlock(now, blockId.toLowerCase()) : null;
  const currentHash = current ? await blockHash(current) : null;
  return runs.map((r) => {
    const rep = repairs.find((x) => x.run_id === r.id);
    return {
      ...r, status: 'DONE', outdated: r.block_hash !== currentHash,
      findings: findings.filter((f) => f.run_id === r.id).map(findingView),
      // a repair whose proposal cannot be applied as it is goes back to the owner (no further attempt)
      repair: rep ? {
        job_id: rep.job_id, job_status: rep.job_status, proposal_id: rep.proposal_id, proposal_status: rep.proposal_status,
        needs_user: ['FAILED', 'CANCELLED', 'WAITING_USER'].includes(rep.job_status) || ['CHECK_FAILED', 'NEEDS_EVIDENCE', 'NO_CHANGE', 'STALE'].includes(rep.proposal_status ?? ''),
      } : null,
    };
  });
}

export async function decideFinding(pool: TxPool, a: { paperId: string; ownerId: string; findingId: string; body: unknown }) {
  const b = (a.body ?? {}) as Record<string, unknown>;
  if (b.intent !== 'decide_finding') throw new DomainError('INVALID', 'deciding needs the explicit intent "decide_finding"', 'intent');
  if (Object.keys(b).some((k) => !['intent', 'decision', 'note'].includes(k))) throw new DomainError('INVALID', 'unknown fields', 'body');
  if (b.decision !== 'accepted' && b.decision !== 'dismissed') throw new DomainError('INVALID', 'decision must be accepted or dismissed', 'decision');
  if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.length > 1000)) throw new DomainError('INVALID', 'note must be text up to 1000 characters', 'note');
  return inTransaction(pool, async (tx) => {
    const f = (await tx.query<{ id: string; decision: string }>('SELECT id, decision FROM review_findings WHERE paper_id = $1 AND id = $2 FOR UPDATE', [a.paperId, UUID_RE.test(a.findingId) ? a.findingId : null])).rows[0];
    if (!f) throw new DomainError('NOT_FOUND', 'finding not found');
    if (f.decision !== 'open') throw new DomainError('CONFLICT', `this finding was already ${f.decision}`);
    const row = (await tx.query<FindingRow>(`UPDATE review_findings SET decision = $2, note = $3, decided_by = $4, decided_at = clock_timestamp() WHERE id = $1 RETURNING ${FINDING}`,
      [f.id, b.decision, typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null, a.ownerId])).rows[0]!;
    return findingView(row);
  });
}

export async function requestRepair(pool: TxPool, a: { paperId: string; ownerId: string; runId: string; body: unknown }) {
  const b = (a.body ?? {}) as Record<string, unknown>;
  if (b.intent !== 'repair_paragraph') throw new DomainError('INVALID', 'a repair needs the explicit intent "repair_paragraph"', 'intent');
  if (Object.keys(b).some((k) => !['intent', 'idempotency_key'].includes(k))) throw new DomainError('INVALID', 'unknown fields', 'body');
  const run = UUID_RE.test(a.runId) ? (await pool.query<RunRow>('SELECT id, job_id, document_id, revision_id, block_id, block_hash, generator, generator_label, independence, dropped, created_at FROM review_runs WHERE paper_id = $1 AND id = $2', [a.paperId, a.runId])).rows[0] : undefined;
  if (!run) throw new DomainError('NOT_FOUND', 'review not found');
  if ((await pool.query('SELECT 1 FROM review_repairs WHERE run_id = $1', [run.id])).rowCount) throw new DomainError('CONFLICT', 'this review was already used for its one repair; review the paragraph again for another', undefined, { details: { reason: 'REPAIR_USED' } });
  const accepted = (await pool.query<FindingRow>(`SELECT ${FINDING} FROM review_findings WHERE run_id = $1 AND decision = 'accepted' ORDER BY position`, [run.id])).rows;
  if (!accepted.length) throw new DomainError('INVALID', 'accept at least one finding before asking for a repair', 'findings');
  // the paragraph must belong to an approved plan (the Writer works from its contract)
  const plan = (await pool.query<{ outline_revision_id: string; node_id: string }>(
    `SELECT l.outline_revision_id, l.node_id FROM outline_node_paragraphs l JOIN paper_projects p ON p.id = l.paper_id AND p.active_outline_revision_id = l.outline_revision_id
     WHERE l.paper_id = $1 AND l.document_id = $2 AND l.block_id = $3 ORDER BY l.created_at LIMIT 1`, [a.paperId, run.document_id, run.block_id])).rows[0];
  if (!plan) throw new DomainError('INVALID', 'this paragraph is not part of an approved paragraph plan; link it to one first', 'block_id', { details: { reason: 'paragraph_not_in_plan' } });
  await checkDraftGate(pool, a.paperId, { instruction: 'repair paragraph', node_id: plan.node_id, outline_revision_id: plan.outline_revision_id });
  const instruction = [
    'Revise only what the owner accepted below. Keep every number, unit, citation, negation and direction of change.',
    ...accepted.map((f) => `- [${f.category}] "${f.quote}": ${f.reason}${f.alternative ? ` → ${f.alternative}` : ''}`),
  ].join('\n').slice(0, 2000);
  try {
    return await inTransaction(pool, async (tx) => {
      const head = (await tx.query<{ head_revision_id: string }>('SELECT head_revision_id FROM documents WHERE paper_id = $1 AND id = $2 FOR UPDATE', [a.paperId, run.document_id])).rows[0]!.head_revision_id;
      const doc = (await documentAt(tx, a.paperId, run.document_id, head))!;
      const block = topBlock(doc, run.block_id);
      // the paragraph as it was reviewed (edits elsewhere do not matter)
      if (!block || (await blockHash(block)) !== run.block_hash) throw new DomainError('CONFLICT', 'the paragraph changed since it was reviewed; review it again', undefined, { details: { reason: 'paragraph_changed' } });
      const out = await enqueueJob(tx, {
        paperId: a.paperId, ownerId: a.ownerId, intent: 'draft_paragraph', idempotencyKey: b.idempotency_key,
        payload: { mode: 'rewrite', outline_revision_id: plan.outline_revision_id, node_id: plan.node_id, document_id: run.document_id, base_revision_id: head, after_block_id: null, after_block_hash: null, block_id: run.block_id, expected_block_hash: run.block_hash, instruction },
      });
      // the key named an existing job (another repair's): say so, rather than "already repaired" (review NIT)
      if (!out.created) throw new DomainError('CONFLICT', 'this idempotency key was already used for another request', 'idempotency_key');
      await tx.query('INSERT INTO review_repairs (run_id, paper_id, job_id, finding_ids, created_by) VALUES ($1, $2, $3, $4, $5)', [run.id, a.paperId, out.job.id, accepted.map((f) => f.id), a.ownerId]);
      return out;
    });
  } catch (e) {
    // two repairs at once: the second loses on the run's one repair row
    if ((e as { code?: string }).code === '23505') throw new DomainError('CONFLICT', 'this review was already used for its one repair', undefined, { details: { reason: 'REPAIR_USED' } });
    throw e;
  }
}

export const insertReviewRunIn = async (tx: Queryable, r: Omit<RunRow, 'id' | 'created_at'> & { paper_id: string; input_hash: string }, findings: Omit<FindingRow, 'id' | 'run_id' | 'decision' | 'note' | 'decided_at'>[]) => {
  const run = (await tx.query<{ id: string }>(
    'INSERT INTO review_runs (paper_id, job_id, document_id, revision_id, block_id, block_hash, generator, generator_label, independence, input_hash, dropped) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id',
    [r.paper_id, r.job_id, r.document_id, r.revision_id, r.block_id, r.block_hash, r.generator, r.generator_label, r.independence, r.input_hash, JSON.stringify(r.dropped)])).rows[0]!;
  for (const f of findings) {
    await tx.query(
      `INSERT INTO review_findings (paper_id, run_id, position, kind, category, quote, span_start, span_end, reason, source_kind, source_id, confidence, alternative, warnings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [r.paper_id, run.id, f.position, f.kind, f.category, f.quote, f.span_start, f.span_end, f.reason, f.source_kind, f.source_id, f.confidence, f.alternative, f.warnings]);
  }
  return run.id;
};
