// PW-004 — TST-004A / TST-004B (mechanics with a fake CLI; live provider runs are blocked in P00)
// Revised after the independent P00 review (M4–M7 and minor findings).
// Run: node --test --test-timeout=30000 'tests/tasks/PW-004/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  prepareRun,
  buildChildEnv,
  buildClaudeArgs,
  buildCodexArgs,
  assertSafeClaudeArgs,
  spawnIsolated,
  startProviderRun,
  cancelRun,
  collectStreamJson,
  createCodexRpcGuard,
  checkAuthIsolation,
  CODEX_DISABLED_FEATURES,
  groupStillOurs,
  defaultRunsRoot,
} from '../../../spikes/isolation/runner.mjs';
import { loadCodexRpcPolicy, loadRegistry, decideModelCall } from '../../../spikes/provider-admission/admission.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = path.join(here, 'fake-cli.mjs');
const FAKE_AUTH = path.join(here, 'fake-auth-cli.mjs');
const IS_ROOT = process.getuid && process.getuid() === 0;
// When the suite runs as root, the fake provider runs as `nobody`, as the real runtime user would.
const RUNTIME_OWNER = IS_ROOT ? { uid: 65534, gid: 65534 } : null;

function hashTree(dir) {
  const h = createHash('sha256');
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    h.update(name);
    h.update(fs.statSync(p).isDirectory() ? hashTree(p) : fs.readFileSync(p));
  }
  return h.digest('hex');
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw004-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (RUNTIME_OWNER) fs.chmodSync(root, 0o711); // the runtime user only needs to traverse
  const devHome = path.join(root, 'dev-home');
  fs.mkdirSync(path.join(devHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(devHome, '.claude', '.credentials.json'), 'DEV-SENTINEL');
  const research = path.join(root, 'research');
  fs.mkdirSync(research);
  fs.writeFileSync(path.join(research, 'results.tsv'), 'gene\tfold\nABC1\t2.4\n');
  fs.writeFileSync(path.join(research, 'notes.md'), 'raw notes');
  const authProfile = path.join(root, 'runtime-auth', 'claude');
  fs.mkdirSync(authProfile, { recursive: true, mode: 0o700 });
  // the runtime auth profile belongs to the runtime user, not to the control plane
  if (RUNTIME_OWNER) fs.chownSync(authProfile, RUNTIME_OWNER.uid, RUNTIME_OWNER.gid);
  const parentEnv = {
    PATH: process.env.PATH,
    HOME: devHome,
    ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
    OPENAI_API_KEY: 'sk-should-not-leak',
    CLAUDE_CODE_OAUTH_TOKEN: 'dev-token-should-not-leak',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    DATABASE_URL: 'postgres://prod',
  };
  return { root, runsRoot: path.join(root, 'runs'), devHome, research, authProfile, parentEnv };
}

// An admission issued by decideModelCall, as the server would produce once a provider is admitted.
// Test-only registry change: the fake CLI stands in for an admitted Claude provider.
function issuedAdmission(provider = 'claude_agent') {
  const registry = loadRegistry();
  const auth_mode = provider === 'claude_agent' ? 'subscription_cli_login' : 'chatgpt_login';
  const entry = registry.entries.find((e) => e.capability.provider === provider && e.capability.auth_mode === auth_mode && e.capability.deployment_profile === 'PERSONAL_LOCAL');
  entry.capability.admission = 'approved';
  entry.evidence.live_evidence = { note: 'test only: fake CLI' };
  const authSentinel = { provider, status: 'isolated', host: os.hostname(), checked_at: new Date().toISOString() };
  const d = decideModelCall(registry, { provider, auth_mode, deployment_profile: 'PERSONAL_LOCAL', userApprovedUsage: true, authSentinel });
  assert.equal(d.allowed, true);
  return d;
}

function runFake(ctx, { sessionId, resumeSessionId, mode = 'normal' }) {
  const run = prepareRun({ runsRoot: ctx.runsRoot, runId: randomUUID(), inputs: [{ sourceRoot: ctx.research, relPath: 'results.tsv' }], owner: RUNTIME_OWNER });
  const env = { ...buildChildEnv({ provider: 'claude_agent', authProfileDir: ctx.authProfile, run, parentEnv: ctx.parentEnv, homes: [ctx.devHome], owner: RUNTIME_OWNER }), FAKE_MODE: mode };
  const args = buildClaudeArgs({ sessionId, resumeSessionId, mcpConfigPath: path.join(run.dir, 'mcp.json') });
  const handle = startProviderRun({ admission: issuedAdmission(), provider: 'claude_agent', cmd: process.execPath, cmdPrefix: [FAKE_CLI], args, env, run, owner: RUNTIME_OWNER });
  return { run, args, handle };
}
const record = (run) => JSON.parse(fs.readFileSync(path.join(run.cwd, 'fake-cli-record.json'), 'utf8'));

// ---------- TST-004A ----------

test('TST-004A: a new run gets the explicit session id we chose and reports it back', async (t) => {
  const ctx = setup(t);
  const sessionId = randomUUID();
  const { run, handle } = runFake(ctx, { sessionId });
  const out = await collectStreamJson(handle, { expectedSessionId: sessionId });
  assert.equal(out.exitCode, 0);
  assert.equal(out.sessionId, sessionId);
  assert.equal(out.result.subtype, 'success');
  const rec = record(run);
  assert.equal(rec.argv[rec.argv.indexOf('--session-id') + 1], sessionId);
  assert.ok(!rec.argv.includes('--resume'));
  if (RUNTIME_OWNER) assert.equal(fs.statSync(path.join(run.cwd, 'fake-cli-record.json')).uid, RUNTIME_OWNER.uid, 'provider ran as the runtime user');
});

test('TST-004A: resume passes exactly the stored session id', async (t) => {
  const ctx = setup(t);
  const stored = randomUUID();
  const { run, handle } = runFake(ctx, { resumeSessionId: stored });
  const out = await collectStreamJson(handle, { expectedSessionId: stored });
  assert.equal(out.sessionId, stored);
  const rec = record(run);
  assert.deepEqual(rec.argv.slice(rec.argv.indexOf('--resume'), rec.argv.indexOf('--resume') + 2), ['--resume', stored]);
});

test('TST-004A: a provider reporting a different session id is flagged, not adopted', async (t) => {
  const ctx = setup(t);
  const sessionId = randomUUID();
  const { handle } = runFake(ctx, { sessionId, mode: 'wrong_session' });
  const out = await collectStreamJson(handle, { expectedSessionId: sessionId });
  assert.equal(out.sessionMismatch, true);
  assert.equal(out.sessionId, sessionId);
});

test('TST-004A: interrupt ends the run and its process group only', async (t) => {
  const ctx = setup(t);
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  t.after(() => bystander.kill('SIGKILL'));
  const { run, handle } = runFake(ctx, { sessionId: randomUUID(), mode: 'long' });
  const gcPidFile = path.join(run.cwd, 'grandchild.pid');
  for (let i = 0; i < 100 && !fs.existsSync(gcPidFile); i++) await new Promise((r) => setTimeout(r, 30));
  const grandchild = Number(fs.readFileSync(gcPidFile, 'utf8'));
  const result = await cancelRun(handle, { graceMs: 1500 });
  assert.equal(result.signals[0], 'SIGINT');
  assert.ok(result.exited);
  await new Promise((r) => setTimeout(r, 100));
  // A killed process can linger as a zombie when PID 1 does not reap orphans (seen in the dev
  // container); a zombie runs no code, so it counts as terminated.
  const alive = (pid) => {
    try { process.kill(pid, 0); } catch { return false; }
    try { return !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return true; }
  };
  assert.equal(alive(grandchild), false, 'grandchild in the run process group must be gone');
  assert.equal(alive(bystander.pid), true, 'unrelated process must survive');
});

test('TST-004A: the original research folder and the read-only input copy are both unchanged after a tampering run', async (t) => {
  const ctx = setup(t);
  const before = hashTree(ctx.research);
  const { run, handle } = runFake(ctx, { sessionId: randomUUID() });
  await collectStreamJson(handle, {});
  assert.equal(hashTree(ctx.research), before);
  assert.ok(!JSON.stringify(record(run)).includes(ctx.research), 'child must not learn the original path');
  // the provider always runs as a non-root runtime user here (root suite → nobody), so mode bits apply
  assert.equal(fs.readFileSync(path.join(run.inputsDir, 'results.tsv'), 'utf8'), fs.readFileSync(path.join(ctx.research, 'results.tsv'), 'utf8'));
  assert.equal(fs.statSync(path.join(run.inputsDir, 'results.tsv')).mode & 0o222, 0, 'input copy is read-only');
});

// ---------- TST-004B ----------

test('TST-004B: implicit continue / latest-session / unknown flags are refused (allowlist)', () => {
  assert.throws(() => buildClaudeArgs({ mcpConfigPath: '/x/mcp.json' }), /explicit/);
  assert.throws(() => buildClaudeArgs({ sessionId: randomUUID(), resumeSessionId: randomUUID(), mcpConfigPath: '/x' }), /both/);
  assert.throws(() => buildClaudeArgs({ sessionId: 'latest', mcpConfigPath: '/x' }), /uuid/);
  const good = buildClaudeArgs({ sessionId: randomUUID(), mcpConfigPath: '/run/mcp.json' });
  assert.deepEqual(assertSafeClaudeArgs(good), good);
  const replaceFlag = (flag, value) => { const a = [...good]; a[a.indexOf(flag) + 1] = value; return a; };
  const bad = [
    [...good, '-c'], [...good, '--continue'], [...good, '--resume'], [...good, '--resume=latest'], [...good, '--resume='],
    [...good, '-pc'], [...good, '--dangerously-skip-permissions'], [...good, '--add-dir', '/'], [...good, '--bare'],
    [...good, '--settings', '{}'], [...good, '--setting-sources', 'user'], [...good, '--plugin-url', 'https://x'],
    replaceFlag('--permission-mode', 'bypassPermissions'), replaceFlag('--session-id', 'latest'), replaceFlag('--tools', 'Bash'),
    replaceFlag('--allowedTools', 'Bash'), replaceFlag('--output-format', 'text'), replaceFlag('--mcp-config', 'relative.json'),
    good.filter((a) => a !== '--restricted'),
  ];
  for (const args of bad) assert.throws(() => assertSafeClaudeArgs(args), /refused/, args.join(' '));
});

test('TST-004B: symlinks, hardlinks, traversal and unsafe run roots cannot pull originals into a run', (t) => {
  const ctx = setup(t);
  const outside = path.join(ctx.root, 'secret.txt');
  fs.writeFileSync(outside, 'SECRET');
  fs.symlinkSync(outside, path.join(ctx.research, 'link.txt'));
  fs.symlinkSync(ctx.root, path.join(ctx.research, 'linkdir'));
  fs.linkSync(outside, path.join(ctx.research, 'hardlink.txt'));
  for (const relPath of ['link.txt', 'hardlink.txt', '../secret.txt', 'linkdir/secret.txt', '/etc/passwd', 'missing.txt']) {
    const runId = randomUUID();
    assert.throws(() => prepareRun({ runsRoot: ctx.runsRoot, runId, inputs: [{ sourceRoot: ctx.research, relPath }] }), /refused/, relPath);
    assert.equal(fs.existsSync(path.join(ctx.runsRoot, runId)), false, `refused run ${relPath} must not leave a partial directory`);
  }
  assert.throws(() => prepareRun({ runsRoot: ctx.runsRoot, runId: '../escape', inputs: [] }), /refused/);
  const loose = path.join(ctx.root, 'loose-runs');
  fs.mkdirSync(loose);
  fs.chmodSync(loose, 0o777);
  assert.throws(() => prepareRun({ runsRoot: loose, runId: randomUUID(), inputs: [] }), /refused/, 'world-writable runs root');
  // a run root below a folder with agent instructions would let the CLI auto-load them
  const repoLike = path.join(ctx.root, 'some-repo');
  fs.mkdirSync(repoLike);
  fs.writeFileSync(path.join(repoLike, 'CLAUDE.md'), '# dev instructions');
  assert.throws(() => prepareRun({ runsRoot: path.join(repoLike, 'runs'), runId: randomUUID(), inputs: [] }), /refused.*CLAUDE\.md/);
});

test('TST-004B: the child gets a fresh HOME and none of the parent credentials; profile aliases are refused', async (t) => {
  const ctx = setup(t);
  const { run, handle } = runFake(ctx, { sessionId: randomUUID() });
  await collectStreamJson(handle, {});
  const { env } = record(run);
  assert.equal(env.HOME, run.homeDir);
  assert.equal(env.CLAUDE_CONFIG_DIR, fs.realpathSync(ctx.authProfile));
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'SSH_AUTH_SOCK', 'DATABASE_URL']) assert.equal(env[k], undefined, k);
  assert.ok(!JSON.stringify(env).includes(ctx.devHome));
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  const alias = path.join(ctx.root, 'alias');
  fs.symlinkSync(path.join(ctx.devHome, '.claude'), alias);
  for (const bad of [path.join(ctx.devHome, '.claude'), alias, ctx.devHome]) {
    assert.throws(() => buildChildEnv({ provider: 'claude_agent', authProfileDir: bad, run, parentEnv: ctx.parentEnv, homes: [ctx.devHome], owner: RUNTIME_OWNER }), /refused/, bad);
  }
  const tokenFile = path.join(ctx.root, 'claude-token');
  fs.writeFileSync(tokenFile, 'runtime-token\n', { mode: 0o600 });
  const withToken = buildChildEnv({ provider: 'claude_agent', authProfileDir: ctx.authProfile, run, parentEnv: ctx.parentEnv, homes: [ctx.devHome], owner: RUNTIME_OWNER, oauthTokenFile: tokenFile });
  assert.equal(withToken.CLAUDE_CODE_OAUTH_TOKEN, 'runtime-token');
});

test('TST-004B: no provider process starts without an issued admission for that provider (M5, re-review)', (t) => {
  const ctx = setup(t);
  const run = prepareRun({ runsRoot: ctx.runsRoot, runId: randomUUID(), inputs: [] });
  const args = buildClaudeArgs({ sessionId: randomUUID(), mcpConfigPath: path.join(run.dir, 'mcp.json') });
  const base = { provider: 'claude_agent', cmd: process.execPath, cmdPrefix: [FAKE_CLI], args, env: { PATH: process.env.PATH }, run };
  assert.throws(() => startProviderRun({ ...base, admission: null }), /refused.*not issued/);
  assert.throws(() => startProviderRun({ ...base, admission: { allowed: true, provider: 'claude_agent' } }), /refused.*not issued/, 'forged look-alike');
  assert.throws(() => startProviderRun({ ...base, admission: decideModelCall(loadRegistry(), { provider: 'claude_agent', auth_mode: 'subscription_cli_login', deployment_profile: 'PERSONAL_LOCAL', userApprovedUsage: true }) }), /refused.*no admission/);
  assert.throws(() => startProviderRun({ ...base, admission: issuedAdmission('codex') }), /refused.*not claude_agent/);
});

test('TST-004B: the full argv is validated — nothing can be smuggled before -p or app-server (re-review N1/N2)', (t) => {
  const ctx = setup(t);
  const run = prepareRun({ runsRoot: ctx.runsRoot, runId: randomUUID(), inputs: [] });
  const good = buildClaudeArgs({ sessionId: randomUUID(), mcpConfigPath: path.join(run.dir, 'mcp.json') });
  const env = { PATH: process.env.PATH };
  const claude = (args, cmdPrefix = [FAKE_CLI]) => () => startProviderRun({ admission: issuedAdmission(), provider: 'claude_agent', cmd: process.execPath, cmdPrefix, args, env, run });
  assert.throws(claude(['--dangerously-skip-permissions', '--settings', '{}', ...good]), /refused/);
  assert.throws(claude(good, ['-e']), /refused.*cmdPrefix/);
  assert.throws(claude(good, [FAKE_CLI, '--dangerously-skip-permissions']), /refused.*cmdPrefix/);
  for (const mcp of ['/etc/mcp.json', path.join(run.dir, '..', 'other', 'mcp.json')]) {
    const bad = [...good];
    bad[bad.indexOf('--mcp-config') + 1] = mcp;
    assert.throws(claude(bad), /refused.*outside the run directory/, mcp);
  }
  const codex = (args) => () => startProviderRun({ admission: issuedAdmission('codex'), provider: 'codex', cmd: process.execPath, cmdPrefix: [FAKE_CLI], args, env, run });
  assert.throws(codex(['-c', 'sandbox_mode="danger-full-access"', '--dangerously-bypass-approvals-and-sandbox', ...buildCodexArgs({})]), /refused/);
  assert.throws(codex([...buildCodexArgs({}), '-c', 'sandbox_mode="danger-full-access"']), /refused/);
});

test('TST-004B: an agent instruction file that appears above the run after prepareRun blocks the start', (t) => {
  const ctx = setup(t);
  const run = prepareRun({ runsRoot: ctx.runsRoot, runId: randomUUID(), inputs: [] });
  fs.writeFileSync(path.join(ctx.root, 'CLAUDE.md'), 'planted later');
  const args = buildClaudeArgs({ sessionId: randomUUID(), mcpConfigPath: path.join(run.dir, 'mcp.json') });
  assert.throws(() => startProviderRun({ admission: issuedAdmission(), provider: 'claude_agent', cmd: process.execPath, cmdPrefix: [FAKE_CLI], args, env: { PATH: process.env.PATH }, run }), /refused.*CLAUDE\.md/);
});

test('TST-004B: leftover cleanup only targets a process group that is provably still ours', () => {
  const ours = { pgid: 500, leaderStart: 1000 };
  assert.equal(groupStillOurs(ours, [{ pid: 501, pgrp: 500, starttime: 1001, state: 'S' }]), true, 'leader gone, member alive → id cannot be recycled');
  assert.equal(groupStillOurs(ours, [{ pid: 500, pgrp: 500, starttime: 1000, state: 'S' }]), true, 'leader itself');
  assert.equal(groupStillOurs(ours, [{ pid: 500, pgrp: 500, starttime: 9000, state: 'S' }, { pid: 777, pgrp: 500, starttime: 9001, state: 'S' }]), false, 'recycled: new leader with a later start');
  assert.equal(groupStillOurs(ours, []), false, 'group empty');
  assert.equal(groupStillOurs(ours, null), false, 'no /proc → never kill blindly');
  assert.equal(groupStillOurs({ pgid: 500, leaderStart: null }, []), false);
});

test('TST-004B: a missing provider binary fails fast instead of hanging', async (t) => {
  const ctx = setup(t);
  const run = prepareRun({ runsRoot: ctx.runsRoot, runId: randomUUID(), inputs: [] });
  const handle = spawnIsolated({ cmd: path.join(ctx.root, 'no-such-cli'), args: [], env: { PATH: '/usr/bin' }, cwd: run.cwd });
  const out = await collectStreamJson(handle, {});
  assert.equal(out.exitCode, null);
  assert.match(String(out.spawnError), /ENOENT/);
});

test('TST-004B: no shell or file-tool surface is configured for either provider', () => {
  const args = buildClaudeArgs({ sessionId: randomUUID(), mcpConfigPath: '/run/mcp.json' });
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
  for (const f of ['--strict-mcp-config', '--restricted', '--disable-slash-commands']) assert.ok(args.includes(f), f);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__paper');

  const codexArgs = buildCodexArgs({});
  assert.equal(codexArgs[0], 'app-server');
  assert.equal(codexArgs[codexArgs.indexOf('--listen') + 1], 'stdio://');
  assert.ok(codexArgs.includes('sandbox_mode="read-only"'));
  assert.ok(codexArgs.includes('approval_policy="on-request"'), 'sandbox escalations must come to us for approval (and be declined)');
  for (const f of ['shell_tool', 'browser_use', 'computer_use', 'apps', 'view_image']) assert.ok(CODEX_DISABLED_FEATURES.includes(f) && codexArgs.includes(`features.${f}=false`), f);
  assert.throws(() => buildCodexArgs({ listen: 'ws://0.0.0.0:4500' }), /refused/);

  const guard = createCodexRpcGuard(loadCodexRpcPolicy());
  for (const m of ['thread/shellCommand', 'command/exec', 'fs/writeFile', 'fs/readFile', 'account/rateLimitResetCredit/consume']) assert.throws(() => guard.clientRequest(m), /refused/, m);
  assert.doesNotThrow(() => guard.clientRequest('turn/start'));
  assert.equal(guard.serverRequest('item/commandExecution/requestApproval'), 'decline');
  assert.equal(guard.serverRequest('item/tool/call'), 'route_to_tool_gateway');
  assert.equal(guard.serverRequest('some/unknown/request'), 'decline');
});

test('TST-004B: an empty runtime profile that still reports a login is detected as a credential leak', async (t) => {
  const ctx = setup(t);
  for (const [provider, mode, expected] of [
    ['claude_agent', 'leak', 'leak'],
    ['claude_agent', 'clean', 'isolated'],
    ['claude_agent', 'garbage', 'unknown'],
    ['codex', 'leak', 'leak'],
    ['codex', 'clean', 'isolated'],
  ]) {
    const run = prepareRun({ runsRoot: ctx.runsRoot, runId: randomUUID(), inputs: [] });
    const res = await checkAuthIsolation({ provider, cmd: process.execPath, cmdPrefix: [FAKE_AUTH], run, parentEnv: ctx.parentEnv, homes: [ctx.devHome], extraEnv: { FAKE_AUTH_MODE: mode } });
    assert.equal(res.status, expected, `${provider}/${mode}: ${JSON.stringify(res)}`);
    assert.equal(res.provider, provider);
  }
});

// ---------- no-sudo run location (user decision 2026-10-08: own account, no sudo) ----------

test('TST-004B: the default runs root needs no sudo — XDG_RUNTIME_DIR first, private /tmp folder otherwise', (t) => {
  const ctx = setup(t);
  const uid = process.getuid();
  const xdg = path.join(ctx.root, 'run-user');
  fs.mkdirSync(xdg, { mode: 0o700 });
  fs.chmodSync(xdg, 0o700);
  const a = defaultRunsRoot({ env: { XDG_RUNTIME_DIR: xdg }, uid, tmp: ctx.root });
  assert.equal(a.kind, 'xdg_runtime');
  assert.equal(a.runsRoot, path.join(xdg, 'paper-workspace', 'runs'));
  // usable straight away: no agent-config files above it
  const run = prepareRun({ runsRoot: a.runsRoot, runId: randomUUID(), inputs: [] });
  assert.ok(fs.existsSync(run.cwd));

  // unset or unsafe XDG dir → private folder under tmp
  fs.chmodSync(xdg, 0o777);
  for (const env of [{}, { XDG_RUNTIME_DIR: xdg }, { XDG_RUNTIME_DIR: path.join(ctx.root, 'missing') }]) {
    const b = defaultRunsRoot({ env, uid, tmp: ctx.root });
    assert.equal(b.kind, 'tmp_private', JSON.stringify(env));
    assert.equal(b.runsRoot, path.join(ctx.root, `paper-workspace-${uid}`, 'runs'));
    assert.equal(fs.statSync(path.dirname(b.runsRoot)).mode & 0o077, 0, 'private parent');
  }
});

test('TST-004B: a pre-created /tmp folder owned by someone else, or made loose, is refused', (t) => {
  const ctx = setup(t);
  const uid = process.getuid();
  const squat = path.join(ctx.root, `paper-workspace-${uid}`);
  fs.mkdirSync(squat);
  fs.chmodSync(squat, 0o777);
  assert.throws(() => defaultRunsRoot({ env: {}, uid, tmp: ctx.root }), /refused/, 'world-writable');
  if (IS_ROOT) {
    fs.chmodSync(squat, 0o700);
    fs.chownSync(squat, 65534, 65534);
    assert.throws(() => defaultRunsRoot({ env: {}, uid, tmp: ctx.root }), /refused.*owned/, 'owned by another user');
  }
});
