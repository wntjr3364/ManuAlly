// Source documents of a paper (PW-034): upload an original PDF, fetch one from a fixed open-access
// host, list them, decide their rights, check whether one may go to an external AI, and download one
// safely. Every route is paper-scoped (owner only). Bytes are inspected before anything is stored.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import {
  FETCH_DAILY_CAP, FetchRefused, MAX_PDF_BYTES, OPEN_ACCESS_HOSTS, checkFetchQuota, checkFetchUrl, contentDisposition, decideAssetPolicy, externalSendDecision,
  getSourceAsset, inspectPdf, listSourceAssets, logFetch, policyInput, recordSourceAsset, safeFileName,
} from '@pw/domain/asset-policy/index.ts';
import { sendDomainError } from '../auth/plugin.ts';
import { IntegrityError, putBlob, readVerified } from './store.ts';
import { fetchSourcePdf, type FetchConfig } from './fetch.ts';

export interface AssetConfig { dir: string; maxBytes?: number; fetch?: FetchConfig }

export function registerAssetRoutes(app: FastifyInstance, pool: TxPool, cfg: AssetConfig | undefined): void {
  const scoped = { config: { paperScoped: true } };
  const maxBytes = cfg?.maxBytes ?? MAX_PDF_BYTES;
  const store = () => {
    if (!cfg) throw new DomainError('FORBIDDEN', 'source document storage is not configured on this server');
    return cfg.dir;
  };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  const refusedFile = (reply: FastifyReply, reason: string, message: string) => reply.code(422).send({ error: 'invalid', reason, message });
  const referenceInPaper = async (paperId: string, referenceId: unknown) => {
    if (referenceId === undefined || referenceId === '') return;
    if (typeof referenceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(referenceId)) throw new DomainError('INVALID', 'reference_id must be a reference id', 'reference_id');
    if (!(await pool.query('SELECT 1 FROM project_references WHERE paper_id = $1 AND reference_id = $2 AND removed_at IS NULL', [paperId, referenceId])).rowCount) {
      throw new DomainError('NOT_FOUND', 'reference not found in this paper', 'reference_id');
    }
  };

  app.register(async (scope) => {
    // raw PDF bodies only on this scope (other routes keep JSON only)
    scope.addContentTypeParser('application/pdf', { parseAs: 'buffer', bodyLimit: maxBytes }, (_req, body, done) => done(null, body));

    scope.get('/api/papers/:paperId/assets', scoped, async (req) => ({ assets: await listSourceAssets(pool, req.paper!.id) }));

    scope.post('/api/papers/:paperId/assets', { ...scoped, bodyLimit: maxBytes }, async (req, reply) => run(reply, async () => {
      const dir = store();
      if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'unsupported_media_type', message: 'send the PDF itself (content-type application/pdf)' });
      const q = req.query as Record<string, unknown>;
      const policy = policyInput(q, { keep_right: 'user_supplied' });
      const v = inspectPdf(req.body, { maxBytes });
      if (!v.ok) return refusedFile(reply, v.reason, v.detail);
      await referenceInPaper(req.paper!.id, q.reference_id);
      const sha = await putBlob(dir, req.body);
      const out = await recordSourceAsset(pool, {
        paperId: req.paper!.id, ownerId: req.session!.ownerId, sha256: sha, byteSize: req.body.length, pages: v.pages, originalName: safeFileName(q.name),
        source: 'user_upload', sourceUrl: null, referenceId: q.reference_id, policy,
      });
      return reply.code(out.created ? 201 : 200).send(out.asset);
    }));

    scope.post('/api/papers/:paperId/assets/fetch', scoped, async (req, reply) => run(reply, async () => {
      const dir = store();
      const b = (req.body ?? {}) as Record<string, unknown>;
      const extra = Object.keys(b).filter((k) => !['url', 'reference_id', 'license'].includes(k));
      if (extra.length) throw new DomainError('INVALID', `unknown fields: ${extra.join(', ').slice(0, 100)}`, extra[0]);
      const paperId = req.paper!.id;
      const ownerId = req.session!.ownerId;
      const raw = typeof b.url === 'string' ? b.url : '';
      let host: string | null = null;
      try { host = new URL(raw).hostname.slice(0, 255) || null; } catch { /* logged without a host */ }
      const refuse = async (reason: string, message: string) => {
        await logFetch(pool, { paperId, ownerId, url: raw || '(none)', host, outcome: reason, assetId: null });
        return reply.code(422).send({ error: 'invalid', reason, message });
      };
      const policy = policyInput({ license: b.license }, { keep_right: 'unknown' });
      await referenceInPaper(paperId, b.reference_id);
      let bytes: Buffer;
      let url: URL;
      try {
        // the cap is checked first: once reached, no request leaves the server
        await checkFetchQuota(pool, ownerId, cfg?.fetch?.dailyCap ?? FETCH_DAILY_CAP);
        url = checkFetchUrl(raw, cfg?.fetch?.allowHosts ?? OPEN_ACCESS_HOSTS);
        bytes = await fetchSourcePdf(cfg?.fetch ?? {}, url, maxBytes);
      } catch (e) {
        if (e instanceof FetchRefused) return refuse(e.reason, e.message);
        throw e;
      }
      const v = inspectPdf(bytes, { maxBytes });
      if (!v.ok) return refuse('rejected_file', `${v.reason}: ${v.detail}`);
      const sha = await putBlob(dir, bytes);
      const out = await recordSourceAsset(pool, {
        paperId, ownerId, sha256: sha, byteSize: bytes.length, pages: v.pages, originalName: safeFileName(url.pathname.split('/').pop()),
        source: 'open_access_fetch', sourceUrl: url.toString(), referenceId: b.reference_id, policy,
      });
      await logFetch(pool, { paperId, ownerId, url: raw, host, outcome: 'stored', assetId: out.asset.id });
      return reply.code(out.created ? 201 : 200).send(out.asset);
    }));

    scope.post('/api/papers/:paperId/assets/:assetId/policy', scoped, async (req, reply) => run(reply, () =>
      decideAssetPolicy(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, assetId: (req.params as { assetId: string }).assetId, body: req.body })));

    scope.get('/api/papers/:paperId/assets/:assetId/send-check', scoped, async (req, reply) => run(reply, async () => {
      const provider = String((req.query as { provider?: unknown }).provider ?? '');
      const d = await externalSendDecision(pool, { paperId: req.paper!.id, assetId: (req.params as { assetId: string }).assetId, provider });
      if (d.reasons.includes('not_found')) throw new DomainError('NOT_FOUND', 'asset not found');
      return d;
    }));

    scope.get('/api/papers/:paperId/assets/:assetId/content', scoped, async (req, reply) => run(reply, async () => {
      const dir = store();
      const a = await getSourceAsset(pool, req.paper!.id, (req.params as { assetId: string }).assetId);
      if (!a) throw new DomainError('NOT_FOUND', 'asset not found');
      let bytes: Buffer;
      try {
        bytes = await readVerified(dir, a.sha256);
      } catch (e) {
        if (e instanceof IntegrityError) return reply.code(500).send({ error: 'integrity', message: 'the stored original failed its integrity check; it is not served' });
        throw e;
      }
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', contentDisposition(safeFileName(a.original_name)))
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "sandbox; default-src 'none'")
        .header('cache-control', 'private, no-store')
        .send(bytes);
    }));
  });
}
