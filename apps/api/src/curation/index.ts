// Curation suggestions for the owner (PW-033): the latest run's assessments, and the owner's decision
// on one (accept with a use, or reject). Starting a run is an AI job (POST /jobs path of the worker).
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { curationView, decideAssessment, listSearches, requestCuration } from '@pw/domain/curation/index.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerCurationRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  app.get('/api/papers/:paperId/curation', scoped, async (req) => ({ ...(await curationView(pool, req.paper!.id)), searches: await listSearches(pool, req.paper!.id) }));
  app.post('/api/papers/:paperId/curation/runs', scoped, async (req, reply: FastifyReply) => {
    const b = (req.body ?? {}) as { search_ids?: unknown; idempotency_key?: unknown };
    try {
      const out = await requestCuration(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, searchIds: b.search_ids, idempotencyKey: b.idempotency_key });
      return reply.code(out.created ? 201 : 200).send(out);
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  });
  app.post('/api/papers/:paperId/curation/assessments/:assessmentId/decision', scoped, async (req, reply: FastifyReply) => {
    const b = (req.body ?? {}) as { decision?: unknown; use_role?: unknown };
    try {
      return await decideAssessment(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, assessmentId: (req.params as { assessmentId: string }).assessmentId, decision: b.decision, useRole: b.use_role });
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  });
}
