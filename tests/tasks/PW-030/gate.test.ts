// PW-030 — the provider integration report against the shipped registry.
// TST-030A: the report separates providers actually executed from adapters never run.
// TST-030B: nothing without account/terms/cost approval and live evidence is recorded as passed or as
//   "v1 integration complete".
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry } from '../../../packages/providers/src/core/index.ts';

const REPORT = path.resolve('reports/p03/PROVIDER_INTEGRATION.md');
type Row = { provider: string; live: 'executed' | 'not_run' | 'blocked'; reason?: string; evidence?: string[]; stand_in?: string; manual?: string };
type Open = { item: string; status: 'open' | 'blocked' | 'done'; why: string };
// a path the report cites must be a file inside this repository's tests/ or reports/ (review MINOR-1)
const repoFile = (p: unknown) => {
  if (typeof p !== 'string' || !p || path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) return false;
  if (!/^(tests|reports)\//.test(p)) return false;
  return fs.statSync(path.resolve(p), { throwIfNoEntry: false })?.isFile() === true;
};
function readReport() {
  const md = fs.readFileSync(REPORT, 'utf8');
  const m = /```json\n([\s\S]*?)\n```/.exec(md);
  if (!m) throw new Error('the report has no machine-readable status block');
  return { md, status: JSON.parse(m[1]!) as { providers: Row[]; open_items: Open[]; v1_provider_integration_complete: boolean } };
}
const realProviders = ['claude_agent', 'codex'];
const approved = (provider: string) => loadRegistry().entries.some((e) => e.capability.provider === provider && e.capability.admission === 'approved');

describe('TST-030A: executed and not executed are told apart', () => {
  test('every provider has exactly one row, with live = executed | not_run | blocked', () => {
    const { status } = readReport();
    expect(status.providers.map((r) => r.provider).sort()).toEqual(['claude_agent', 'codex', 'mock']);
    for (const r of status.providers) expect(['executed', 'not_run', 'blocked'], r.provider).toContain(r.live);
  });
  test('an executed row names evidence that exists; a not-run row says why and how to run it', () => {
    const { status } = readReport();
    for (const r of status.providers) {
      if (r.live === 'executed') {
        expect(r.evidence?.length, r.provider).toBeGreaterThan(0);
        for (const e of r.evidence!) expect(repoFile(e), e).toBe(true);
      } else {
        expect(r.reason, r.provider).toMatch(/\S{10,}/);
        expect(repoFile(r.manual), `${r.provider} manual script`).toBe(true);
      }
    }
  });
});

describe('TST-030B: no pass without approval and live evidence', () => {
  test('a real provider is "executed" only if the registry approved it with live evidence', () => {
    const { status } = readReport();
    for (const p of realProviders) {
      const row = status.providers.find((r) => r.provider === p)!;
      if (!approved(p)) expect(row.live, `${p} is not approved in the registry`).not.toBe('executed');
    }
  });
  // review MINOR-2: "complete" needs every real provider approved AND nothing left open (sandboxed
  // runs, the paragraph draft …); approval alone never forces it
  test('v1 provider integration is complete only when every provider is approved and no item is open; the text never claims it otherwise', () => {
    const { md, status } = readReport();
    expect(Array.isArray(status.open_items)).toBe(true);
    const done = realProviders.every(approved) && status.open_items.every((o) => o.status === 'done');
    if (status.v1_provider_integration_complete) expect(done, 'complete claimed with something open').toBe(true);
    if (!done) {
      expect(status.v1_provider_integration_complete).toBe(false);
      const prose = md.replace(/```json[\s\S]*?```/, '');
      expect(prose).not.toMatch(/(연동|통합|integration)[^\n]{0,15}(완료|끝났|complete|done)|(완료|complete)[^\n]{0,10}(연동|통합|integration)|모두 통과/i);
    }
    for (const o of status.open_items) expect(o.why, o.item).toMatch(/\S{10,}/);
    // re-review nit: the known open items cannot be dropped from the list; "providers inside the
    // sandbox" is done only when the adapters really launch through the sandbox (source check)
    const items = new Map(status.open_items.map((o) => [o.item, o]));
    for (const required of ['providers_inside_sandbox', 'worker_provider_run_path', 'paragraph_draft_from_outline']) expect(items.has(required), required).toBe(true);
    const launchesSandboxed = ['packages/providers/src/claude/turn.ts', 'packages/providers/src/codex/server.ts'].every((f) => /runSandboxed|startRunProcess/.test(fs.readFileSync(path.resolve(f), 'utf8')));
    if (items.get('providers_inside_sandbox')!.status === 'done') expect(launchesSandboxed, 'providers_inside_sandbox marked done but the adapters do not launch through the sandbox').toBe(true);
  });
  test('the shipped registry approves no real provider yet (live smoke not run here)', () => {
    for (const p of realProviders) expect(approved(p), p).toBe(false);
  });
});
