// AI requests on a selection (PW-020, spec 04 "AI proposal 경로", spec 07 "실행 상태").
// One transaction stores the selection handle (re-derived from the stored revision) and the job; the
// worker later answers (ask) or makes a proposal (grammar/concise/rewrite). Nothing here changes the
// manuscript: a proposal is applied only by the owner (PW-017).
// RFC-003: before the outline is approved only questions and conservative corrections are accepted.
// The same idempotency key with the same request returns the first job; with another request it is refused.
import { DomainError, inTransaction, storable, type TxPool } from '../shared/db.ts';
import { contentHash } from '../revisions/index.ts';
import { enqueueJob, getJob, type Job } from '../jobs/index.ts';
import { approvedOutline, createSelectionHandle } from '../proposals/index.ts';

export const SELECTION_INTENTS = ['ask', 'grammar', 'concise', 'rewrite'] as const;
export type SelectionIntent = (typeof SELECTION_INTENTS)[number];
export const MAX_INSTRUCTION = 2000;
const QUOTE_EXCERPT = 120;

export interface SelectionJobPayload {
  request_hash: string; document_id: string; handle_id: string; intent: SelectionIntent; instruction: string; quote_excerpt: string;
}

export async function requestSelectionAi(pool: TxPool, a: {
  paperId: string; ownerId: string; documentId: unknown; baseRevisionId: unknown; selection: unknown; intent: unknown; instruction: unknown; idempotencyKey: unknown;
}): Promise<{ job: Job; created: boolean }> {
  if (!SELECTION_INTENTS.includes(a.intent as SelectionIntent)) throw new DomainError('INVALID', `intent must be one of ${SELECTION_INTENTS.join(', ')}`, 'intent');
  const intent = a.intent as SelectionIntent;
  const instruction = a.instruction ?? '';
  if (typeof instruction !== 'string' || instruction.length > MAX_INSTRUCTION || !storable(instruction)) throw new DomainError('INVALID', `instruction must be text up to ${MAX_INSTRUCTION} characters`, 'instruction');
  if (intent === 'ask' && !instruction.trim()) throw new DomainError('INVALID', 'a question needs text', 'instruction');
  if (typeof a.idempotencyKey !== 'string' || !/^[!-~]{1,200}$/.test(a.idempotencyKey)) throw new DomainError('INVALID', 'idempotency key must be 1–200 printable ASCII characters', 'idempotency_key');
  const sel = a.selection as Record<string, unknown> | null;
  const requestHash = contentHash({
    document_id: a.documentId ?? null, base_revision_id: a.baseRevisionId ?? null, intent, instruction: instruction.trim(),
    selection: sel && typeof sel === 'object' ? { block_id: sel.block_id ?? null, from: sel.from ?? null, to: sel.to ?? null, expected_block_hash: sel.expected_block_hash ?? null, selected_slice_hash: sel.selected_slice_hash ?? null } : null,
  });
  const key = a.idempotencyKey;
  const jobId = await inTransaction(pool, async (tx) => {
    await tx.query("SELECT set_config('pw.actor', $1, true)", [`owner:${a.ownerId}`]);
    // one request per (paper, key) at a time, so a resend never creates a second handle
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 20))', [`${a.paperId}:${key}`]);
    const prior = (await tx.query<{ id: string; owner_id: string; payload: { request_hash?: string } }>(
      'SELECT id, owner_id, payload FROM jobs WHERE paper_id = $1 AND idempotency_key = $2', [a.paperId, key])).rows[0];
    if (prior) {
      if (prior.owner_id !== a.ownerId || prior.payload.request_hash !== requestHash) throw new DomainError('CONFLICT', 'this idempotency key was already used for a different request', 'idempotency_key');
      return { id: prior.id, created: false };
    }
    if (intent === 'rewrite' && !(await approvedOutline(tx, a.paperId))) {
      throw new DomainError('FORBIDDEN', 'academic rewrite needs an approved outline; before approval only questions, grammar and concise corrections are allowed', 'intent', { details: { reason: 'OUTLINE_NOT_APPROVED' } });
    }
    const handle = await createSelectionHandle(tx, { paperId: a.paperId, documentId: a.documentId, ownerId: a.ownerId, baseRevisionId: a.baseRevisionId, selection: a.selection });
    if (intent !== 'ask' && !/[^\s￼]/u.test(handle.quote)) throw new DomainError('INVALID', 'select some text to correct (a citation or formula alone cannot be edited)', 'selection');
    const payload: SelectionJobPayload = {
      request_hash: requestHash, document_id: handle.document_id, handle_id: handle.id, intent, instruction: instruction.trim(),
      quote_excerpt: [...handle.quote].slice(0, QUOTE_EXCERPT).join(''),
    };
    const { job } = await enqueueJob(tx, { paperId: a.paperId, ownerId: a.ownerId, intent: intent === 'ask' ? 'ask_selection' : 'revise_selection', idempotencyKey: key, payload: { ...payload } });
    return { id: job.id, created: true };
  });
  return { job: (await getJob(pool, a.paperId, jobId.id))!, created: jobId.created };
}
