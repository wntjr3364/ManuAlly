// Codex admission (PW-025): the shared gate (core/admission.ts) for a Codex key; it reads the registry
// itself and also requires a verified outer filesystem sandbox (RFC-004).
import { decideRun, isIssued, type Approval, type CapabilityKey, type OuterSandbox, type Purpose, type Registry, type RunDecision, type Sentinel } from '../core/index.ts';

export type { OuterSandbox } from '../core/index.ts';
export type CodexSentinel = Sentinel;
export type CodexDecision = RunDecision;
export const isIssuedCodexDecision = isIssued;

export function decideCodexCall(registry: Registry, a: { key: Omit<CapabilityKey, 'provider'>; purpose: Purpose; approval: Approval | null; sentinel: Sentinel | null; sandbox: OuterSandbox | null; now?: number; host?: string; ttlMs?: number }): CodexDecision {
  return decideRun(registry, { ...a, key: { ...a.key, provider: 'codex' } });
}
