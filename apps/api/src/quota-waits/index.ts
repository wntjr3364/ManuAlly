// The owner's auto-resume permission for a job and the job's quota waits (PW-049).
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { grantAutoResume, listQuotaWaits } from '@pw/domain/quota-waits/index.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerQuotaWaitRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, code = 200) => {
    try {
      return reply.code(code).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  type P = { jobId: string };
  app.post('/api/papers/:paperId/jobs/:jobId/auto-resume', scoped, async (req, reply) =>
    run(reply, () => grantAutoResume(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, jobId: (req.params as P).jobId, body: req.body }), 201));
  app.get('/api/papers/:paperId/jobs/:jobId/quota-waits', scoped, async (req, reply) =>
    run(reply, () => listQuotaWaits(pool, req.paper!.id, (req.params as P).jobId)));
}
