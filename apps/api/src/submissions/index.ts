// Reviewer comments, responses and frozen submissions (PW-058). The domain module decides; this file gives it
// the DOCX render of a head (PW-056), named snapshots (PW-009) and the snapshot's private source archive
// (PW-057), whose own render report and DOCX hash are what the submission records.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { createSnapshot } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { openZip } from '@pw/domain/imports/docx/zip.ts';
import { addComment, checkHead, commentChanges, freezeSubmission, getSubmission, listComments, listSubmissions, respond, responseTable, type FreezeDeps, type RenderReport } from '@pw/domain/submissions/index.ts';
import { exportFile, headDocx } from '@pw/exports/docx/service.ts';
import { createArchiveExport } from '@pw/exports/archive/service.ts';
import { ARCHIVE_ZIP_LIMITS, type Manifest } from '@pw/exports/archive/index.ts';
import { sendDomainError } from '../auth/plugin.ts';

function deps(pool: TxPool, paperId: string, ownerId: string, assetDir?: string): FreezeDeps {
  return {
    async render(h) {
      return (await headDocx(pool, { paperId, ownerId, head: { content_json: h.content } })).report as unknown as RenderReport;
    },
    async snapshot(label) {
      return createSnapshot(pool, paperId, ownerId, label) as Promise<{ id: string }>;
    },
    async archive(snapshotId) {
      const rec = await createArchiveExport(pool, { paperId, ownerId, snapshotId, purpose: 'private', assetDir });
      const f = await exportFile(pool, paperId, rec.id, assetDir);
      if (!f || 'missing' in f) throw new DomainError('CONFLICT', 'the frozen archive could not be read back from the store', undefined, { details: { reason: 'ARCHIVE_UNREADABLE' } });
      const z = openZip(f.bytes, ARCHIVE_ZIP_LIMITS);
      const manifest = JSON.parse(z.read('manifest.json')!.toString('utf8')) as Manifest;
      const docx = manifest.files.find((x) => x.path === 'outputs/manuscript.docx');
      const report = z.read('outputs/manuscript.docx.report.json');
      if (!docx || !report) throw new DomainError('CONFLICT', 'the frozen archive has no manuscript output', undefined, { details: { reason: 'ARCHIVE_WITHOUT_OUTPUT' } });
      const verification = (rec.report as { verification?: { ok?: boolean } }).verification;
      return { export_id: rec.id, status: rec.status, verified: verification?.ok === true, docx_sha256: docx.sha256, report: JSON.parse(report.toString('utf8')) as RenderReport, versions: { ...manifest.versions, archive_sha256: f.sha256 } };
    },
  };
}

export function registerSubmissionRoutes(app: FastifyInstance, pool: TxPool, assets?: { dir: string }): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, code = 200) => {
    try {
      return reply.code(code).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  const who = (req: { paper?: { id: string } | null; session?: { ownerId: string } | null }) => ({ paperId: req.paper!.id, ownerId: req.session!.ownerId });
  app.get('/api/papers/:paperId/review-comments', scoped, async (req, reply) => run(reply, () => listComments(pool, req.paper!.id)));
  app.post('/api/papers/:paperId/review-comments', scoped, async (req, reply) => run(reply, () => addComment(pool, { ...who(req), body: req.body }), 201));
  app.get('/api/papers/:paperId/review-comments/:commentId/changes', scoped, async (req, reply) =>
    run(reply, () => commentChanges(pool, req.paper!.id, (req.params as { commentId: string }).commentId)));
  app.post('/api/papers/:paperId/review-comments/:commentId/responses', scoped, async (req, reply) =>
    run(reply, () => respond(pool, { ...who(req), commentId: (req.params as { commentId: string }).commentId, body: req.body }), 201));
  app.post('/api/papers/:paperId/submissions/check', scoped, async (req, reply) => {
    const w = who(req);
    return run(reply, () => checkHead(pool, { paperId: w.paperId, documentId: (req.body as { document_id?: unknown } | undefined)?.document_id }, deps(pool, w.paperId, w.ownerId, assets?.dir).render));
  });
  app.get('/api/papers/:paperId/submissions', scoped, async (req) => listSubmissions(pool, req.paper!.id));
  app.post('/api/papers/:paperId/submissions', scoped, async (req, reply) => {
    const w = who(req);
    return run(reply, () => freezeSubmission(pool, { ...w, body: req.body }, deps(pool, w.paperId, w.ownerId, assets?.dir)), 201);
  });
  app.get('/api/papers/:paperId/submissions/:submissionId/response-table', scoped, async (req, reply) => {
    const s = await getSubmission(pool, req.paper!.id, (req.params as { submissionId: string }).submissionId);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    return reply.header('content-type', 'text/markdown; charset=utf-8').header('content-disposition', 'attachment; filename="response-table.md"').header('x-content-type-options', 'nosniff').send(responseTable(s));
  });
}
