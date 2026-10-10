// The manuscript's structure from the paper's own outline (PW-046): section suggestions for the
// paper's article type (never enforced), and the owner's "build the manuscript skeleton from the
// approved outline" (only missing headings are added; nothing the owner wrote changes).
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { scaffoldFromOutline, sectionTemplate } from '@pw/domain/manuscript-structure/index.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerManuscriptStructureRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return reply.code(200).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  app.get('/api/papers/:paperId/section-template', scoped, async (req, reply) => run(reply, async () => sectionTemplate(req.paper!.article_type)));
  app.post('/api/papers/:paperId/documents/:documentId/scaffold', scoped, async (req, reply) =>
    run(reply, () => scaffoldFromOutline(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, documentId: (req.params as { documentId: string }).documentId, body: req.body })));
}
