// PDF text and confirmed evidence locations (PW-035): ask for extraction (a job), read the extracted
// pages, confirm a location from a selected quote, re-open one, and list unconfirmed candidates in
// another PDF revision. All routes are paper-scoped.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { candidatesInRevision, createAnchor, extractionView, listAnchors, requestExtraction, resolveAnchor } from '@pw/domain/pdf/index.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerPdfRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, code = 200) => {
    try {
      const out = await fn();
      return reply.code(code).send(out);
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  const assetId = (req: { params: unknown }) => (req.params as { assetId: string }).assetId;
  app.post('/api/papers/:paperId/assets/:assetId/extract', scoped, async (req, reply) => {
    try {
      const out = await requestExtraction(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, assetId: assetId(req), idempotencyKey: (req.body as { idempotency_key?: unknown } | null)?.idempotency_key });
      return reply.code(out.created ? 201 : 200).send(out);
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  });
  app.get('/api/papers/:paperId/assets/:assetId/extraction', scoped, async (req, reply) => run(reply, () => extractionView(pool, req.paper!.id, assetId(req))));
  app.get('/api/papers/:paperId/assets/:assetId/anchors', scoped, async (req, reply) => run(reply, async () => ({ anchors: await listAnchors(pool, req.paper!.id, assetId(req)) })));
  app.post('/api/papers/:paperId/assets/:assetId/anchors', scoped, async (req, reply) => run(reply, () => createAnchor(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, assetId: assetId(req), body: req.body }), 201));
  app.get('/api/papers/:paperId/anchors/:anchorId', scoped, async (req, reply) => run(reply, async () => {
    const a = await resolveAnchor(pool, req.paper!.id, (req.params as { anchorId: string }).anchorId);
    if (!a) throw new DomainError('NOT_FOUND', 'anchor not found');
    return a;
  }));
  app.get('/api/papers/:paperId/anchors/:anchorId/candidates', scoped, async (req, reply) => run(reply, () =>
    candidatesInRevision(pool, req.paper!.id, (req.params as { anchorId: string }).anchorId, String((req.query as { asset_id?: unknown }).asset_id ?? ''))));
}
