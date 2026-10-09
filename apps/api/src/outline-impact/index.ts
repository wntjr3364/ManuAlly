// Outline change impact (PW-040): the impacts on a revision's nodes, the owner's review of one, the
// generation scope of an approved node, and links between nodes and manuscript paragraphs.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { linkParagraph, listImpacts, nodeScope, resolveImpact, unlinkParagraph } from '@pw/domain/outline-impact/index.ts';
import { settledMaterial } from '@pw/search/retrieval/index.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerOutlineImpactRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, code = 200) => {
    try {
      const out = await fn();
      return out === undefined ? reply.code(204).send() : reply.code(code).send(out);
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  type P = { revisionId: string; nodeId: string; documentId: string; blockId: string };
  app.get('/api/papers/:paperId/outline/revisions/:revisionId/impacts', scoped, async (req, reply) =>
    run(reply, () => listImpacts(pool, req.paper!.id, (req.params as P).revisionId)));
  app.post('/api/papers/:paperId/outline/revisions/:revisionId/impacts/resolve', scoped, async (req, reply) =>
    run(reply, () => resolveImpact(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, outlineRevisionId: (req.params as P).revisionId, body: req.body }), 201));
  app.get('/api/papers/:paperId/outline/revisions/:revisionId/nodes/:nodeId/scope', scoped, async (req, reply) =>
    run(reply, async () => {
      // the scope as it may go to this provider (?provider=claude_agent|codex; default: the local MOCK)
      const provider = (req.query as { provider?: string }).provider ?? 'mock';
      if (!['mock', 'claude_agent', 'codex'].includes(provider)) throw new DomainError('INVALID', 'unknown provider', 'provider');
      return nodeScope(pool, req.paper!.id, (req.params as P).revisionId, (req.params as P).nodeId, await settledMaterial(pool, req.paper!.id, provider));
    }));
  app.post('/api/papers/:paperId/outline/revisions/:revisionId/nodes/:nodeId/paragraphs', scoped, async (req, reply) =>
    run(reply, () => linkParagraph(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, outlineRevisionId: (req.params as P).revisionId, nodeId: (req.params as P).nodeId, body: req.body }), 201));
  app.delete('/api/papers/:paperId/outline/revisions/:revisionId/nodes/:nodeId/paragraphs/:documentId/:blockId', scoped, async (req, reply) =>
    run(reply, async () => { const x = req.params as P; await unlinkParagraph(pool, { paperId: req.paper!.id, outlineRevisionId: x.revisionId, nodeId: x.nodeId, documentId: x.documentId, blockId: x.blockId }); }));
}
