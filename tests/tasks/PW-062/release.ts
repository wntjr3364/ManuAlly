// PW-062 release gate (spec 11 "완료 기준", spec 12 "릴리스 수준"). The release record lists every required
// capability with its status — pass / blocked / not_run / manual_pending — and its evidence. The gate decides
// which release level is reached, and refuses a record that claims more than its evidence shows:
//  - a live capability (a real provider, the real sandbox) passes only with the provider admitted in the
//    registry on live evidence, never with mock-only evidence;
//  - a manual capability passes only when the user recorded it (who = user, when, evidence). This is a record,
//    not a proof: anyone who can write the file can write "user" (an agent must never do so — review n3);
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
  { id: 'personal_v1', title: '개인 사용 v1 (전체 gate + restore + pilot)', needs: ['CAP-SECURITY-GATE', 'CAP-SCIENTIFIC-HUMAN', 'CAP-DEPLOY-REAL', 'CAP-RESTORE-REAL', 'CAP-USER-PILOT', 'CAP-BROWSERS-IME', 'CAP-SCOPE-ACCEPT'] },
];
// what each capability is, fixed here and not taken from the record (review m1: a record that relabels a live
// or manual capability as automated would otherwise pass it)
const L = (provider: string) => ({ kind: 'live' as const, provider });
export const KIND_OF: Record<string, { kind: Kind; provider?: string }> = {
  'CAP-PAPER-CORE': { kind: 'automated' }, 'CAP-EDITOR': { kind: 'automated' }, 'CAP-EVIDENCE-REFS': { kind: 'automated' }, 'CAP-MOCK-AI': { kind: 'automated' },
  'CAP-SCIENTIFIC-AUTO': { kind: 'automated' }, 'CAP-EXPORT': { kind: 'automated' }, 'CAP-RELIABILITY': { kind: 'automated' }, 'CAP-SECURITY-AUTO': { kind: 'automated' },
  'CAP-BACKUP-RESTORE': { kind: 'automated' }, 'CAP-DEPLOY-TOOLS': { kind: 'automated' },
  'CAP-PROVIDER-CLAUDE-LIVE': L('claude_agent'), 'CAP-PROVIDER-CODEX-LIVE': L('codex'),
  'CAP-SANDBOX-LIVE': { kind: 'manual' }, 'CAP-PREFLIGHT-USER': { kind: 'manual' }, 'CAP-RELIABILITY-REAL': { kind: 'manual' }, 'CAP-SECURITY-GATE': { kind: 'manual' },
  'CAP-SCIENTIFIC-HUMAN': { kind: 'manual' }, 'CAP-DEPLOY-REAL': { kind: 'manual' }, 'CAP-RESTORE-REAL': { kind: 'manual' }, 'CAP-BROWSERS-IME': { kind: 'manual' },
  'CAP-USER-PILOT': { kind: 'manual' }, 'CAP-SCOPE-ACCEPT': { kind: 'manual' },
};
const STATUSES: Status[] = ['pass', 'blocked', 'not_run', 'manual_pending'];
const KINDS: Kind[] = ['automated', 'live', 'manual'];

export interface Decision { level: string; level_title: string; next: string | null; blockers: string[]; problems: string[]; v1: boolean }

export function passes(c: Capability, registry: RegistryEntry[], problems: string[]): boolean {
  if (!STATUSES.includes(c.status)) { problems.push(`${c.id}: unknown status ${String(c.status)}`); return false; }
  if (!KINDS.includes(c.kind)) { problems.push(`${c.id}: unknown kind ${String(c.kind)}`); return false; }
  const fixed = KIND_OF[c.id];
  if (fixed && (fixed.kind !== c.kind || (fixed.provider ?? null) !== (c.provider ?? null))) { problems.push(`${c.id}: is ${fixed.kind}${fixed.provider ? ` (${fixed.provider})` : ''}, recorded as ${c.kind}${c.provider ? ` (${c.provider})` : ''}`); return false; }
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
export const OVERCLAIM = /v1\s*(완료|완성|출시|릴리스\s*완료)|production[- ]ready|제품\s*완성|완성(된|한)\s*제품|모든\s*기능\s*(검증|완료)|실제\s*(AI|provider|공급자)로\s*검증(됨|되었|했|\s*완료)|release[- ]ready|출시\s*준비\s*(완료|됨)/i;
