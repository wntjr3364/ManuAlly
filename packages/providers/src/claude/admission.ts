// The only gate in front of a Claude run (PW-024; P00 decideModelCall, ADR-014). A decision is issued
// here and remembered; startClaudeTurn accepts nothing else.
//   paper_work — the registry row is approved (live evidence from the user's machine, PW-023)
//   live_smoke — the synthetic smoke that produces that evidence; allowed while requires_verification
// Both need: the user's explicit approval with a positive budget (turns and USD), and an auth isolation
// sentinel taken on this host within 24 hours showing that an empty profile is not logged in.
import os from 'node:os';
import type { Capability } from '../core/capabilities.ts';

export const SENTINEL_MAX_AGE_MS = 24 * 3600e3;
export interface Sentinel { provider: string; status: 'isolated' | 'leak' | 'unknown'; host: string; checked_at: string }
export interface Approval { approved: boolean; max_turns: number; budget_usd: number }
export type Purpose = 'paper_work' | 'live_smoke';
export interface ClaudeDecision { readonly allowed: boolean; readonly reason: string; readonly purpose: Purpose; readonly max_turns: number; readonly budget_usd: number; readonly decided_at: string }

const issued = new WeakSet<object>();
export const isIssuedDecision = (d: unknown): d is ClaudeDecision => !!d && typeof d === 'object' && issued.has(d);
function issue(d: Omit<ClaudeDecision, 'decided_at'>): ClaudeDecision {
  const out = Object.freeze({ ...d, decided_at: new Date().toISOString() });
  issued.add(out);
  return out;
}

export function decideClaudeCall(a: { capability: Pick<Capability, 'provider' | 'admission'> & { live_evidence?: unknown }; purpose: Purpose; approval: Approval | null; sentinel: Sentinel | null; now?: number; host?: string }): ClaudeDecision {
  const now = a.now ?? Date.now();
  const host = a.host ?? os.hostname();
  const deny = (reason: string) => issue({ allowed: false, reason, purpose: a.purpose, max_turns: 0, budget_usd: 0 });
  const c = a.capability;
  if (c.provider !== 'claude_agent') return deny(`not a Claude capability (${c.provider})`);
  if (c.admission === 'disabled') return deny('this provider/auth/deployment is disabled');
  if (a.purpose === 'paper_work' && (c.admission !== 'approved' || !c.live_evidence)) return deny(`admission is ${c.admission}: paper work needs live evidence from this machine (run the live smoke first)`);
  if (a.purpose !== 'paper_work' && a.purpose !== 'live_smoke') return deny('unknown purpose');
  const ap = a.approval;
  if (!ap || ap.approved !== true) return deny('the user has not approved this use');
  if (!(Number.isInteger(ap.max_turns) && ap.max_turns > 0) || !(typeof ap.budget_usd === 'number' && ap.budget_usd > 0)) return deny('no budget approved (max turns and USD must be positive)');
  const s = a.sentinel;
  if (!s || s.provider !== 'claude_agent') return deny('auth isolation sentinel missing for claude_agent');
  if (s.status !== 'isolated') return deny(`auth isolation sentinel is ${s.status}`);
  if (s.host !== host) return deny(`auth isolation sentinel was taken on another host (${s.host}), not this host`);
  const age = now - Date.parse(s.checked_at);
  if (!(age >= 0 && age <= SENTINEL_MAX_AGE_MS)) return deny('auth isolation sentinel is stale or undated (needs one from the last 24 hours)');
  return issue({ allowed: true, reason: 'admitted', purpose: a.purpose, max_turns: ap.max_turns, budget_usd: ap.budget_usd });
}
