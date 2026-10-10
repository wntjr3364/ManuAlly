// PW-062 TST-062A: the release report lists every required capability as pass / blocked / not_run /
// manual_pending, traces every requirement to one, and states the user's approval scope as the gate records
// do. TST-062B: mock results, finished documents and live tests that never ran are not presented as a
// finished product; no remaining blocker is dropped.
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateRelease, KIND_OF, LEVELS, OVERCLAIM, passes, type Capability, type RegistryEntry } from './release.ts';

const root = path.resolve('.');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const caps = () => JSON.parse(read('reports/release/capabilities.json')) as Capability[];
const report = () => read('reports/release/RELEASE_REPORT.md');
const registry = () => (JSON.parse(read('packages/providers/src/core/registry.json')) as { entries: RegistryEntry[] }).entries;
const tasks = () => read('tasks/tasks.csv').replace(/^\uFEFF/, '').trim().split('\n').slice(1).map((l) => { const c = l.split(','); return { id: c[0]!, status: c[3]!, req: c[5]! }; });

describe('TST-062A: the release record', () => {
  test('every requirement of every task is traced to a capability, and every piece of evidence exists', () => {
    const c = caps();
    const traced = new Set(c.flatMap((x) => x.requirements));
    expect(tasks().map((t) => t.req).filter((r) => !traced.has(r))).toEqual([]);
    for (const x of c) for (const e of x.evidence) expect(fs.existsSync(path.join(root, e)), `${x.id}: ${e}`).toBe(true);
    for (const x of c) if (x.status !== 'pass') expect(x.blocker, `${x.id} needs a stated blocker`).toBeTruthy();
  });

  test('the tasks behind a passing capability are implemented and reviewed (in_review), not planned', () => {
    const t = new Map(tasks().map((x) => [x.req, x]));
    for (const c of caps().filter((x) => x.status === 'pass')) {
      for (const r of c.requirements) {
        const task = t.get(r);
        if (task && task.id !== 'PW-062') expect(task.status, `${c.id} ${r} (${task.id})`).toBe('in_review');
      }
    }
  });

  test('the record is consistent: the gate refuses nothing, and the report states the gate\'s own decision and every blocker', () => {
    const d = evaluateRelease(caps(), registry());
    expect(d.problems).toEqual([]);
    // the blockers are every capability that does not pass — of the next level and every level after it
    expect([...d.blockers].sort()).toEqual(caps().filter((c) => !passes(c, registry(), [])).map((c) => c.id).sort());
    const md = report();
    expect(md).toContain(`판정: **${d.level_title}**`);
    expect(md).toContain(`(\`${d.level}\`)`);
    for (const b of d.blockers) expect(md, `blocker ${b} is not in the report`).toContain(b);
    // each capability appears in the report's table with its status
    for (const c of caps()) expect(md, c.id).toMatch(new RegExp(`\\| ${c.id} \\|[^\\n]*\\| ${c.status} \\|`));
  });

  test('the approval scope is the one the gate records give: P00/P01 approved, P02–P06 delegated, no real provider use approved', () => {
    const md = report();
    const status = (f: string) => read(f).split('\n').find((l) => /상태|판정/.test(l)) ?? '';
    const gates: [string, string][] = [['P00', 'reports/phases/P00_GATE.md'], ['P01', 'reports/phases/P01_GATE.md'], ['P02', 'reports/phases/P02_GATE.md'], ['P03', 'reports/phases/P03_GATE.md'], ['P04', 'reports/phases/P04_GATE.md'], ['P05', 'reports/p05/P05_GATE.md'], ['P06', 'reports/p06/P06_GATE.md']];
    for (const [p, f] of gates) {
      const s = status(f);
      const kind = /사용자 승인/.test(s) ? '사용자 승인' : /위임/.test(s) ? '사용자 위임' : 'unknown';
      expect(kind, `${p}: ${s}`).not.toBe('unknown');
      expect(md, `${p} approval`).toMatch(new RegExp(`\\| ${p} \\|[^\\n]*${kind}`));
    }
    expect(status('reports/phases/P03_GATE.md')).toMatch(/실제 provider 사용은 아직 승인하지 않음/);
    expect(md).toMatch(/\| P07 \|[^\n]*사용자 결정 대기/);
  });
});

describe('TST-062B: nothing is presented as more than it is', () => {
  const live = (over: Partial<Capability> = {}): Capability => ({ id: 'CAP-X', title: 'x', requirements: [], kind: 'live', status: 'pass', evidence: ['README.md'], provider: 'claude_agent', ...over });
  const reg = (admission: string, live_evidence: unknown = null): RegistryEntry[] => [{ capability: { provider: 'claude_agent', admission }, evidence: { live_evidence } }];

  test('the gate refuses a live pass on mock evidence or without admitted live evidence, a manual pass not recorded by the user, a pass without evidence, an unknown status', () => {
    const p: string[] = [];
    expect(passes(live({ mock_only: true }), reg('approved', { run: 1 }), p)).toBe(false);
    expect(passes(live(), reg('requires_verification'), p)).toBe(false);
    expect(passes(live(), reg('approved', null), p)).toBe(false);
    expect(passes(live(), reg('approved', { ran_inside_sandbox: true }), [])).toBe(true);
    expect(passes({ ...live(), kind: 'manual' }, [], p)).toBe(false);
    expect(passes({ ...live(), kind: 'manual', user_record: { checked_by: 'claude', checked_at: '2026-10-10', evidence: 'x' } }, [], p)).toBe(false);
    expect(passes({ ...live(), kind: 'manual', user_record: { checked_by: 'user', checked_at: '2026-10-10', evidence: 'x' } }, [], [])).toBe(true);
    expect(passes({ ...live(), kind: 'automated', evidence: [] }, [], p)).toBe(false);
    expect(passes({ ...live(), kind: 'automated', status: 'done' as never }, [], p)).toBe(false);
    expect(p.length).toBe(7);
    // not_run, blocked and manual_pending never count, and say nothing wrong
    for (const status of ['not_run', 'blocked', 'manual_pending'] as const) {
      const q: string[] = [];
      expect(passes({ ...live(), status }, [], q)).toBe(false);
      expect(q).toEqual([]);
    }
  });

  test('a capability relabelled as another kind (live or manual as automated) is refused (review m1)', () => {
    for (const id of ['CAP-PROVIDER-CLAUDE-LIVE', 'CAP-SANDBOX-LIVE', 'CAP-USER-PILOT', 'CAP-SCOPE-ACCEPT']) {
      const forged = caps().map((x) => (x.id === id ? { ...x, kind: 'automated' as const, provider: undefined, status: 'pass' as const, evidence: ['README.md'] } : x));
      const d = evaluateRelease(forged, registry());
      expect(d.level, id).toBe('refused');
      expect(d.problems.join(), id).toMatch(new RegExp(`${id}: is (live|manual)`));
    }
    const otherProvider = caps().map((x) => (x.id === 'CAP-PROVIDER-CLAUDE-LIVE' ? { ...x, provider: 'mock' } : x));
    expect(evaluateRelease(otherProvider, registry()).problems.join()).toMatch(/CAP-PROVIDER-CLAUDE-LIVE: is live \(claude_agent\), recorded as live \(mock\)/);
  });

  test('the export scope reductions decided under delegation are shown to the user, not hidden in a plain pass (review M1)', () => {
    const md = report();
    const exp = caps().find((x) => x.id === 'CAP-EXPORT')!;
    for (const limit of ['CSL', 'OMML', '그림', '일관성']) expect(exp.title, limit).toContain(limit);
    for (const decision of ['학술지별 CSL 양식은 DOCX에 적용하지 않는다', 'OMML', '전체 일관성 검사', 'LibreOffice', '기울임']) expect(md, decision).toContain(decision);
    expect(caps().find((x) => x.id === 'CAP-SCOPE-ACCEPT')!.status).not.toBe('pass');
  });

  test('a record that overclaims is refused as a whole; one that drops a capability is refused', () => {
    const c = caps();
    const forged = c.map((x) => (x.id === 'CAP-PROVIDER-CLAUDE-LIVE' ? { ...x, status: 'pass' as const, mock_only: true } : x));
    expect(evaluateRelease(forged, registry()).level).toBe('refused');
    const dropped = c.filter((x) => x.id !== 'CAP-USER-PILOT');
    expect(evaluateRelease(dropped, registry()).problems.join()).toMatch(/CAP-USER-PILOT: required by personal_v1 but missing/);
    const pilotByAi = c.map((x) => (x.id === 'CAP-USER-PILOT' ? { ...x, status: 'pass' as const, user_record: { checked_by: 'claude', checked_at: '2026-10-10', evidence: 'x' } } : x));
    expect(evaluateRelease(pilotByAi, registry()).level).toBe('refused');
  });

  test('live provider capabilities cannot pass while the registry has not admitted the provider on live evidence', () => {
    const r = registry();
    for (const c of caps().filter((x) => x.kind === 'live' && x.provider)) {
      const e = r.find((x) => x.capability.provider === c.provider);
      if (!e || e.capability.admission !== 'approved' || !e.evidence.live_evidence) expect(c.status, c.id).not.toBe('pass');
    }
    // and the registry today: both real providers wait for live verification
    for (const p of ['claude_agent', 'codex']) expect(r.find((x) => x.capability.provider === p)?.capability.admission).toBe('requires_verification');
  });

  test('the report makes no product-complete claim unless the gate says v1, and says that AI answers are MOCK', () => {
    const d = evaluateRelease(caps(), registry());
    const md = report();
    if (!d.v1) expect(md.match(OVERCLAIM)?.[0] ?? null).toBeNull();
    // the disclosure itself: every AI result is the MOCK provider's, and no real provider call was made
    expect(md).toMatch(/모든 AI 결과[^\n]*MOCK 공급자의 것이다/);
    expect(md).toMatch(/승인되거나 근거가 기록된 실제 Claude Code·Codex 호출은 없다/);
    // the one unapproved call is disclosed in the MOCK statement itself, not denied there (review m2)
    const mockSection = md.slice(md.indexOf('**MOCK 표시**'), md.indexOf('## 필수 capability'));
    expect(mockSection).toMatch(/PW-004 사고[^\n]*claude -p/);
    expect(mockSection).not.toMatch(/한 번도 하지 않았다/);
    for (const phrase of ['v1 완료', 'v1 완성', '완성된 제품', 'production-ready', '모든 기능 검증', '실제 AI로 검증됨', '출시 준비 완료']) expect(OVERCLAIM.test(phrase), phrase).toBe(true);
  });

  test('the security gate and the user pilot are reported as what they are', () => {
    const audit = JSON.parse(read('reports/security/audit.json')) as { gate: { decision: string } };
    const sec = caps().find((x) => x.id === 'CAP-SECURITY-GATE')!;
    if (audit.gate.decision !== 'allowed') expect(sec.status).not.toBe('pass');
    expect(report()).toContain(audit.gate.decision);
    const pilot = JSON.parse(read('reports/release/pilot.json')) as { status: string; checked_by: string | null };
    const cap = caps().find((x) => x.id === 'CAP-USER-PILOT')!;
    if (pilot.status !== 'passed' || pilot.checked_by !== 'user') expect(cap.status).toBe('manual_pending');
  });

  test('every level names only capabilities the record has, and v1 needs them all', () => {
    const all = new Set(caps().map((x) => x.id));
    for (const l of LEVELS) for (const n of l.needs) expect(all.has(n), n).toBe(true);
    expect(new Set(LEVELS.flatMap((l) => l.needs)).size).toBe(all.size);
  });

  test('every capability a level needs has its kind fixed in the gate, and only those (re-review n1)', () => {
    const needed = [...new Set(LEVELS.flatMap((l) => l.needs))].sort();
    expect(Object.keys(KIND_OF).sort()).toEqual(needed);
    for (const c of caps()) expect(c.kind, c.id).toBe(KIND_OF[c.id]!.kind);
  });
});
