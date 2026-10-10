// A run's control state and the owner's resume (PW-054). Stop is the existing cancel route; auto-resume is
// the quota-wait route (PW-049). Resume is the owner's act: it queues a waiting job for a new run only.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { resumeJob, runControl } from '@pw/domain/run-control/index.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerRunControlRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return reply.send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  type P = { jobId: string };
  app.get('/api/papers/:paperId/jobs/:jobId/control', scoped, async (req, reply) =>
    run(reply, () => runControl(pool, req.paper!.id, (req.params as P).jobId)));
  app.post('/api/papers/:paperId/jobs/:jobId/resume', scoped, async (req, reply) =>
    run(reply, () => resumeJob(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, jobId: (req.params as P).jobId, body: req.body })));
}
