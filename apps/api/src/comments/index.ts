// Comment threads (PW-018): start on a verified selection, reply, resolve/reopen, attach again.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { addMessage, createThread, listThreads, reanchorThread, setThreadState } from '@pw/domain/comments/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerCommentRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, status = 200) => {
    try {
      return reply.code(status).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  const tid = (req: { params: unknown }) => (req.params as { threadId: string }).threadId;

  app.get('/api/papers/:paperId/documents/:documentId/comments', scoped, async (req, reply) =>
    (await listThreads(pool, req.paper!.id, (req.params as { documentId: string }).documentId)) ?? reply.code(404).send({ error: 'not_found' }));
  app.post('/api/papers/:paperId/documents/:documentId/comments', scoped, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return run(reply, () => createThread(pool, { paperId: req.paper!.id, documentId: (req.params as { documentId: string }).documentId, ownerId: req.session!.ownerId, baseRevisionId: b.base_revision_id, selection: b.selection, body: b.body }), 201);
  });
  app.post('/api/papers/:paperId/comments/:threadId/messages', scoped, async (req, reply) =>
    run(reply, () => addMessage(pool, { paperId: req.paper!.id, threadId: tid(req), ownerId: req.session!.ownerId, body: (req.body as { body?: unknown } | undefined)?.body }), 201));
  app.post('/api/papers/:paperId/comments/:threadId/resolve', scoped, async (req, reply) =>
    run(reply, () => setThreadState(pool, { paperId: req.paper!.id, threadId: tid(req), ownerId: req.session!.ownerId, state: 'RESOLVED' })));
  app.post('/api/papers/:paperId/comments/:threadId/reopen', scoped, async (req, reply) =>
    run(reply, () => setThreadState(pool, { paperId: req.paper!.id, threadId: tid(req), ownerId: req.session!.ownerId, state: 'OPEN' })));
  app.post('/api/papers/:paperId/comments/:threadId/anchor', scoped, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return run(reply, () => reanchorThread(pool, { paperId: req.paper!.id, threadId: tid(req), ownerId: req.session!.ownerId, baseRevisionId: b.base_revision_id, selection: b.selection }));
  });
}
