// PW-024 TST-024A — LIVE smoke against the real Claude Code CLI. MANUAL ONLY: run it yourself, on your
// own machine, as the runtime OS user, after logging an isolated profile in. Never part of `pnpm test`.
// It sends two short synthetic prompts (no paper data), so it uses a little of your subscription quota.
//
// Before:
//   1. mkdir -m 700 ~/.local/state/paper-workspace/claude-profile   (NOT ~/.claude)
//      CLAUDE_CONFIG_DIR=~/.local/state/paper-workspace/claude-profile claude   → /login, then exit
//   2. node spikes/isolation/tools/auth-sentinel.mjs > /tmp/sentinel.json   (must say claude_agent: isolated)
// Run:
//   node --experimental-strip-types tests/tasks/PW-024/live-smoke.manual.ts \
//     --profile ~/.local/state/paper-workspace/claude-profile --sentinel /tmp/sentinel.json \
//     --approve-live-smoke --budget-usd 0.10 --out reports/tasks/PW-024/live-evidence.json --claude "$(command -v claude)"
// It records: CLI version, the session id we chose, that resume continued it, init tools (must be
// []), exit codes and usage. No prompts' answers beyond the check word, no tokens, no paths of secrets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { decideClaudeCall, startClaudeTurn, type ClaudeRun, type Sentinel } from '../../../packages/providers/src/claude/index.ts';
import { loadRegistry } from '../../../packages/providers/src/core/index.ts';

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const expand = (p?: string) => (p?.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const profile = expand(opt('--profile'));
const sentinelFile = expand(opt('--sentinel'));
const out = expand(opt('--out'));
const claude = expand(opt('--claude'));
const budget = Number(opt('--budget-usd') ?? 0);
if (!argv.includes('--approve-live-smoke') || !profile || !sentinelFile || !out || !(budget > 0) || !claude || !path.isAbsolute(claude)) {
  console.error('not run: needs --approve-live-smoke, --profile, --sentinel, --budget-usd > 0, --out and --claude <absolute path> (see the header)');
  process.exit(2);
}
const version = spawnSync(claude!, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH } }).stdout.trim();
const sentinelAll = JSON.parse(fs.readFileSync(sentinelFile, 'utf8')) as { claude_agent?: Sentinel };
const sentinel = sentinelAll.claude_agent ? { ...sentinelAll.claude_agent, provider: 'claude_agent' } as Sentinel : null;
const decision = decideClaudeCall(loadRegistry(), { key: { version: `claude-code ${version.split(' ')[0]}`, auth_mode: 'subscription_cli_login', deployment_profile: 'PERSONAL_LOCAL' }, purpose: 'live_smoke', approval: { approved: true, max_turns: 2, budget_usd: budget }, sentinel });
if (!decision.allowed) { console.error(`not run: ${decision.reason}`); process.exit(2); }

function newRun(): ClaudeRun {
  const base = fs.mkdtempSync(path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), 'pw-smoke-'));
  const r = { dir: base, cwd: path.join(base, 'work'), homeDir: path.join(base, 'home'), tmpDir: path.join(base, 'tmp'), mcpConfigPath: path.join(base, 'mcp.json') };
  for (const d of [r.cwd, r.homeDir, r.tmpDir]) fs.mkdirSync(d, { mode: 0o700 });
  fs.writeFileSync(r.mcpConfigPath, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  return r;
}
async function turn(prompt: string, session: { new: string } | { resume: string }) {
  const t = startClaudeTurn({ decision, cmd: claude!, run: newRun(), profileDir: profile!, prompt, session, effort: 'low' });
  const events = [];
  for await (const e of t.events) events.push(e);
  return { events, result: await t.done };
}
const id = randomUUID();
const word = `PONG-${randomUUID().slice(0, 6)}`;
const first = await turn(`Reply with exactly this word and nothing else: ${word}`, { new: id });
const second = await turn('What word did you reply with in your previous message? Reply with that word only.', { resume: id });
const text = (r: typeof first) => r.events.filter((e) => e.kind === 'message_completed').map((e) => (e.data as { text: string }).text).join('');
const init = first.events.find((e) => e.kind === 'session_started');
const evidence = {
  task: 'PW-024 TST-024A live smoke', host: os.hostname(), checked_at: new Date().toISOString(), cli_version: version,
  session_id_chosen: id, session_id_reported: first.result.reportedSessionId, session_mismatch: first.result.sessionMismatch || second.result.sessionMismatch,
  init_tools: init?.kind === 'session_started' ? init.data.tools : null,
  first_ok: first.result.exitCode === 0 && text(first).includes(word),
  resume_ok: second.result.exitCode === 0 && text(second).includes(word),
  usage: [first, second].map((r) => r.events.filter((e) => e.kind === 'usage').at(-1)?.data ?? null),
  passed: false,
};
evidence.passed = evidence.first_ok && evidence.resume_ok && !evidence.session_mismatch && Array.isArray(evidence.init_tools) && evidence.init_tools.length === 0;
fs.writeFileSync(out, JSON.stringify(evidence, null, 1) + '\n');
console.log(`live smoke ${evidence.passed ? 'PASSED' : 'FAILED'} — evidence written to ${out}`);
process.exit(evidence.passed ? 0 : 1);
