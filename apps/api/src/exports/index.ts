// Manuscript exports (PW-056): make one (DOCX or CSL-JSON) from the current head, list them, download one as
// it was stored. PW-057 adds the reading PDF (from the same DOCX, by the local LibreOffice) and the source
// archive made from a named snapshot for a purpose (share / private); an archive's bytes are read back from
// the asset store against their recorded hash.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { createExport, exportFile, listExports } from '@pw/exports/docx/service.ts';
import { createPdfExport } from '@pw/exports/pdf/service.ts';
import { createArchiveExport } from '@pw/exports/archive/service.ts';
import { sendDomainError } from '../auth/plugin.ts';

const TYPES: Record<string, [string, string]> = {
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'manuscript.docx'],
  csl_json: ['application/json; charset=utf-8', 'manuscript.csl.json'],
  pdf: ['application/pdf', 'manuscript.pdf'],
  source_archive: ['application/zip', 'source-archive.zip'],
};

export function registerExportRoutes(app: FastifyInstance, pool: TxPool, assets?: { dir: string }): void {
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
    const who = { paperId: req.paper!.id, ownerId: req.session!.ownerId };
    if (b.format === 'pdf') return run(reply, () => createPdfExport(pool, { ...who, documentId: b.document_id }), 201);
    if (b.format === 'source_archive') return run(reply, () => createArchiveExport(pool, { ...who, snapshotId: b.snapshot_id, purpose: b.purpose, assetDir: assets?.dir }), 201);
    return run(reply, () => createExport(pool, { ...who, documentId: b.document_id, format: b.format }), 201);
  });
  app.get('/api/papers/:paperId/exports/:exportId/file', scoped, async (req, reply) => {
    const f = await exportFile(pool, req.paper!.id, (req.params as { exportId: string }).exportId, assets?.dir);
    if (!f) return reply.code(404).send({ error: 'not_found' });
    if ('missing' in f) return reply.code(410).send({ error: 'file_missing', message: '보관된 파일이 저장소에 없거나 손상되었습니다(기록된 SHA-256과 다름). 다시 만드세요.', sha256: f.sha256 });
    const [type, name] = TYPES[f.format]!;
    const tag = f.status === 'draft_with_errors' ? '-draft' : f.status === 'incomplete' ? '-incomplete' : '';
    const purpose = f.purpose ? `-${f.purpose}` : '';
    const [base, ...ext] = name.split('.');
    return reply.header('content-type', type)
      .header('content-disposition', `attachment; filename="${base}${purpose}${tag}.${ext.join('.')}"`).header('x-content-type-options', 'nosniff').header('x-export-sha256', f.sha256).send(f.bytes);
  });
}
