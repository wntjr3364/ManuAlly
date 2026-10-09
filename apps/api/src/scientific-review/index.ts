// Review of a manuscript paragraph (PW-044): request a review (an AI job), read the runs with their
// findings and repair state, decide each finding (the owner's act), and ask for the one repair.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { decideFinding, requestRepair, requestReview, reviewView } from '@pw/domain/scientific-review/index.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerScientificReviewRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, code = 200) => {
    try {
      return reply.code(code).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  const created = async (reply: FastifyReply, fn: () => Promise<{ created: boolean }>) => {
    try {
      const out = await fn();
      return reply.code(out.created ? 201 : 200).send(out);
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  app.post('/api/papers/:paperId/reviews', scoped, async (req, reply) =>
    created(reply, () => requestReview(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, body: req.body })));
  app.get('/api/papers/:paperId/reviews', scoped, async (req, reply) =>
    run(reply, () => reviewView(pool, req.paper!.id, (req.query as { document_id?: string }).document_id, (req.query as { block_id?: string }).block_id)));
  app.post('/api/papers/:paperId/reviews/findings/:id/decide', scoped, async (req, reply) =>
    run(reply, () => decideFinding(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, findingId: (req.params as { id: string }).id, body: req.body })));
  app.post('/api/papers/:paperId/reviews/:runId/repair', scoped, async (req, reply) =>
    created(reply, () => requestRepair(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, runId: (req.params as { runId: string }).runId, body: req.body })));
}
