import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest, type HTTPMethods, type RouteOptions } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { getPaper, type Paper } from '@pw/domain/papers/index.ts';
import { registerAuth } from './auth/plugin.ts';
import { registerPaperRoutes } from './routes/papers/index.ts';
import { registerRevisionRoutes } from './routes/revisions/index.ts';
import { registerOutlineRoutes } from './routes/outlines/index.ts';
import { registerEvidenceRoutes } from './routes/evidence/index.ts';
import { registerJobRoutes } from './routes/jobs/index.ts';
import { registerDocumentSaveRoutes } from './documents/index.ts';
import { registerProposalRoutes } from './proposals/index.ts';
import { registerCommentRoutes } from './comments/index.ts';
import { registerReferenceRoutes } from './references/index.ts';
import { registerAiRoutes } from './events/index.ts';
import { registerImportRoutes } from './imports/index.ts';
import { registerProviderRoutes } from './providers/index.ts';
import { registerUsageRoutes } from './usage/index.ts';
import { registerCurationRoutes } from './curation/index.ts';
import { registerAssetRoutes, type AssetConfig } from './assets/index.ts';
import { registerPdfRoutes } from './pdf/index.ts';
import { registerFigureVersionRoutes } from './figure-versions/index.ts';
import { registerReferenceImportRoutes } from './reference-import/index.ts';
import { registerStoryAiRoutes } from './story-ai/index.ts';
import { registerWritingProfileRoutes } from './writing-profile/index.ts';
import { registerWriterRoutes } from './writer/index.ts';
import { registerScientificCheckRoutes } from './scientific-checks/index.ts';
import { registerScientificReviewRoutes } from './scientific-review/index.ts';
import { registerManuscriptStructureRoutes } from './manuscript-structure/index.ts';
import { registerQuotaWaitRoutes } from './quota-waits/index.ts';
import { registerBudgetRoutes } from './budget/index.ts';
import { registerOutlineImpactRoutes } from './outline-impact/index.ts';
import type { ZoteroConfig } from '@pw/search/zotero/index.ts';
import { selectProvider } from '@pw/providers';

declare module 'fastify' {
  interface FastifyRequest {
    paper: Paper | null;
  }
  interface FastifyInstance {
    paperScopedRoutes(): { method: HTTPMethods; url: string }[];
  }
  interface FastifyContextConfig {
    paperScoped?: boolean;
  }
}

// 4xx kinds that are safe and useful to name (no internal detail)
const CLIENT_ERRORS: Record<number, string> = { 404: 'not_found', 405: 'method_not_allowed', 413: 'payload_too_large', 415: 'unsupported_media_type', 429: 'rate_limited' };

export interface ServerOptions {
  pool: TxPool;
  allowedOrigins: string[];
  secureCookies?: boolean;
  sessionTtlMs?: number;
  loginRateLimit?: { max: number; windowMs: number };
  allowRemoteSetup?: boolean;
  logger?: boolean;
  provider?: string;
  // how often an open job event stream looks for new events (ms)
  eventPollMs?: number;
  // how long one event stream stays open before the browser is asked to reconnect (ms)
  eventStreamMaxMs?: number;
  // where immutable source documents are stored (PW-034); without it the asset routes refuse
  assets?: AssetConfig;
  // tests only: a loopback stand-in for the Zotero Web API
  zotero?: Partial<ZoteroConfig>;
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_048_576 });
  const db = opts.pool;
  app.decorateRequest('paper', null);

  // Every route with :paperId must be declared paperScoped; the owner check is attached here so
  // it cannot be forgotten. A route that does not declare it stops the server from starting.
  const scopedRoutes: { method: HTTPMethods; url: string }[] = [];
  app.decorate('paperScopedRoutes', () => [...scopedRoutes]);
  app.addHook('onRoute', (route: RouteOptions) => {
    if (/^\/api\/papers\/:/.test(route.url) && !route.url.startsWith('/api/papers/:paperId')) {
      throw new Error(`route ${String(route.method)} ${route.url}: paper routes must name the paper parameter :paperId`);
    }
    if (!route.url.includes(':paperId')) return;
    if (route.config?.paperScoped !== true) {
      throw new Error(`route ${String(route.method)} ${route.url} is paper-scoped (:paperId) but was not declared with config.paperScoped`);
    }
    for (const m of [route.method].flat()) if (m !== 'HEAD') scopedRoutes.push({ method: m as HTTPMethods, url: route.url });
    const ownerCheck = async (req: FastifyRequest, reply: FastifyReply) => {
      const { paperId } = req.params as { paperId: string };
      const paper = req.session ? await getPaper(db, req.session.ownerId, paperId) : null;
      if (!paper) return reply.code(404).send({ error: 'not_found' });
      req.paper = paper;
    };
    const existing = route.preHandler ? [route.preHandler].flat() : [];
    route.preHandler = [ownerCheck, ...existing];
  });

  const provider = selectProvider({ PW_PROVIDER: opts.provider ?? 'mock' });
  app.get('/api/health', { config: { public: true } }, async () => ({ ok: true, provider: provider.id }));

  // Clients see a generic message; details go to the server log only.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err }, 'unhandled error');
    const kind = status === 500 ? 'internal' : (CLIENT_ERRORS[status] ?? 'bad_request');
    return reply.code(status).send({ error: kind });
  });
  registerAuth(app, {
    db,
    allowedOrigins: opts.allowedOrigins,
    secureCookies: opts.secureCookies ?? false,
    sessionTtlMs: opts.sessionTtlMs ?? 12 * 3600_000,
    loginRateLimit: opts.loginRateLimit ?? { max: 10, windowMs: 15 * 60_000 },
    allowRemoteSetup: opts.allowRemoteSetup ?? false,
  });
  registerPaperRoutes(app, db);
  registerRevisionRoutes(app, db);
  registerOutlineRoutes(app, db);
  registerEvidenceRoutes(app, db);
  registerJobRoutes(app, db);
  registerDocumentSaveRoutes(app, db);
  registerProposalRoutes(app, db);
  registerCommentRoutes(app, db);
  registerReferenceRoutes(app, db);
  registerImportRoutes(app, db);
  registerProviderRoutes(app, provider);
  registerUsageRoutes(app, db);
  registerCurationRoutes(app, db);
  registerAssetRoutes(app, db, opts.assets);
  registerPdfRoutes(app, db);
  registerFigureVersionRoutes(app, db, opts.assets);
  registerReferenceImportRoutes(app, db, { zotero: opts.zotero });
  registerStoryAiRoutes(app, db);
  registerWritingProfileRoutes(app, db);
  registerWriterRoutes(app, db);
  registerScientificCheckRoutes(app, db);
  registerScientificReviewRoutes(app, db);
  registerManuscriptStructureRoutes(app, db);
  registerQuotaWaitRoutes(app, db);
  registerBudgetRoutes(app, db);
  registerOutlineImpactRoutes(app, db);
  registerAiRoutes(app, db, { pollMs: opts.eventPollMs, maxMs: opts.eventStreamMaxMs });
  return app;
}
