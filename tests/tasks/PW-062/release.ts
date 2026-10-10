// PW-062 release gate (spec 11 "완료 기준", spec 12 "릴리스 수준"). The release record lists every required
// capability with its status — pass / blocked / not_run / manual_pending — and its evidence. The gate decides
// which release level is reached, and refuses a record that claims more than its evidence shows:
//  - a live capability (a real provider, the real sandbox) passes only with the provider admitted in the
//    registry on live evidence, never with mock-only evidence;
//  - a manual capability passes only when the user recorded it (who = user, when, evidence);
//  - a pass needs evidence; an unknown status or kind is refused.
// Levels (spec 12): Demo (Mock) → private alpha (one real provider) → private beta (both adapters and
// reliability) → personal v1 (everything, with restore and the user's pilot).

export type Status = 'pass' | 'blocked' | 'not_run' | 'manual_pending';
export type Kind = 'automated' | 'live' | 'manual';
export interface Capability {
  id: string;
  title: string;
  requirements: string[];
  kind: Kind;
  status: Status;
  evidence: string[];
  mock_only?: boolean;
  provider?: string; // live capabilities: the registry provider they stand for
  blocker?: string; // why it does not pass, and what is needed
  user_record?: { checked_by: string; checked_at: string; evidence: string } | null;
}
export interface RegistryEntry { capability: { provider: string; admission: string }; evidence: { live_evidence: unknown } }
export interface Level { id: string; title: string; needs: string[] }

export const LEVELS: Level[] = [
  { id: 'demo_mock', title: 'Demo (Mock)', needs: ['CAP-PAPER-CORE', 'CAP-EDITOR', 'CAP-EVIDENCE-REFS', 'CAP-MOCK-AI', 'CAP-SCIENTIFIC-AUTO', 'CAP-EXPORT', 'CAP-RELIABILITY', 'CAP-SECURITY-AUTO', 'CAP-BACKUP-RESTORE', 'CAP-DEPLOY-TOOLS'] },
  { id: 'private_alpha', title: 'private alpha (실제 허용 provider 1개)', needs: ['CAP-PROVIDER-CLAUDE-LIVE', 'CAP-SANDBOX-LIVE', 'CAP-PREFLIGHT-USER'] },
  { id: 'private_beta', title: 'private beta (두 adapter와 reliability)', needs: ['CAP-PROVIDER-CODEX-LIVE', 'CAP-RELIABILITY-REAL'] },
  { id: 'personal_v1', title: '개인 사용 v1 (전체 gate + restore + pilot)', needs: ['CAP-SECURITY-GATE', 'CAP-SCIENTIFIC-HUMAN', 'CAP-DEPLOY-REAL', 'CAP-RESTORE-REAL', 'CAP-USER-PILOT', 'CAP-BROWSERS-IME'] },
];
const STATUSES: Status[] = ['pass', 'blocked', 'not_run', 'manual_pending'];
const KINDS: Kind[] = ['automated', 'live', 'manual'];

export interface Decision { level: string; level_title: string; next: string | null; blockers: string[]; problems: string[]; v1: boolean }

export function passes(c: Capability, registry: RegistryEntry[], problems: string[]): boolean {
  if (!STATUSES.includes(c.status)) { problems.push(`${c.id}: unknown status ${String(c.status)}`); return false; }
  if (!KINDS.includes(c.kind)) { problems.push(`${c.id}: unknown kind ${String(c.kind)}`); return false; }
  if (c.status !== 'pass') return false;
  if (!Array.isArray(c.evidence) || c.evidence.length === 0) { problems.push(`${c.id}: pass without evidence`); return false; }
  if (c.kind === 'live') {
    if (c.mock_only) { problems.push(`${c.id}: a live capability cannot pass on mock-only evidence`); return false; }
    const e = registry.find((r) => r.capability.provider === c.provider);
    if (!e || e.capability.admission !== 'approved' || !e.evidence.live_evidence) { problems.push(`${c.id}: claimed live pass, but the registry does not admit ${String(c.provider)} on live evidence`); return false; }
  }
  if (c.kind === 'manual') {
    const r = c.user_record;
    if (!r || r.checked_by !== 'user' || !r.checked_at || Number.isNaN(Date.parse(r.checked_at)) || !r.evidence) { problems.push(`${c.id}: a manual capability passes only when the user recorded it (who, when, evidence)`); return false; }
  }
  return true;
}

export function evaluateRelease(caps: Capability[], registry: RegistryEntry[]): Decision {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const c of caps) { if (ids.has(c.id)) problems.push(`${c.id}: listed twice`); ids.add(c.id); }
  const ok = new Map(caps.map((c) => [c.id, passes(c, registry, problems)]));
  for (const l of LEVELS) for (const n of l.needs) if (!ids.has(n)) problems.push(`${n}: required by ${l.id} but missing from the record`);
  let reached: Level | null = null;
  let next: Level | null = null;
  for (const l of LEVELS) {
    if (l.needs.every((n) => ok.get(n))) reached = l;
    else { next = l; break; }
  }
  // what stands between this level and v1: every capability of every level not reached
  const blockers = next ? LEVELS.slice(LEVELS.indexOf(next)).flatMap((l) => l.needs).filter((n) => !ok.get(n)) : [];
  if (problems.length) return { level: 'refused', level_title: 'refused: the record claims more than its evidence', next: null, blockers, problems, v1: false };
  return { level: reached?.id ?? 'none', level_title: reached?.title ?? 'none', next: next?.id ?? null, blockers, problems, v1: reached?.id === 'personal_v1' };
}

// words that claim a finished product; allowed in the report only when the gate says v1
export const OVERCLAIM = /v1\s*(완료|출시|릴리스\s*완료)|production[- ]ready|제품\s*완성|모든\s*기능\s*(검증|완료)|실제\s*(AI|provider)로\s*검증\s*완료/i;
