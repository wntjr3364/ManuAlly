import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type HTTPMethods, type RouteOptions } from 'fastify';
import type { Queryable } from '@pw/domain/shared/db.ts';
import { getPaper, type Paper } from '@pw/domain/papers/index.ts';
import { registerAuth } from './auth/plugin.ts';
import { registerPaperRoutes } from './routes/papers/index.ts';
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

export interface ServerOptions {
  pool: Queryable;
  allowedOrigins: string[];
  secureCookies?: boolean;
  sessionTtlMs?: number;
  loginRateLimit?: { max: number; windowMs: number };
  allowRemoteSetup?: boolean;
  logger?: boolean;
  provider?: string;
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
  app.get('/api/health', async () => ({ ok: true, provider: provider.id }));
  registerAuth(app, {
    db,
    allowedOrigins: opts.allowedOrigins,
    secureCookies: opts.secureCookies ?? false,
    sessionTtlMs: opts.sessionTtlMs ?? 12 * 3600_000,
    loginRateLimit: opts.loginRateLimit ?? { max: 10, windowMs: 15 * 60_000 },
    allowRemoteSetup: opts.allowRemoteSetup ?? false,
  });
  registerPaperRoutes(app, db);
  return app;
}
