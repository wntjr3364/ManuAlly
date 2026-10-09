// References, figures/tables and citation style of a paper (PW-019). Owner-only, structured input.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { createFigure, createReference, getCitationStyle, listFigures, listReferences, renderReferences, reorderFigures, setCitationStyle } from '@pw/domain/references/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerReferenceRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, status = 200) => {
    try {
      return reply.code(status).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  const body = (req: { body: unknown }) => (req.body ?? {}) as Record<string, unknown>;

  app.get('/api/papers/:paperId/references', scoped, async (req) => listReferences(pool, req.paper!.id));
  app.post('/api/papers/:paperId/references', scoped, async (req, reply) => run(reply, () => createReference(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, body: req.body }), 201));
  app.get('/api/papers/:paperId/figures', scoped, async (req) => listFigures(pool, req.paper!.id));
  app.post('/api/papers/:paperId/figures', scoped, async (req, reply) => run(reply, () => createFigure(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, kind: body(req).kind, title: body(req).title }), 201));
  app.post('/api/papers/:paperId/figures/order', scoped, async (req, reply) => run(reply, () => reorderFigures(pool, { paperId: req.paper!.id, kind: body(req).kind, ids: body(req).ids })));
  app.get('/api/papers/:paperId/documents/:documentId/references-render', scoped, async (req, reply) =>
    (await renderReferences(pool, req.paper!.id, (req.params as { documentId: string }).documentId)) ?? reply.code(404).send({ error: 'not_found' }));
  app.get('/api/papers/:paperId/citation-style', scoped, async (req) => ({ style: await getCitationStyle(pool, req.paper!.id) }));
  app.post('/api/papers/:paperId/citation-style', scoped, async (req, reply) => run(reply, async () => ({ style: await setCitationStyle(pool, req.paper!.id, body(req).style) })));
}
