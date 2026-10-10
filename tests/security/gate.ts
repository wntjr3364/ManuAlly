// PW-059 release gate for security (TST-059B). evaluateGate() reads the audit record and decides:
//  - refused: a required automated suite did not pass — failed, not run, missing, ran no test, or skipped
//    any test (a skip is not a pass and is never hidden) —; a critical or high finding is open; a critical or
//    high risk was accepted by anyone but the user (the AI cannot accept risk); a "fixed" finding names no
//    test that shows it; a finding or suite is malformed.
//  - pending_manual: nothing refused, but a required manual check (a real machine, a real login) has not been
//    recorded by the user (who, when, evidence) in reports/security/manual-checks.json. Not a release either.
//  - also refused: an audit of a tree with uncommitted changes.
//  - allowed: everything required passed; medium/low open findings are listed.
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export interface Suite { id: string; title: string; kind: 'automated' | 'manual'; required: boolean; status: 'passed' | 'failed' | 'not_run' | 'pending'; counts?: { passed: number; failed: number; skipped: number }; evidence: string; checked_by?: string | null; checked_at?: string | null }
export interface Finding { id: string; title: string; severity: Severity; status: 'open' | 'fixed' | 'risk_accepted'; evidence?: string; accepted_by?: string; accepted_at?: string; plan?: string }
export interface Audit { audited_at: string; commit: string; dirty?: boolean; suites: Suite[]; findings: Finding[] }
export interface Decision { decision: 'allowed' | 'pending_manual' | 'refused'; reasons: string[]; open_low: string[] }

const SEVERE: readonly Severity[] = ['critical', 'high'];
export const REQUIRED_AREAS = ['SEC-IDOR-AUTH', 'SEC-INJECTION', 'SEC-EGRESS', 'SEC-SEND-POLICY', 'SEC-CREDENTIAL', 'SEC-PARSER', 'SEC-AUTH', 'SEC-REDACTION', 'SEC-SUPPLY'] as const;
// the manual checks a release needs (re-review m1): taking one out of manual-checks.json does not skip it
export const REQUIRED_MANUAL = ['MAN-LIVE-SANDBOX', 'MAN-DEPLOY-TLS'] as const;

export function evaluateGate(a: Audit): Decision {
  const refuse: string[] = [];
  const pending: string[] = [];
  const open: string[] = [];
  if (!a || !Array.isArray(a.suites) || !Array.isArray(a.findings)) return { decision: 'refused', reasons: ['the audit record is malformed'], open_low: [] };
  // an audit is of a commit: results of a working tree with uncommitted changes name no release (review n1)
  if (a.dirty !== false) refuse.push(a.dirty ? 'the audit ran on uncommitted changes (commit first)' : 'the audit does not say whether the tree was clean');
  for (const id of REQUIRED_AREAS) if (!a.suites.some((s) => s.id === id && s.required && s.kind === 'automated')) refuse.push(`${id}: the required suite is missing from the audit`);
  for (const id of REQUIRED_MANUAL) if (!a.suites.some((s) => s.id === id && s.required && s.kind === 'manual')) refuse.push(`${id}: the required manual check is missing from the audit`);
  for (const s of a.suites) {
    if (!s.required) continue;
    if (s.kind === 'automated') {
      const c = s.counts;
      if (s.status !== 'passed') refuse.push(`${s.id}: ${s.status}`);
      else if (!c || c.passed < 1) refuse.push(`${s.id}: reported passed but ran no test`);
      else if (c.failed > 0) refuse.push(`${s.id}: reported passed with ${c.failed} failed`);
      else if (c.skipped > 0) refuse.push(`${s.id}: ${c.skipped} skipped (a skip is not a pass)`);
    } else if (s.kind === 'manual') {
      if (s.status === 'failed') refuse.push(`${s.id}: failed`);
      // a manual check counts when the user recorded it: who (the user), when, and the evidence (review m3)
      else if (s.status !== 'passed' || !s.evidence || s.checked_by !== 'user' || !s.checked_at) pending.push(`${s.id}: ${s.status !== 'passed' ? s.status : 'not recorded by the user with date and evidence'} — ${s.title}`);
    } else refuse.push(`${s.id}: unknown kind`);
  }
  for (const f of a.findings) {
    if (!['critical', 'high', 'medium', 'low'].includes(f.severity)) { refuse.push(`${f.id}: unknown severity`); continue; }
    if (f.status === 'fixed') { if (!f.evidence) refuse.push(`${f.id}: marked fixed without the test that shows it`); continue; }
    if (f.status === 'risk_accepted') {
      if (SEVERE.includes(f.severity) && !(f.accepted_by === 'user' && f.accepted_at)) refuse.push(`${f.id}: a ${f.severity} risk can be accepted only by the user (recorded who and when)`);
      continue;
    }
    if (f.status !== 'open') { refuse.push(`${f.id}: unknown status`); continue; }
    if (SEVERE.includes(f.severity)) refuse.push(`${f.id}: ${f.severity} finding open — ${f.title}`);
    else open.push(`${f.id} (${f.severity}): ${f.title}`);
  }
  if (refuse.length) return { decision: 'refused', reasons: [...refuse, ...pending], open_low: open };
  if (pending.length) return { decision: 'pending_manual', reasons: pending, open_low: open };
  return { decision: 'allowed', reasons: [], open_low: open };
}
