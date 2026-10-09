// Provider capabilities for the owner (PW-023): which provider is active and, per provider × version ×
// auth × deployment, which features are verified, unsupported or unknown. Evidence notes stay in the
// registry file; only the displayed states are sent.
import type { FastifyInstance } from 'fastify';
import { capabilityMatrix, loadRegistry } from '@pw/providers/core/index.ts';

export function registerProviderRoutes(app: FastifyInstance, active: { id: string }): void {
  const registry = loadRegistry();
  app.get('/api/providers/capabilities', async () => {
    const rows = capabilityMatrix(registry);
    const row = rows.find((r) => r.provider === active.id && r.admission === 'approved') ?? null;
    return {
      active: { provider: active.id, admission: row?.admission ?? 'disabled', label: active.id === 'mock' ? 'MOCK' : null },
      rows,
    };
  });
}
