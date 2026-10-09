// Selection handles, proposals and apply (PW-017). Proposals are created by the AI worker (PW-020),
// never by this API: the browser can create selection handles, read proposals, and apply or reject.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { applyProposal, createSelectionHandle, getProposal, listAppliedEdits, listProposals, previewProposal, rejectProposal, undoProposal } from '@pw/domain/proposals/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { sendDomainError } from '../auth/plugin.ts';

const STATUSES = ['PENDING', 'APPLIED', 'REJECTED', 'STALE', 'CHECK_FAILED'];

export function registerProposalRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, status = 200) => {
    try {
      return reply.code(status).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };

  app.post('/api/papers/:paperId/documents/:documentId/selection-handles', scoped, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return run(reply, () => createSelectionHandle(pool, {
      paperId: req.paper!.id, documentId: (req.params as { documentId: string }).documentId, ownerId: req.session!.ownerId,
      baseRevisionId: b.base_revision_id, selection: b.selection,
    }), 201);
  });

  // applied edits and their undo (PW-021)
  app.get('/api/papers/:paperId/documents/:documentId/applied-edits', scoped, async (req, reply) =>
    (await listAppliedEdits(pool, req.paper!.id, (req.params as { documentId: string }).documentId)) ?? reply.code(404).send({ error: 'not_found' }));
  app.post('/api/papers/:paperId/proposals/:proposalId/undo', scoped, async (req, reply) =>
    run(reply, () => undoProposal(pool, {
      paperId: req.paper!.id, proposalId: (req.params as { proposalId: string }).proposalId, ownerId: req.session!.ownerId,
      expectedHead: ((req.body ?? {}) as Record<string, unknown>).expected_head_revision_id,
    }), 201));

  app.get('/api/papers/:paperId/documents/:documentId/proposals', scoped, async (req, reply) => {
    const status = (req.query as { status?: string }).status;
    if (status !== undefined && !STATUSES.includes(status)) return reply.code(422).send({ error: 'invalid', message: `status must be one of ${STATUSES.join(', ')}`, field: 'status' });
    return listProposals(pool, req.paper!.id, (req.params as { documentId: string }).documentId, status);
  });

  app.get('/api/papers/:paperId/proposals/:proposalId', scoped, async (req, reply) =>
    run(reply, async () => {
      const id = (req.params as { proposalId: string }).proposalId;
      const p = await getProposal(pool, req.paper!.id, id);
      if (!p) throw new DomainError('NOT_FOUND', 'proposal not found');
      // the diff is only computed while it can still be applied or explains a check failure
      return p.status === 'APPLIED' || p.status === 'REJECTED' ? { proposal: p } : previewProposal(pool, req.paper!.id, id);
    }));

  app.post('/api/papers/:paperId/proposals/:proposalId/apply', scoped, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const r = await applyProposal(pool, {
        paperId: req.paper!.id, proposalId: (req.params as { proposalId: string }).proposalId, ownerId: req.session!.ownerId,
        proposalHash: b.proposal_hash, expectedRevisionId: b.expected_revision_id, idempotencyKey: b.idempotency_key,
      });
      return reply.code(r.replayed ? 200 : 201).send(r);
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  });

  app.post('/api/papers/:paperId/proposals/:proposalId/reject', scoped, async (req, reply) =>
    run(reply, () => rejectProposal(pool, { paperId: req.paper!.id, proposalId: (req.params as { proposalId: string }).proposalId, ownerId: req.session!.ownerId })));
}
