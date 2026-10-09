// Figure/table versions, source evidence links, claim tracing and review flags (PW-036). Figure files
// (PNG, JPEG, CSV) are inspected by content and kept unchanged in the content-addressed store.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { putBlob } from '@pw/domain/asset-policy/store.ts';
import { safeFileName } from '@pw/domain/asset-policy/index.ts';
import { FIGURE_MEDIA, MAX_FIGURE_BYTES, addFigureVersion, inspectFigureFile, linkFigureEvidence, listFigureVersions, listReviewFlags, recordFigureFile, resolveReviewFlag, traceClaim, type FigureMedia } from '@pw/domain/figures/index.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerFigureVersionRoutes(app: FastifyInstance, pool: TxPool, assets: { dir: string } | undefined): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, code = 200) => {
    try {
      return reply.code(code).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  const param = (req: { params: unknown }, k: string) => (req.params as Record<string, string>)[k]!;

  app.register(async (scope) => {
    for (const media of FIGURE_MEDIA) scope.addContentTypeParser(media, { parseAs: 'buffer', bodyLimit: MAX_FIGURE_BYTES }, (_req, body, done) => done(null, body));
    scope.post('/api/papers/:paperId/figures/:figureId/files', { ...scoped, bodyLimit: MAX_FIGURE_BYTES }, async (req, reply) => run(reply, async () => {
      if (!assets) throw new DomainError('FORBIDDEN', 'file storage is not configured on this server');
      const media = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'unsupported_media_type', message: `send the file itself (${FIGURE_MEDIA.join(', ')})` });
      const fig = (await pool.query('SELECT 1 FROM figure_objects WHERE paper_id = $1 AND id = $2 AND archived_at IS NULL', [req.paper!.id, param(req, 'figureId')]).catch(() => ({ rowCount: 0 }))).rowCount;
      if (!fig) throw new DomainError('NOT_FOUND', 'figure not found');
      const v = inspectFigureFile(req.body, media);
      if (!v.ok) return reply.code(422).send({ error: 'invalid', reason: v.reason, message: 'the file was not accepted' });
      const sha = await putBlob(assets.dir, req.body);
      const name = String((req.query as { name?: unknown }).name ?? 'figure').split(/[\\/]/).pop()!;
      const out = await recordFigureFile(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, sha256: sha, byteSize: req.body.length, media: media as FigureMedia, name: safeFileName(name).replace(/\.pdf$/i, '') });
      return reply.code(out.created ? 201 : 200).send({ asset_id: out.id, sha256: sha, media_type: media });
    }));
  });
  app.get('/api/papers/:paperId/figures/:figureId/versions', scoped, async (req) => ({ versions: await listFigureVersions(pool, req.paper!.id, param(req, 'figureId')) }));
  app.post('/api/papers/:paperId/figures/:figureId/versions', scoped, async (req, reply) => run(reply, () => addFigureVersion(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, figureId: param(req, 'figureId'), body: req.body }), 201));
  app.post('/api/papers/:paperId/evidence/:evidenceId/figure-link', scoped, async (req, reply) => run(reply, () => linkFigureEvidence(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, evidenceId: param(req, 'evidenceId'), body: req.body }), 201));
  app.get('/api/papers/:paperId/claims/:claimId/trace', scoped, async (req, reply) => run(reply, () => traceClaim(pool, req.paper!.id, param(req, 'claimId'))));
  app.get('/api/papers/:paperId/review-flags', scoped, async (req) => ({ flags: await listReviewFlags(pool, req.paper!.id, { status: (req.query as { status?: string }).status === 'all' ? 'all' : 'open' }) }));
  app.post('/api/papers/:paperId/review-flags/:flagId/resolve', scoped, async (req, reply) => run(reply, () => resolveReviewFlag(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, flagId: param(req, 'flagId'), body: req.body })));
}
