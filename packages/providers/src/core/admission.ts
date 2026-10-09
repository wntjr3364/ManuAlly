// Admission for real provider runs (PW-024 review; P00 decideModelCall, ADR-014, RFC-004). The only
// gate: it reads the registry itself (by the full key), never a capability object from the caller.
//   paper_work — the row is approved with structured live evidence for this CLI version
//   live_smoke — the synthetic smoke that produces that evidence; allowed while requires_verification
// Always: the user's approval with a positive budget (turns, USD), an auth isolation sentinel from this
// host in the last 24 hours, and for Codex a verified outer filesystem sandbox on this host.
// A decision is issued here, expires (1 hour by default) and is spent turn by turn; cost reported by
// the provider is added up and the run stops when the approved budget is reached.
import os from 'node:os';
import { liveEvidenceOk, resolveCapability, type CapabilityKey, type Registry } from './capabilities.ts';

export const SENTINEL_MAX_AGE_MS = 24 * 3600e3;
export interface Approval { approved: boolean; max_turns: number; budget_usd: number }
export interface Sentinel { provider: string; status: 'isolated' | 'leak' | 'unknown'; host: string; checked_at: string }
export interface OuterSandbox { kind: 'bubblewrap' | 'userns' | 'container' | 'vm'; verified: boolean; host: string; checked_at: string }
export type Purpose = 'paper_work' | 'live_smoke';
export interface RunDecision {
  readonly allowed: boolean; readonly reason: string; readonly purpose: Purpose; readonly key: CapabilityKey;
  readonly max_turns: number; readonly budget_usd: number; readonly decided_at: string; readonly expires_at: string;
}

const issued = new WeakSet<object>();
const spent = new WeakMap<object, { turns: number; usd: number }>();
export const isIssued = (d: unknown): d is RunDecision => !!d && typeof d === 'object' && issued.has(d);
const fresh = (at: string, now: number) => { const age = now - Date.parse(at); return age >= 0 && age <= SENTINEL_MAX_AGE_MS; };

export function decideRun(registry: Registry, a: {
  key: CapabilityKey; purpose: Purpose; approval: Approval | null; sentinel: Sentinel | null; sandbox?: OuterSandbox | null;
  now?: number; host?: string; ttlMs?: number;
}): RunDecision {
  const now = a.now ?? Date.now();
  const host = a.host ?? os.hostname();
  const issue = (allowed: boolean, reason: string, max_turns = 0, budget_usd = 0) => {
    const d = Object.freeze({ allowed, reason, purpose: a.purpose, key: Object.freeze({ ...a.key }), max_turns, budget_usd, decided_at: new Date(now).toISOString(), expires_at: new Date(now + (a.ttlMs ?? 3600e3)).toISOString() });
    issued.add(d);
    spent.set(d, { turns: 0, usd: 0 });
    return d;
  };
  const deny = (reason: string) => issue(false, reason);
  const k = a.key;
  if (k.provider !== 'claude_agent' && k.provider !== 'codex') return deny(`not a real provider (${String(k.provider)})`);
  const cap = resolveCapability(registry, k);
  if (!cap.registered) return deny('this provider/version/auth/deployment is not registered');
  if (cap.admission === 'disabled') return deny('this provider/auth/deployment is disabled');
  const entry = registry.entries.find((x) => x.capability.provider === k.provider && x.capability.version === k.version && x.capability.auth_mode === k.auth_mode && x.capability.deployment_profile === k.deployment_profile);
  if (a.purpose === 'paper_work') {
    if (cap.admission !== 'approved' || !liveEvidenceOk(entry?.evidence.live_evidence, k.version, k.provider)) return deny(`admission is ${cap.admission}: paper work needs live evidence for ${k.version} from this machine (run the live smoke first)`);
  } else if (a.purpose !== 'live_smoke') return deny('unknown purpose');
  if (k.provider === 'codex') {
    const sb = a.sandbox;
    if (!sb || sb.verified !== true || sb.host !== host || !fresh(sb.checked_at, now)) return deny('no verified outer filesystem sandbox on this host in the last 24 hours (Codex shell cannot be fully disabled)');
  }
  const ap = a.approval;
  if (!ap || ap.approved !== true) return deny('the user has not approved this use');
  if (!(Number.isInteger(ap.max_turns) && ap.max_turns > 0) || !(typeof ap.budget_usd === 'number' && Number.isFinite(ap.budget_usd) && ap.budget_usd > 0)) return deny('no budget approved (max turns and USD must be positive)');
  const s = a.sentinel;
  if (!s || s.provider !== k.provider) return deny(`auth isolation sentinel missing for ${k.provider}`);
  if (s.status !== 'isolated') return deny(`auth isolation sentinel is ${s.status}`);
  if (s.host !== host) return deny(`auth isolation sentinel was taken on another host (${s.host}), not this host`);
  if (!fresh(s.checked_at, now)) return deny('auth isolation sentinel is stale or undated (needs one from the last 24 hours)');
  return issue(true, 'admitted', ap.max_turns, ap.budget_usd);
}

export class AdmissionRefused extends Error {}

// Checks without spending (before anything is started, even `--version`).
export function checkDecision(d: unknown, provider: 'claude_agent' | 'codex', now = Date.now()): RunDecision {
  if (!isIssued(d)) throw new AdmissionRefused('refused: decision was not issued by the admission gate');
  if (!d.allowed) throw new AdmissionRefused(`refused: ${d.reason}`);
  if (d.key.provider !== provider) throw new AdmissionRefused(`refused: decision is for ${d.key.provider}, not ${provider}`);
  if (now > Date.parse(d.expires_at)) throw new AdmissionRefused('refused: the decision has expired; ask again');
  const s = spent.get(d)!;
  if (s.turns >= d.max_turns) throw new AdmissionRefused(`refused: the approved ${d.max_turns} turn(s) are used up`);
  if (s.usd >= d.budget_usd) throw new AdmissionRefused('refused: the approved budget is used up');
  return d;
}

// Spends one turn of an issued, allowed, unexpired decision for this provider.
export function spendTurn(d: unknown, provider: 'claude_agent' | 'codex', now = Date.now()): RunDecision {
  if (!isIssued(d)) throw new AdmissionRefused('refused: decision was not issued by the admission gate');
  if (!d.allowed) throw new AdmissionRefused(`refused: ${d.reason}`);
  if (d.key.provider !== provider) throw new AdmissionRefused(`refused: decision is for ${d.key.provider}, not ${provider}`);
  if (now > Date.parse(d.expires_at)) throw new AdmissionRefused('refused: the decision has expired; ask again');
  const s = spent.get(d)!;
  if (s.turns >= d.max_turns) throw new AdmissionRefused(`refused: the approved ${d.max_turns} turn(s) are used up`);
  if (s.usd >= d.budget_usd) throw new AdmissionRefused('refused: the approved budget is used up');
  s.turns++;
  return d;
}

// Adds reported cost; true once the approved budget is reached (the caller stops the run).
export function addCost(d: RunDecision, usd: number): boolean {
  const s = spent.get(d);
  if (!s || !(usd >= 0)) return false;
  s.usd += usd;
  return s.usd >= d.budget_usd;
}
export const spentSoFar = (d: RunDecision) => ({ ...(spent.get(d) ?? { turns: 0, usd: 0 }) });
