// Provider capabilities for the owner (PW-023): which provider is active and, per provider × version ×
// auth × deployment, which features are verified, unsupported or unknown. Evidence notes stay in the
// registry file; only the displayed states are sent.
import type { FastifyInstance } from 'fastify';
import { capabilityMatrix, loadRegistry, resolveCapability, type CapabilityKey } from '@pw/providers/core/index.ts';

// active: the provider this server runs with and its full registry key (version, auth, deployment)
const MOCK_KEY: CapabilityKey = { provider: 'mock', version: 'spike', auth_mode: 'none', deployment_profile: 'PERSONAL_LOCAL' };

export function registerProviderRoutes(app: FastifyInstance, active: { id: string }, key: CapabilityKey | null = active.id === 'mock' ? MOCK_KEY : null): void {
  const registry = loadRegistry();
  app.get('/api/providers/capabilities', async () => {
    const rows = capabilityMatrix(registry);
    const cap = key ? resolveCapability(registry, key) : null;
    return {
      active: { provider: active.id, admission: cap?.admission ?? 'disabled', label: active.id === 'mock' ? 'MOCK' : null },
      rows,
    };
  });
}
