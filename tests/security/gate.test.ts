// PW-059 — TST-059B: the security release gate refuses a critical/high leak, IDOR or host-access finding
// left open, any required test not run or skipped (never hidden), and a risk accepted by anyone but the user.
import { describe, expect, test } from 'vitest';
import { evaluateGate, REQUIRED_AREAS, type Audit, type Suite } from './gate.ts';

const auto = (id: string, over: Partial<Suite> = {}): Suite => ({ id, title: id, kind: 'automated', required: true, status: 'passed', counts: { passed: 3, failed: 0, skipped: 0 }, evidence: 'tests/x', ...over });
const base = (): Audit => ({ audited_at: '2026-10-10T00:00:00Z', commit: 'abc', dirty: false, suites: [...REQUIRED_AREAS.map((id) => auto(id)), { id: 'MAN-1', title: 'live', kind: 'manual', required: true, status: 'passed', evidence: 'reports/x.md', checked_by: 'user', checked_at: '2026-10-10' }], findings: [] });
const with_ = (f: (a: Audit) => void) => { const a = base(); f(a); return a; };

describe('TST-059B: the release gate', () => {
  test('everything required passed: allowed; open low findings are listed', () => {
    expect(evaluateGate(base())).toEqual({ decision: 'allowed', reasons: [], open_low: [] });
    expect(evaluateGate(with_((a) => a.findings.push({ id: 'F-9', title: 'header', severity: 'low', status: 'open' })))).toMatchObject({ decision: 'allowed', open_low: ['F-9 (low): header'] });
  });
  test.each(['critical', 'high'] as const)('an open %s finding refuses', (severity) => {
    const d = evaluateGate(with_((a) => a.findings.push({ id: 'F-1', title: 'IDOR on exports', severity, status: 'open' })));
    expect(d.decision).toBe('refused');
    expect(d.reasons.join()).toContain('F-1');
  });
  test('a risk accepted by the AI (or without a date) refuses; by the user with a date it does not', () => {
    expect(evaluateGate(with_((a) => a.findings.push({ id: 'F-2', title: 'x', severity: 'high', status: 'risk_accepted', accepted_by: 'claude' }))).decision).toBe('refused');
    expect(evaluateGate(with_((a) => a.findings.push({ id: 'F-2', title: 'x', severity: 'critical', status: 'risk_accepted', accepted_by: 'user' }))).decision).toBe('refused');
    expect(evaluateGate(with_((a) => a.findings.push({ id: 'F-2', title: 'x', severity: 'high', status: 'risk_accepted', accepted_by: 'user', accepted_at: '2026-10-10' }))).decision).toBe('allowed');
  });
  test('"fixed" without the test that shows it refuses', () => {
    expect(evaluateGate(with_((a) => a.findings.push({ id: 'F-3', title: 'x', severity: 'medium', status: 'fixed' }))).decision).toBe('refused');
    expect(evaluateGate(with_((a) => a.findings.push({ id: 'F-3', title: 'x', severity: 'medium', status: 'fixed', evidence: 'tests/security/x.test.ts' }))).decision).toBe('allowed');
  });
  test('a required suite failed, not run, missing, empty, or with a skip refuses (nothing hidden)', () => {
    for (const s of [auto('SEC-EGRESS', { status: 'failed' }), auto('SEC-EGRESS', { status: 'not_run', counts: undefined }), auto('SEC-EGRESS', { counts: { passed: 0, failed: 0, skipped: 0 } }),
      auto('SEC-EGRESS', { counts: { passed: 5, failed: 0, skipped: 1 } }), auto('SEC-EGRESS', { counts: { passed: 5, failed: 1, skipped: 0 } })]) {
      const d = evaluateGate(with_((a) => { a.suites = a.suites.map((x) => (x.id === 'SEC-EGRESS' ? s : x)); }));
      expect(d.decision, JSON.stringify(s)).toBe('refused');
      expect(d.reasons.join()).toContain('SEC-EGRESS');
    }
    const missing = evaluateGate(with_((a) => { a.suites = a.suites.filter((x) => x.id !== 'SEC-IDOR-AUTH'); }));
    expect(missing).toMatchObject({ decision: 'refused', reasons: expect.arrayContaining([expect.stringContaining('SEC-IDOR-AUTH: the required suite is missing')]) });
    // a required suite marked not required does not count
    expect(evaluateGate(with_((a) => { a.suites = a.suites.map((x) => (x.id === 'SEC-AUTH' ? { ...x, required: false } : x)); })).decision).toBe('refused');
  });
  test('a manual check without evidence is pending, never allowed; a failed one refuses', () => {
    expect(evaluateGate(with_((a) => { a.suites[a.suites.length - 1] = { id: 'MAN-1', title: 'live', kind: 'manual', required: true, status: 'pending', evidence: '' }; }))).toMatchObject({ decision: 'pending_manual' });
    expect(evaluateGate(with_((a) => { a.suites[a.suites.length - 1] = { id: 'MAN-1', title: 'live', kind: 'manual', required: true, status: 'passed', evidence: '', checked_by: 'user', checked_at: '2026-10-10' }; })).decision).toBe('pending_manual');
    expect(evaluateGate(with_((a) => { a.suites[a.suites.length - 1] = { id: 'MAN-1', title: 'live', kind: 'manual', required: true, status: 'failed', evidence: 'x' }; })).decision).toBe('refused');
  });
  test('review m3: a manual check counts only when the user recorded it with a date and evidence', () => {
    const manual = (o: Partial<Suite>) => evaluateGate(with_((a) => { a.suites[a.suites.length - 1] = { id: 'MAN-1', title: 'live', kind: 'manual', required: true, status: 'passed', evidence: 'x', checked_by: 'user', checked_at: '2026-10-10', ...o }; })).decision;
    expect(manual({})).toBe('allowed');
    expect(manual({ checked_by: 'claude' })).toBe('pending_manual');
    expect(manual({ checked_by: null })).toBe('pending_manual');
    expect(manual({ checked_at: null })).toBe('pending_manual');
  });
  test('review n1: an audit of uncommitted changes, or one that does not say, refuses', () => {
    expect(evaluateGate(with_((a) => { a.dirty = true; })).decision).toBe('refused');
    expect(evaluateGate(with_((a) => { delete a.dirty; })).decision).toBe('refused');
  });
  test('malformed records and unknown values refuse', () => {
    expect(evaluateGate({} as Audit).decision).toBe('refused');
    expect(evaluateGate(with_((a) => a.findings.push({ id: 'F-4', title: 'x', severity: 'severe' as never, status: 'open' }))).decision).toBe('refused');
    expect(evaluateGate(with_((a) => a.findings.push({ id: 'F-5', title: 'x', severity: 'low', status: 'wontfix' as never }))).decision).toBe('refused');
  });
});
