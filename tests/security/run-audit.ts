// PW-059 security audit runner: runs every required security suite, reads the results from the test runner
// itself (a suite counts as passed only when every one of its files ran, none failed and none was skipped),
// adds the manual checks and the findings register (reports/security/findings.json), writes
// reports/security/audit.json and prints the gate's decision.
//   node tests/security/run-audit.ts        exit 0 allowed, 1 refused, 2 pending manual checks
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateGate, type Audit, type Finding, type Suite } from './gate.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
type Config = 'unit' | 'integration';
const AUTOMATED: { id: string; title: string; files: [Config, string][] }[] = [
  { id: 'SEC-IDOR-AUTH', title: 'cross-owner/cross-paper access, authentication, CSRF and origin on every route; cross-paper references refused by the database', files: [['integration', 'tests/security/sweep.int.test.ts'], ['integration', 'tests/security/schema.int.test.ts']] },
  { id: 'SEC-INJECTION', title: 'injected instructions in untrusted text; tool gateway scope from the run token', files: [['integration', 'tests/security/injection.int.test.ts'], ['integration', 'tests/tasks/PW-027/gateway.int.test.ts']] },
  { id: 'SEC-EGRESS', title: 'URL fetch scheme/host/port/address checks; network only from reviewed modules', files: [['unit', 'tests/security/egress.test.ts'], ['integration', 'tests/tasks/PW-034/assets.int.test.ts'], ['unit', 'tests/security/static.test.ts']] },
  { id: 'SEC-SEND-POLICY', title: 'a paper\'s sending policy (classification, block, allowed providers) before any material reaches a provider', files: [['integration', 'tests/security/send-policy.int.test.ts'], ['integration', 'tests/tasks/PW-034/assets.int.test.ts'], ['integration', 'tests/tasks/PW-037/retrieval.int.test.ts'], ['integration', 'tests/tasks/PW-047/checkpoints.int.test.ts'], ['integration', 'tests/tasks/PW-049/quota.int.test.ts']] },
  { id: 'SEC-CREDENTIAL', title: 'login profile never developer state; child environments; run folders and sandbox runner', files: [['unit', 'tests/security/credentials.test.ts'], ['unit', 'tests/tasks/PW-026/runner.test.ts']] },
  { id: 'SEC-PARSER', title: 'PDF, DOCX, ZIP archive and reference parsers under limits', files: [['integration', 'tests/tasks/PW-035/pdf.int.test.ts'], ['unit', 'tests/tasks/PW-055/docx.test.ts'], ['unit', 'tests/tasks/PW-057/archive.test.ts']] },
  { id: 'SEC-AUTH', title: 'owners, sessions, login limits, paper scope', files: [['integration', 'tests/tasks/PW-008/papers.int.test.ts'], ['integration', 'tests/tasks/PW-008/review-fixes.int.test.ts']] },
  { id: 'SEC-REDACTION', title: 'secret redaction in errors and logs', files: [['unit', 'tests/tasks/PW-052/classify.test.ts']] },
  { id: 'SEC-SUPPLY', title: 'dependency licenses, version pins, lockfile', files: [['unit', 'tests/security/supply-chain.test.ts']] },
];
// checks only a real machine can give: recorded by the user in reports/security/manual-checks.json (who, when,
// evidence); never written by this runner (review m3)
function manualChecks(): Suite[] {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports/security/manual-checks.json'), 'utf8')) as { id: string; title: string; status: Suite['status']; evidence: string; checked_by: string | null; checked_at: string | null }[];
  return raw.map((m) => ({ id: m.id, title: m.title, kind: 'manual', required: true, status: m.status, evidence: m.evidence, checked_by: m.checked_by, checked_at: m.checked_at }));
}

interface VitestJson { testResults: { name: string; assertionResults: { status: string }[] }[] }
function runVitest(config: Config, files: string[]): VitestJson {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-audit-')), 'result.json');
  spawnSync('npx', ['vitest', 'run', '--config', `packages/config/vitest.${config}.config.ts`, '--reporter=json', `--outputFile=${out}`, ...files], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], timeout: 1_800_000 });
  try { return JSON.parse(fs.readFileSync(out, 'utf8')) as VitestJson; } catch { return { testResults: [] }; } finally { fs.rmSync(path.dirname(out), { recursive: true, force: true }); }
}

export function runAudit(): Audit {
  // the tree as audited: any uncommitted change makes the record name no release (review n1)
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
  const results = new Map<string, { passed: number; failed: number; skipped: number }>();
  for (const config of ['unit', 'integration'] as const) {
    const files = [...new Set(AUTOMATED.flatMap((s) => s.files.filter(([c]) => c === config).map(([, f]) => f)))];
    for (const r of runVitest(config, files).testResults) {
      const c = { passed: 0, failed: 0, skipped: 0 };
      for (const a of r.assertionResults) {
        if (a.status === 'passed') c.passed++;
        else if (a.status === 'failed') c.failed++;
        else c.skipped++; // skipped, pending, todo: not a pass
      }
      results.set(path.relative(ROOT, r.name), c);
    }
  }
  const suites: Suite[] = AUTOMATED.map((s) => {
    const per = s.files.map(([, f]) => [f, results.get(f)] as const);
    const counts = per.reduce((n, [, c]) => ({ passed: n.passed + (c?.passed ?? 0), failed: n.failed + (c?.failed ?? 0), skipped: n.skipped + (c?.skipped ?? 0) }), { passed: 0, failed: 0, skipped: 0 });
    const missing = per.filter(([, c]) => !c).map(([f]) => f);
    const status = missing.length ? 'not_run' : counts.failed || counts.skipped || !counts.passed || per.some(([, c]) => !c!.passed) ? 'failed' : 'passed';
    return { id: s.id, title: s.title, kind: 'automated', required: true, status, counts, evidence: s.files.map(([, f]) => f).join(', ') + (missing.length ? ` (not run: ${missing.join(', ')})` : '') };
  });
  const findings = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports/security/findings.json'), 'utf8')) as Finding[];
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  return { audited_at: new Date().toISOString(), commit, dirty, suites: [...suites, ...manualChecks()], findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const audit = runAudit();
  const decision = evaluateGate(audit);
  fs.writeFileSync(path.join(ROOT, 'reports/security/audit.json'), `${JSON.stringify({ ...audit, gate: decision }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ decision: decision.decision, reasons: decision.reasons, open_low: decision.open_low, suites: audit.suites.map((s) => `${s.id}: ${s.status}${s.counts ? ` (${s.counts.passed} passed, ${s.counts.failed} failed, ${s.counts.skipped} skipped)` : ''}`) }, null, 2)}\n`);
  process.exit(decision.decision === 'allowed' ? 0 : decision.decision === 'refused' ? 1 : 2);
}
