// Claude admission (PW-024): the shared gate (core/admission.ts) for a Claude key. The registry is read
// by the gate itself; callers pass the key, never a capability object.
import { decideRun, isIssued, type Approval, type Purpose, type Registry, type RunDecision, type Sentinel, type CapabilityKey } from '../core/index.ts';

export { SENTINEL_MAX_AGE_MS, type Approval, type Purpose, type Sentinel } from '../core/index.ts';
export type ClaudeDecision = RunDecision;
export const isIssuedDecision = isIssued;

export function decideClaudeCall(registry: Registry, a: { key: Omit<CapabilityKey, 'provider'>; purpose: Purpose; approval: Approval | null; sentinel: Sentinel | null; now?: number; host?: string; ttlMs?: number }): ClaudeDecision {
  return decideRun(registry, { ...a, key: { ...a.key, provider: 'claude_agent' } });
}
