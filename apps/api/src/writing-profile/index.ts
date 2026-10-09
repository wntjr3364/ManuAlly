// WritingProfile (PW-041): request a proposal (an AI job), read the profile and its versions, save the
// owner's own version, approve one (the owner's act), and leave feedback for the next proposal.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { addProfileFeedback, approveProfileRevision, createOwnRevision, profileView, requestProfileRun } from '@pw/domain/writing-profile/index.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerWritingProfileRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, code = 200) => {
    try {
      return reply.code(code).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  app.get('/api/papers/:paperId/writing-profile', scoped, async (req) => profileView(pool, req.paper!.id));
  app.post('/api/papers/:paperId/writing-profile/runs', scoped, async (req, reply) => {
    try {
      const out = await requestProfileRun(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, body: req.body });
      return reply.code(out.created ? 201 : 200).send(out);
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  });
  app.post('/api/papers/:paperId/writing-profile/revisions', scoped, async (req, reply) => run(reply,
    () => createOwnRevision(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, body: req.body }), 201));
  app.post('/api/papers/:paperId/writing-profile/revisions/:revisionId/approve', scoped, async (req, reply) => run(reply,
    () => approveProfileRevision(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, revisionId: (req.params as { revisionId: string }).revisionId, body: req.body })));
  app.post('/api/papers/:paperId/writing-profile/feedback', scoped, async (req, reply) => run(reply,
    () => addProfileFeedback(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, body: req.body }), 201));
}
