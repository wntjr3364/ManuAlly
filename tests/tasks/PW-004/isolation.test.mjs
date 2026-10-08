// PW-004 — TST-004A / TST-004B (mechanics with a fake CLI; live provider runs are blocked in P00)
// Run: node --test 'tests/tasks/PW-004/*.test.mjs'
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
  cancelRun,
  collectStreamJson,
  createCodexRpcGuard,
} from '../../../spikes/isolation/runner.mjs';
import { loadCodexRpcPolicy } from '../../../spikes/provider-admission/admission.mjs';

const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pw004-'));

function hashTree(dir) {
  const h = createHash('sha256');
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    h.update(name);
    h.update(fs.statSync(p).isDirectory() ? hashTree(p) : fs.readFileSync(p));
  }
  return h.digest('hex');
}

function setup() {
  const root = tmp();
  const devHome = path.join(root, 'dev-home');
  fs.mkdirSync(path.join(devHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(devHome, '.claude', '.credentials.json'), 'DEV-SENTINEL');
  const research = path.join(root, 'research');
  fs.mkdirSync(research);
  fs.writeFileSync(path.join(research, 'results.tsv'), 'gene\tfold\nABC1\t2.4\n');
  fs.writeFileSync(path.join(research, 'notes.md'), 'raw notes');
  const authProfile = path.join(root, 'runtime-auth', 'claude');
  fs.mkdirSync(authProfile, { recursive: true });
  const parentEnv = {
    PATH: process.env.PATH,
    HOME: devHome,
    ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
    OPENAI_API_KEY: 'sk-should-not-leak',
    CLAUDE_CODE_OAUTH_TOKEN: 'dev-token-should-not-leak',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    DATABASE_URL: 'postgres://prod',
  };
  return { root, devHome, research, authProfile, parentEnv };
}

async function runFake(ctx, { sessionId, resumeSessionId, mode = 'normal' }) {
  const run = prepareRun({ runsRoot: path.join(ctx.root, 'runs'), runId: randomUUID(), inputs: [{ sourceRoot: ctx.research, relPath: 'results.tsv' }] });
  const env = { ...buildChildEnv({ provider: 'claude_agent', authProfileDir: ctx.authProfile, run, parentEnv: ctx.parentEnv }), FAKE_MODE: mode };
  const args = buildClaudeArgs({ sessionId, resumeSessionId, mcpConfigPath: path.join(run.dir, 'mcp.json') });
  const handle = spawnIsolated({ cmd: process.execPath, args: [FAKE_CLI, ...args], env, cwd: run.cwd });
  return { run, args, handle };
}

// ---------- TST-004A ----------

test('TST-004A: a new run gets the explicit session id we chose and reports it back', async () => {
  const ctx = setup();
  const sessionId = randomUUID();
  const { run, handle } = await runFake(ctx, { sessionId });
  const out = await collectStreamJson(handle, { expectedSessionId: sessionId });
  assert.equal(out.exitCode, 0);
  assert.equal(out.sessionId, sessionId);
  assert.equal(out.result.subtype, 'success');
  const rec = JSON.parse(fs.readFileSync(path.join(run.cwd, 'fake-cli-record.json'), 'utf8'));
  assert.equal(rec.argv[rec.argv.indexOf('--session-id') + 1], sessionId);
  assert.ok(!rec.argv.includes('--resume'));
});

test('TST-004A: resume passes exactly the stored session id', async () => {
  const ctx = setup();
  const stored = randomUUID();
  const { run, handle } = await runFake(ctx, { resumeSessionId: stored });
  const out = await collectStreamJson(handle, { expectedSessionId: stored });
  assert.equal(out.sessionId, stored);
  const rec = JSON.parse(fs.readFileSync(path.join(run.cwd, 'fake-cli-record.json'), 'utf8'));
  assert.deepEqual(rec.argv.slice(rec.argv.indexOf('--resume'), rec.argv.indexOf('--resume') + 2), ['--resume', stored]);
});

test('TST-004A: a provider reporting a different session id is flagged, not adopted', async () => {
  const ctx = setup();
  const sessionId = randomUUID();
  const { handle } = await runFake(ctx, { sessionId, mode: 'wrong_session' });
  const out = await collectStreamJson(handle, { expectedSessionId: sessionId });
  assert.equal(out.sessionMismatch, true);
  assert.equal(out.sessionId, sessionId);
});

test('TST-004A: interrupt ends the run and its process group only', async () => {
  const ctx = setup();
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  const { run, handle } = await runFake(ctx, { sessionId: randomUUID(), mode: 'long' });
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
  bystander.kill();
});

test('TST-004A: the original research folder is byte-identical after a run that tampers with its copy', async () => {
  const ctx = setup();
  const before = hashTree(ctx.research);
  const { run, handle } = await runFake(ctx, { sessionId: randomUUID() });
  await collectStreamJson(handle, {});
  assert.equal(hashTree(ctx.research), before);
  const rec = JSON.parse(fs.readFileSync(path.join(run.cwd, 'fake-cli-record.json'), 'utf8'));
  assert.ok(!JSON.stringify(rec).includes(ctx.research), 'child must not learn the original path');
  // read-only copy was not modified either (root ignores mode bits, so only assert when not root)
  if (process.getuid && process.getuid() !== 0) assert.equal(fs.readFileSync(path.join(run.inputsDir, 'results.tsv'), 'utf8'), fs.readFileSync(path.join(ctx.research, 'results.tsv'), 'utf8'));
  assert.equal(fs.statSync(path.join(run.inputsDir, 'results.tsv')).mode & 0o222, 0, 'input copy is read-only');
});

// ---------- TST-004B ----------

test('TST-004B: implicit continue / latest-session / missing resume id are refused', () => {
  assert.throws(() => buildClaudeArgs({ mcpConfigPath: '/x/mcp.json' }), /explicit/);
  assert.throws(() => buildClaudeArgs({ sessionId: randomUUID(), resumeSessionId: randomUUID(), mcpConfigPath: '/x' }), /both/);
  assert.throws(() => buildClaudeArgs({ sessionId: 'latest', mcpConfigPath: '/x' }), /uuid/);
  for (const bad of [['-c'], ['--continue'], ['--resume'], ['--dangerously-skip-permissions'], ['--allow-dangerously-skip-permissions'], ['--add-dir', '/'], ['--bare'], ['--fork-session'], ['--remote-control'], ['--plugin-url', 'https://x']]) {
    assert.throws(() => assertSafeClaudeArgs(['-p', ...bad]), /refused/, bad.join(' '));
  }
});

test('TST-004B: symlinks, traversal and symlinked parents cannot pull originals into a run', () => {
  const ctx = setup();
  const outside = path.join(ctx.root, 'secret.txt');
  fs.writeFileSync(outside, 'SECRET');
  fs.symlinkSync(outside, path.join(ctx.research, 'link.txt'));
  fs.symlinkSync(ctx.root, path.join(ctx.research, 'linkdir'));
  const runsRoot = path.join(ctx.root, 'runs');
  for (const relPath of ['link.txt', '../secret.txt', 'linkdir/secret.txt', '/etc/passwd', 'missing.txt']) {
    assert.throws(() => prepareRun({ runsRoot, runId: randomUUID(), inputs: [{ sourceRoot: ctx.research, relPath }] }), /refused/, relPath);
  }
  // a run id that tries to escape the runs root is refused too
  assert.throws(() => prepareRun({ runsRoot, runId: '../escape', inputs: [] }), /refused/);
});

test('TST-004B: the child gets a fresh HOME and none of the parent credentials or sockets', async () => {
  const ctx = setup();
  const { run, handle } = await runFake(ctx, { sessionId: randomUUID() });
  await collectStreamJson(handle, {});
  const { env } = JSON.parse(fs.readFileSync(path.join(run.cwd, 'fake-cli-record.json'), 'utf8'));
  assert.equal(env.HOME, run.homeDir);
  assert.notEqual(env.HOME, ctx.devHome);
  assert.equal(env.CLAUDE_CONFIG_DIR, ctx.authProfile);
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'SSH_AUTH_SOCK', 'DATABASE_URL']) assert.equal(env[k], undefined, k);
  assert.ok(!JSON.stringify(env).includes(ctx.devHome));
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  // pointing the runtime at the developer config directory is refused
  assert.throws(() => buildChildEnv({ provider: 'claude_agent', authProfileDir: path.join(ctx.devHome, '.claude'), run, parentEnv: ctx.parentEnv, devHome: ctx.devHome }), /refused/);
  // a token, when used, comes from a secret file chosen by the server, never from the parent env
  const tokenFile = path.join(ctx.root, 'claude-token');
  fs.writeFileSync(tokenFile, 'runtime-token\n', { mode: 0o600 });
  const withToken = buildChildEnv({ provider: 'claude_agent', authProfileDir: ctx.authProfile, run, parentEnv: ctx.parentEnv, oauthTokenFile: tokenFile });
  assert.equal(withToken.CLAUDE_CODE_OAUTH_TOKEN, 'runtime-token');
});

test('TST-004B: no shell or file-tool surface is exposed to the model', () => {
  const args = buildClaudeArgs({ sessionId: randomUUID(), mcpConfigPath: '/run/mcp.json' });
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__paper');
  assert.ok(!args.some((a) => /Bash|Edit|Write|WebFetch/.test(a)));

  const codexArgs = buildCodexArgs({});
  assert.equal(codexArgs[0], 'app-server');
  assert.equal(codexArgs[codexArgs.indexOf('--listen') + 1], 'stdio://');
  assert.ok(codexArgs.includes('sandbox_mode="read-only"'));
  assert.throws(() => buildCodexArgs({ listen: 'ws://0.0.0.0:4500' }), /refused/);

  const guard = createCodexRpcGuard(loadCodexRpcPolicy());
  for (const m of ['thread/shellCommand', 'command/exec', 'fs/writeFile', 'fs/readFile', 'account/rateLimitResetCredit/consume']) assert.throws(() => guard.clientRequest(m), /refused/, m);
  assert.doesNotThrow(() => guard.clientRequest('turn/start'));
  assert.equal(guard.serverRequest('item/commandExecution/requestApproval'), 'decline');
  assert.equal(guard.serverRequest('item/fileChange/requestApproval'), 'decline');
  assert.equal(guard.serverRequest('item/tool/call'), 'route_to_tool_gateway');
  assert.equal(guard.serverRequest('some/unknown/request'), 'decline');
});

// ---------- auth isolation sentinel (added after the live negative check found a host-level credential) ----------
import { checkAuthIsolation } from '../../../spikes/isolation/runner.mjs';
const FAKE_AUTH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-auth-cli.mjs');

test('TST-004B: an empty runtime profile that still reports a login is detected as a credential leak', async () => {
  const ctx = setup();
  for (const [provider, mode, expected] of [
    ['claude_agent', 'leak', 'leak'],
    ['claude_agent', 'clean', 'isolated'],
    ['claude_agent', 'garbage', 'unknown'],
    ['codex', 'leak', 'leak'],
    ['codex', 'clean', 'isolated'],
  ]) {
    const run = prepareRun({ runsRoot: path.join(ctx.root, 'runs'), runId: randomUUID(), inputs: [] });
    const res = await checkAuthIsolation({ provider, cmd: process.execPath, cmdPrefix: [FAKE_AUTH], run, parentEnv: { ...ctx.parentEnv, FAKE_AUTH_MODE: mode }, extraEnv: { FAKE_AUTH_MODE: mode } });
    assert.equal(res.status, expected, `${provider}/${mode}: ${JSON.stringify(res)}`);
  }
});
