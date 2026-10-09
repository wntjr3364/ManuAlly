import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  createDocument, createSnapshot, getDocument, getRevision, getSnapshot, listDocuments, listRevisions, listSnapshots,
  restoreRevision, saveRevision, type TxPool,
} from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { sendDomainError } from '../../auth/plugin.ts';

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

export function registerRevisionRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, status = 200) => {
    try {
      return reply.code(status).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };

  app.get('/api/papers/:paperId/documents', scoped, async (req) => listDocuments(pool, req.paper!.id));
  app.post('/api/papers/:paperId/documents', scoped, async (req, reply) =>
    run(reply, () => createDocument(pool, req.paper!.id, req.session!.ownerId, (req.body as { kind?: unknown } | undefined)?.kind), 201));

  app.get('/api/papers/:paperId/documents/:documentId', scoped, async (req, reply) => {
    const d = await getDocument(pool, req.paper!.id, (req.params as { documentId: string }).documentId);
    return d ?? notFound(reply);
  });
  app.get('/api/papers/:paperId/documents/:documentId/revisions', scoped, async (req, reply) => {
    const { documentId } = req.params as { documentId: string };
    if (!(await getDocument(pool, req.paper!.id, documentId))) return notFound(reply);
    return listRevisions(pool, req.paper!.id, documentId);
  });
  app.get('/api/papers/:paperId/documents/:documentId/revisions/:revisionId', scoped, async (req, reply) => {
    const { documentId, revisionId } = req.params as { documentId: string; revisionId: string };
    return (await getRevision(pool, req.paper!.id, documentId, revisionId)) ?? notFound(reply);
  });
  app.post('/api/papers/:paperId/documents/:documentId/revisions', scoped, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    // saveRevision validates the content with editor-core (the same rules the browser runs)
    return run(reply, () => saveRevision(pool, {
      paperId: req.paper!.id, documentId: (req.params as { documentId: string }).documentId, ownerId: req.session!.ownerId,
      expectedHead: b.expected_head_revision_id, content: b.content_json, schemaVersion: b.schema_version, reason: b.reason,
    }), 201);
  });
  app.post('/api/papers/:paperId/documents/:documentId/restore', scoped, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return run(reply, () => restoreRevision(pool, {
      paperId: req.paper!.id, documentId: (req.params as { documentId: string }).documentId, ownerId: req.session!.ownerId,
      revisionId: b.revision_id, expectedHead: b.expected_head_revision_id,
    }), 201);
  });

  app.get('/api/papers/:paperId/snapshots', scoped, async (req) => listSnapshots(pool, req.paper!.id));
  app.post('/api/papers/:paperId/snapshots', scoped, async (req, reply) =>
    run(reply, () => createSnapshot(pool, req.paper!.id, req.session!.ownerId, (req.body as { label?: unknown } | undefined)?.label), 201));
  app.get('/api/papers/:paperId/snapshots/:snapshotId', scoped, async (req, reply) =>
    (await getSnapshot(pool, req.paper!.id, (req.params as { snapshotId: string }).snapshotId)) ?? notFound(reply));
}
