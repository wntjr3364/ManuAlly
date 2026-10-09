// The Writer (PW-042): ask for one paragraph from an approved outline node (draft, conservative
// correction, scientific rewrite), read the proposals with their contract and checks, and apply or
// reject one — applying is the owner's act and the only way the manuscript changes.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { applyParagraphProposal, getParagraphProposal, listParagraphProposals, rejectParagraphProposal, requestParagraph } from '@pw/domain/writer/index.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerWriterRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, code = 200) => {
    try {
      return reply.code(code).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  type P = { id: string };
  app.post('/api/papers/:paperId/writer/requests', scoped, async (req, reply) => {
    try {
      const out = await requestParagraph(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, body: req.body });
      return reply.code(out.created ? 201 : 200).send(out);
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  });
  app.get('/api/papers/:paperId/writer/proposals', scoped, async (req, reply) =>
    run(reply, () => listParagraphProposals(pool, req.paper!.id, (req.query as { document_id?: string }).document_id)));
  app.get('/api/papers/:paperId/writer/proposals/:id', scoped, async (req, reply) =>
    run(reply, async () => {
      const p = await getParagraphProposal(pool, req.paper!.id, (req.params as P).id);
      if (!p) throw new DomainError('NOT_FOUND', 'proposal not found');
      return p;
    }));
  app.post('/api/papers/:paperId/writer/proposals/:id/apply', scoped, async (req, reply) =>
    run(reply, () => applyParagraphProposal(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, proposalId: (req.params as P).id, body: req.body })));
  app.post('/api/papers/:paperId/writer/proposals/:id/reject', scoped, async (req, reply) =>
    run(reply, () => rejectParagraphProposal(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, proposalId: (req.params as P).id, body: req.body })));
}
