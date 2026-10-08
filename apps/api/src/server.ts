import Fastify, { type FastifyInstance } from 'fastify';

export interface ServerOptions {
  logger?: boolean;
}

// Assembles the API. Routes are registered by later tasks (papers, revisions, outlines, ...).
export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  app.get('/api/health', async () => ({ ok: true, provider: 'mock' }));
  return app;
}
