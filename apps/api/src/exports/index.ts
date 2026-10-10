// Manuscript exports (PW-056): make one (DOCX or CSL-JSON) from the current head, list them, download one as
// it was stored.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { createExport, exportFile, listExports } from '@pw/exports/docx/service.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerExportRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, code = 200) => {
    try {
      return reply.code(code).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  app.get('/api/papers/:paperId/exports', scoped, async (req) => listExports(pool, req.paper!.id));
  app.post('/api/papers/:paperId/exports', scoped, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return run(reply, () => createExport(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, documentId: b.document_id, format: b.format }), 201);
  });
  app.get('/api/papers/:paperId/exports/:exportId/file', scoped, async (req, reply) => {
    const f = await exportFile(pool, req.paper!.id, (req.params as { exportId: string }).exportId);
    if (!f) return reply.code(404).send({ error: 'not_found' });
    const ext = f.format === 'docx' ? 'docx' : 'csl.json';
    const draft = f.status === 'draft_with_errors' ? '-draft' : '';
    return reply.header('content-type', f.format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="manuscript${draft}.${ext}"`).header('x-content-type-options', 'nosniff').header('x-export-sha256', f.sha256).send(f.bytes);
  });
}
