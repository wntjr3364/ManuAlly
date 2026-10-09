// Story alternatives (PW-039): request a run (an AI job), read the checked alternatives, adopt one into
// a new DRAFT story revision (the owner's decision; approval stays the separate PW-010 step).
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { adoptStoryAlternative, requestStoryAlternatives, storyAlternativesView } from '@pw/domain/story-ai/index.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerStoryAiRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, code = 200) => {
    try {
      return reply.code(code).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  app.get('/api/papers/:paperId/story-alternatives', scoped, async (req) => storyAlternativesView(pool, req.paper!.id));
  app.post('/api/papers/:paperId/story-alternatives/runs', scoped, async (req, reply) => {
    const b = (req.body ?? {}) as { base_story_revision_id?: unknown; idempotency_key?: unknown };
    try {
      const out = await requestStoryAlternatives(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, baseStoryRevisionId: b.base_story_revision_id, idempotencyKey: b.idempotency_key });
      return reply.code(out.created ? 201 : 200).send(out);
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  });
  app.post('/api/papers/:paperId/story-alternatives/:alternativeId/adopt', scoped, async (req, reply) => run(reply,
    () => adoptStoryAlternative(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, alternativeId: (req.params as { alternativeId: string }).alternativeId, body: req.body }), 201));
}
