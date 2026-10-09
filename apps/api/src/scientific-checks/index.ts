// The deterministic scientific gate on a manuscript paragraph (PW-043): run it on one paragraph of one
// revision (the facts and claims it may use are the paper's settled ones, PW-037), and read past runs.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { checkManuscriptParagraph, listScientificChecks } from '@pw/domain/scientific-checks/records.ts';
import { LOCAL, settledMaterial } from '@pw/search/retrieval/index.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerScientificCheckRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, code = 200) => {
    try {
      return reply.code(code).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  type P = { documentId: string };
  app.post('/api/papers/:paperId/documents/:documentId/scientific-checks', scoped, async (req, reply) =>
    run(reply, async () => {
      // the gate is local (nothing is sent): settled means verified, current, not removed or retracted (PW-043 review NIT)
      const settled = await settledMaterial(pool, req.paper!.id, LOCAL);
      return checkManuscriptParagraph(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, documentId: (req.params as P).documentId, body: req.body, settled });
    }, 201));
  app.get('/api/papers/:paperId/documents/:documentId/scientific-checks', scoped, async (req, reply) =>
    run(reply, () => listScientificChecks(pool, req.paper!.id, (req.params as P).documentId, (req.query as { block_id?: string }).block_id)));
}
