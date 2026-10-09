// Text/Markdown import (PW-021): upload → preview + loss report → explicit apply.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { applyImport, createImport, getImport, listImports } from '@pw/domain/imports/text/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerImportRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, status = 200) => {
    try {
      return reply.code(status).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  const importId = (p: unknown) => (p as { importId: string }).importId;
  app.get('/api/papers/:paperId/imports', scoped, async (req) => listImports(pool, req.paper!.id));
  app.post('/api/papers/:paperId/imports', scoped, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return run(reply, () => createImport(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, format: b.format, filename: b.filename, text: b.text }), 201);
  });
  app.get('/api/papers/:paperId/imports/:importId', scoped, async (req, reply) =>
    (await getImport(pool, req.paper!.id, importId(req.params))) ?? reply.code(404).send({ error: 'not_found' }));
  app.post('/api/papers/:paperId/imports/:importId/apply', scoped, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return run(reply, () => applyImport(pool, {
      paperId: req.paper!.id, ownerId: req.session!.ownerId, importId: importId(req.params), mode: b.mode,
      documentId: b.document_id, expectedHead: b.expected_head_revision_id, confirmReplace: b.confirm_replace,
    }), 201);
  });
}
