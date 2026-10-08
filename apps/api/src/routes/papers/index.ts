import type { FastifyInstance } from 'fastify';
import type { Queryable } from '@pw/domain/shared/db.ts';
import { createPaper, listPapers, setArchived, updatePaper } from '@pw/domain/papers/index.ts';
import { sendDomainError } from '../../auth/plugin.ts';

// Routes under /api/papers/:paperId are declared paperScoped; the server attaches the owner check
// (see server.ts) and exposes the loaded paper as request.paper.
export function registerPaperRoutes(app: FastifyInstance, db: Queryable): void {
  const scoped = { config: { paperScoped: true } };

  app.get('/api/papers', async (req) => {
    const q = req.query as { include?: string };
    return listPapers(db, req.session!.ownerId, { includeArchived: q.include === 'archived' });
  });

  app.post('/api/papers', async (req, reply) => {
    try {
      return reply.code(201).send(await createPaper(db, req.session!.ownerId, (req.body ?? {}) as object));
    } catch (e) {
      return sendDomainError(e, reply);
    }
  });

  app.get('/api/papers/:paperId', scoped, async (req) => req.paper);

  app.patch('/api/papers/:paperId', scoped, async (req, reply) => {
    const { expected_version, ...fields } = (req.body ?? {}) as Record<string, unknown>;
    try {
      return await updatePaper(db, req.session!.ownerId, req.paper!.id, expected_version, fields);
    } catch (e) {
      return sendDomainError(e, reply);
    }
  });

  app.post('/api/papers/:paperId/archive', scoped, async (req) => setArchived(db, req.session!.ownerId, req.paper!.id, true));
  app.post('/api/papers/:paperId/unarchive', scoped, async (req) => setArchived(db, req.session!.ownerId, req.paper!.id, false));
}
