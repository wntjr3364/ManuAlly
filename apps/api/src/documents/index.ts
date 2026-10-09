// Editor saves (PW-015). Same storage rules as POST .../revisions (editor-core validation, expected
// head, immutable revision), plus: a request that is sent again because its answer was lost is
// answered with the revision it already created (200, replayed: true) instead of a conflict.
// It is only a replay when the current head is exactly that save: made by this owner, as an editor
// save, directly on the expected head, with the same content and schema version. Anything else that
// moved the head stays a 409 conflict, so nothing is ever overwritten.
import type { FastifyInstance } from 'fastify';
import { contentHash, getDocument, saveRevision, type TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { sendDomainError } from '../auth/plugin.ts';

export const EDITOR_SAVE_REASONS = ['autosave', 'manual'] as const;

export function registerDocumentSaveRoutes(app: FastifyInstance, pool: TxPool): void {
  app.post('/api/papers/:paperId/documents/:documentId/saves', { config: { paperScoped: true } }, async (req, reply) => {
    const paperId = req.paper!.id;
    const ownerId = req.session!.ownerId;
    const { documentId } = req.params as { documentId: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      if (!EDITOR_SAVE_REASONS.includes(b.reason as (typeof EDITOR_SAVE_REASONS)[number])) {
        throw new DomainError('INVALID', `reason must be one of ${EDITOR_SAVE_REASONS.join(', ')}`, 'reason');
      }
      const rev = await saveRevision(pool, { paperId, documentId, ownerId, expectedHead: b.expected_head_revision_id, content: b.content_json, schemaVersion: b.schema_version, reason: b.reason });
      return reply.code(201).send({ ...rev, replayed: false });
    } catch (e) {
      if (e instanceof DomainError && e.code === 'CONFLICT') {
        const cur = await getDocument(pool, paperId, documentId);
        const head = cur?.head;
        const replay = head
          && head.parent_revision_id === b.expected_head_revision_id
          && head.created_by === ownerId
          && (EDITOR_SAVE_REASONS as readonly string[]).includes(head.reason)
          && head.schema_version === b.schema_version
          && head.content_hash === contentHash(b.content_json);
        if (replay) return reply.code(200).send({ ...head, replayed: true });
      }
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  });
}
