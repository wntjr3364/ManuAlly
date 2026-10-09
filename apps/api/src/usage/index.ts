// Usage and quota for the owner (PW-029): a paper's billed usage and context occupancy, and the
// latest account quota observations. Read-only; recording happens in the worker from provider events.
import type { FastifyInstance } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { quotaStatus, usageSummary } from '@pw/domain/usage/index.ts';

export function registerUsageRoutes(app: FastifyInstance, pool: TxPool): void {
  app.get('/api/papers/:paperId/usage', { config: { paperScoped: true } }, async (req) => usageSummary(pool, req.paper!.id));
  app.get('/api/providers/quota', async () => ({ observations: await quotaStatus(pool) }));
}
