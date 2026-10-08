import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  OutlineError, approveOutlineRevision, approveStoryRevision, checkDraftGate, createOutlineRevision, createStoryRevision,
  getOutline, getOutlineRevision, getStory, getStoryRevision,
} from '@pw/domain/outlines/index.ts';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { sendDomainError } from '../../auth/plugin.ts';

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const STATUS = { NOT_FOUND: 404, CONFLICT: 409, INVALID: 422, FORBIDDEN: 403 } as const;

export function registerOutlineRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, status = 200) => {
    try {
      return reply.code(status).send(await fn());
    } catch (e) {
      if (e instanceof OutlineError) return reply.code(STATUS[e.code]).send({ error: e.code.toLowerCase(), message: e.message, field: e.field ?? null, ...e.details });
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  const body = (b: unknown) => (b ?? {}) as Record<string, unknown>;
  const param = (p: unknown, k: string) => (p as Record<string, string>)[k]!;

  app.get('/api/papers/:paperId/story', scoped, async (req) => getStory(pool, req.paper!.id));
  app.get('/api/papers/:paperId/story/revisions/:revisionId', scoped, async (req, reply) =>
    (await getStoryRevision(pool, req.paper!.id, param(req.params, 'revisionId'))) ?? notFound(reply));
  app.post('/api/papers/:paperId/story/revisions', scoped, async (req, reply) => {
    const b = body(req.body);
    return run(reply, () => createStoryRevision(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, parent: b.parent_revision_id, brief: b.brief, story: b.story }), 201);
  });
  app.post('/api/papers/:paperId/story/revisions/:revisionId/approve', scoped, async (req, reply) =>
    run(reply, () => approveStoryRevision(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, revisionId: param(req.params, 'revisionId'), body: req.body })));

  app.get('/api/papers/:paperId/outline', scoped, async (req) => getOutline(pool, req.paper!.id));
  app.get('/api/papers/:paperId/outline/revisions/:revisionId', scoped, async (req, reply) =>
    (await getOutlineRevision(pool, req.paper!.id, param(req.params, 'revisionId'))) ?? notFound(reply));
  app.post('/api/papers/:paperId/outline/revisions', scoped, async (req, reply) => {
    const b = body(req.body);
    return run(reply, () => createOutlineRevision(pool, {
      paperId: req.paper!.id, ownerId: req.session!.ownerId, parent: b.parent_revision_id, storyRevisionId: b.story_revision_id, nodes: b.nodes,
    }), 201);
  });
  app.post('/api/papers/:paperId/outline/revisions/:revisionId/approve', scoped, async (req, reply) =>
    run(reply, () => approveOutlineRevision(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, revisionId: param(req.params, 'revisionId'), body: req.body })));

  // Gate only: PW-013 adds the job queue and P03 the provider call behind it.
  app.post('/api/papers/:paperId/ai/draft-requests', scoped, async (req, reply) => run(reply, () => checkDraftGate(pool, req.paper!.id, req.body), 202));
}
