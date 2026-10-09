// PW-030 — LIVE smoke against the real Codex CLI app-server. MANUAL ONLY: run it yourself, on your own
// machine, as the runtime OS user. Never part of `pnpm test`. One short synthetic turn (no paper data);
// it uses a little of your plan's quota.
//
// Before:
//   1. mkdir -m 700 ~/.local/state/paper-workspace/codex-profile   (NOT ~/.codex)
//      CODEX_HOME=~/.local/state/paper-workspace/codex-profile codex login   (no AGENTS.md, no config.toml)
//   2. node spikes/isolation/tools/auth-sentinel.mjs > /tmp/sentinel.json   (must say codex: isolated)
// Run:
//   node --experimental-strip-types tests/integration/providers/codex-live-smoke.manual.ts \
//     --profile ~/.local/state/paper-workspace/codex-profile --sentinel /tmp/sentinel.json \
//     --approve-live-smoke --codex "$(command -v codex)" --out reports/p03/evidence/codex-live.json
// It first verifies that the outer sandbox works on this host (no model call), then runs: initialize,
// one thread, one turn ("Reply with the word READY."), and records: CLI version, host, time, the event
// kinds seen, whether READY came back, and usage. No tokens, no secrets.
// RFC-010: the app-server (and its `--version` check) runs INSIDE the sandbox, as the worker runs it,
// with network only to the Codex hosts through the run's egress proxy (the evidence lists what it
// contacted); so the evidence says ran_inside_sandbox: true. Optional: --cli-root <install folder>.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { decideCodexCall, startCodexServer, type CodexSentinel } from '../../../packages/providers/src/codex/index.ts';
import { loadRegistry } from '../../../packages/providers/src/core/index.ts';
import { verifyOuterSandbox } from '../../../infra/sandbox/sandbox.ts';
import { defaultRunsRoot } from '../../../apps/worker/src/runner/index.ts';
import { smokeBackend, withSandboxedRun } from './sandboxed-smoke.manual-helper.ts';

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const expand = (p?: string) => (p?.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const profile = expand(opt('--profile'));
const sentinelFile = expand(opt('--sentinel'));
const out = expand(opt('--out'));
const codex = expand(opt('--codex'));
if (!argv.includes('--approve-live-smoke') || !profile || !sentinelFile || !out || !codex || !path.isAbsolute(codex)) {
  console.error('not run: needs --approve-live-smoke, --profile, --sentinel, --out and --codex <absolute path> (see the header)');
  process.exit(2);
}
const version = /(\d+\.\d+\.\d+)/.exec(spawnSync(codex, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH } }).stdout ?? '')?.[1];
const runsRoot = defaultRunsRoot();
const backend = smokeBackend();
const sandbox = await verifyOuterSandbox({ backend, runsRoot, nodeRoot: path.dirname(path.dirname(process.execPath)) });
if (!sandbox.verified) { console.error(`not run: the outer sandbox failed its checks: ${sandbox.failures.join(', ')}`); process.exit(2); }
const all = JSON.parse(fs.readFileSync(sentinelFile, 'utf8')) as { codex?: CodexSentinel };
const sentinel = all.codex ? { ...all.codex, provider: 'codex' } as CodexSentinel : null;
const decision = decideCodexCall(loadRegistry(), { key: { version: `codex-cli ${version}`, auth_mode: 'chatgpt_login', deployment_profile: 'PERSONAL_LOCAL' }, purpose: 'live_smoke', approval: { approved: true, max_turns: 1, budget_usd: 0.1 }, sentinel, sandbox });
if (!decision.allowed) { console.error(`not run: ${decision.reason}`); process.exit(2); }

const evidence: Record<string, unknown> = { checked_at: new Date().toISOString(), host: os.hostname(), cli_version: `codex-cli ${version}`, host_sandbox_checked: { kind: sandbox.kind, verified: sandbox.verified }, ran_inside_sandbox: true, tests: ['PW-030 codex live smoke (RFC-010: inside the sandbox)'] };
try {
  const r = await withSandboxedRun({ provider: 'codex', cli: codex!, cliRoot: expand(opt('--cli-root')), profile: profile!, backend }, async ({ run, launcher, parentEnv, stateDir }) => {
    const server = await startCodexServer({ decision, cmd: codex!, run, profileDir: stateDir, launcher, parentEnv });
    const thread = await server.startThread();
    const kinds: string[] = [];
    let text = '';
    for await (const e of server.runTurn(thread, 'Reply with the word READY.')) {
      kinds.push(e.kind);
      if (e.kind === 'text_delta' || e.kind === 'message_completed') text += (e.data as { text: string }).text;
      if (e.kind === 'usage') evidence.usage = e.data;
    }
    await server.close();
    return { kinds, text };
  });
  Object.assign(evidence, { event_kinds: [...new Set(r.value.kinds)], ready: /READY/.test(r.value.text), egress: r.egress, passed: /READY/.test(r.value.text) && r.value.kinds.includes('turn_completed') });
} catch (e) {
  Object.assign(evidence, { passed: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n');
console.log(`written ${out}: passed=${String(evidence.passed)}`);
