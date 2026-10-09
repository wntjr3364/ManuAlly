import type { FastifyInstance, FastifyReply } from 'fastify';
import { cancelJob, getJob, listJobs } from '@pw/domain/jobs/index.ts';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { sendDomainError } from '../../auth/plugin.ts';

// Jobs are created by the features that need them (AI draft requests, exports …), never directly
// by the client; the owner can watch and cancel them. Lease and fencing details stay internal.
export function registerJobRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const jobId = (params: unknown) => (params as { jobId: string }).jobId;
  app.get('/api/papers/:paperId/jobs', scoped, async (req) => listJobs(pool, req.paper!.id));
  app.get('/api/papers/:paperId/jobs/:jobId', scoped, async (req, reply: FastifyReply) =>
    (await getJob(pool, req.paper!.id, jobId(req.params))) ?? reply.code(404).send({ error: 'not_found' }));
  app.post('/api/papers/:paperId/jobs/:jobId/cancel', scoped, async (req, reply) => {
    try {
      return await cancelJob(pool, { paperId: req.paper!.id, jobId: jobId(req.params), ownerId: req.session!.ownerId });
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  });
}
