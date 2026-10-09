// Importing references into a paper (PW-038): a pasted or uploaded file (CSL-JSON, BibTeX, RIS, DOI list)
// or a read-only read of a Zotero library. The Zotero key is used for this one request and not kept.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { MAX_IMPORT_BYTES, importReferences } from '@pw/domain/imports/references/index.ts';
import { ZOTERO_CAPABILITIES, ZoteroUnavailable, readZoteroItems, type ZoteroConfig } from '@pw/search/zotero/index.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerReferenceImportRoutes(app: FastifyInstance, pool: TxPool, opts: { zotero?: Partial<ZoteroConfig> } = {}): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, code = 200) => {
    try {
      return reply.code(code).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      if (e instanceof ZoteroUnavailable) return reply.code(e.reason === 'bad_request' ? 422 : 502).send({ error: 'source_unavailable', reason: e.reason, message: e.message });
      throw e;
    }
  };
  app.post('/api/papers/:paperId/references/import', { ...scoped, bodyLimit: MAX_IMPORT_BYTES + 64 * 1024 }, async (req, reply) => run(reply, () => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const extra = Object.keys(b).filter((k) => !['format', 'text'].includes(k));
    if (extra.length) throw new DomainError('INVALID', `unknown fields: ${extra.join(', ').slice(0, 100)}`, extra[0]);
    return importReferences(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, format: b.format, text: b.text });
  }, 201));
  app.get('/api/papers/:paperId/references/zotero', scoped, async () => ({ capabilities: ZOTERO_CAPABILITIES }));
  app.post('/api/papers/:paperId/references/zotero/import', scoped, async (req, reply) => run(reply, async () => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const extra = Object.keys(b).filter((k) => !['library_type', 'library_id', 'api_key', 'start', 'limit'].includes(k));
    if (extra.length) throw new DomainError('INVALID', `unknown fields: ${extra.join(', ').slice(0, 100)}`, extra[0]);
    const { items, total } = await readZoteroItems({
      ...opts.zotero, libraryType: b.library_type as 'user' | 'group', libraryId: String(b.library_id ?? ''), ...(typeof b.api_key === 'string' && b.api_key ? { apiKey: b.api_key } : {}),
    }, { start: Number(b.start ?? 0), limit: Number(b.limit ?? 50) });
    const out = await importReferences(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, format: 'csl-json', text: JSON.stringify(items), source: 'zotero' });
    return { ...out, zotero_total: total, capabilities: ZOTERO_CAPABILITIES };
  }, 201));
}
