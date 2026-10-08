// PW-004 spike: per-run isolation for provider CLIs (Claude Code `-p`, Codex `app-server`).
//
// What this layer guarantees (process level):
// - fresh HOME/TMPDIR per run, env built from a whitelist (no inherited keys, sockets or DB URLs)
// - auth comes from a dedicated runtime profile dir owned by the runtime user; anything that is,
//   contains or aliases (symlink/realpath) the developer's ~/.claude, ~/.codex or HOME is refused
// - only selected regular files are copied in, read-only; symlinks, hardlinks, traversal and
//   swapped files (O_NOFOLLOW + inode check) are refused; a refused run leaves nothing behind
// - runs never live below a folder holding agent instructions (CLAUDE.md, AGENTS.md, .claude, …)
// - explicit session ids only; Claude flags are validated against an allowlist
// - no built-in shell/file tools for Claude; Codex shell/browser/computer-use features are disabled
//   (except `unified_exec`, which 0.161.0 cannot disable — see PW-004 report)
// - a provider process starts only with an admission decision for that provider (auth sentinel)
// - cancel signals the run's own process group; leftovers are cleaned up only if they started
//   after the run leader (no blind kill of a recycled process-group id)
// What it does NOT guarantee: kernel-level isolation. A dedicated OS user plus a sandbox
// (bubblewrap/container) is still required on the deployment host (RFC-004).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { assertSafeProfileDir } from '../provider-admission/admission.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const refuse = (msg) => { throw new Error(`refused: ${msg}`); };
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const AGENT_CONFIG_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude', '.mcp.json', '.codex'];

function assertNoAgentConfigAbove(dir) {
  let cur = path.resolve(dir);
  while (!fs.existsSync(cur)) cur = path.dirname(cur);
  cur = fs.realpathSync(cur);
  for (;;) {
    for (const name of AGENT_CONFIG_NAMES) {
      if (fs.existsSync(path.join(cur, name))) refuse(`runs root ${dir} is below ${cur}, which contains ${name} (would be auto-loaded by the CLI)`);
    }
    const parent = path.dirname(cur);
    if (parent === cur) return;
    cur = parent;
  }
}

function assertSafeRunsRoot(runsRoot) {
  if (!path.isAbsolute(runsRoot)) refuse('runs root must be absolute');
  assertNoAgentConfigAbove(runsRoot);
  if (!fs.existsSync(runsRoot)) {
    fs.mkdirSync(runsRoot, { recursive: true });
    fs.chmodSync(runsRoot, 0o711); // traverse-only for the runtime user
  }
  const st = fs.lstatSync(runsRoot);
  if (st.isSymbolicLink() || !st.isDirectory()) refuse(`runs root ${runsRoot} must be a real directory`);
  if (st.mode & 0o022) refuse(`runs root ${runsRoot} is group/world-writable`);
  if (process.getuid && st.uid !== process.getuid()) refuse(`runs root ${runsRoot} is not owned by the control-plane user`);
  return fs.realpathSync(runsRoot);
}

function copyInput(run, { sourceRoot, relPath }) {
  if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) refuse(`input path must be relative without '..': ${relPath}`);
  const rootReal = fs.realpathSync(sourceRoot);
  const candidate = path.join(rootReal, relPath);
  let st;
  try { st = fs.lstatSync(candidate); } catch { refuse(`input does not exist: ${relPath}`); }
  if (st.isSymbolicLink()) refuse(`input is a symlink: ${relPath}`);
  if (!st.isFile()) refuse(`input is not a regular file: ${relPath}`);
  if (st.nlink > 1) refuse(`input has ${st.nlink} hard links and may alias a file outside the source root: ${relPath}`);
  const real = fs.realpathSync(candidate);
  if (real !== candidate || !within(real, rootReal)) refuse(`input resolves outside its source root: ${relPath}`);
  // open without following links and make sure it is still the same inode we checked
  const fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const fst = fs.fstatSync(fd);
    if (fst.ino !== st.ino || fst.dev !== st.dev || !fst.isFile()) refuse(`input changed while it was being checked: ${relPath}`);
    const dest = path.join(run.inputsDir, relPath.replaceAll(/[\\/]/g, '__'));
    fs.writeFileSync(dest, fs.readFileSync(fd), { flag: 'wx', mode: 0o444 });
  } finally {
    fs.closeSync(fd);
  }
}

// owner: {uid, gid} of the runtime OS user. Inputs stay owned by the control plane (read-only).
export function prepareRun({ runsRoot, runId, inputs = [], owner = null }) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(runId)) refuse(`invalid run id ${runId}`);
  const root = assertSafeRunsRoot(runsRoot);
  const dir = path.join(root, runId);
  fs.mkdirSync(dir, { mode: 0o700 }); // throws if it already exists: runs are never reused
  const run = {
    id: runId,
    dir,
    homeDir: path.join(dir, 'home'),
    tmpDir: path.join(dir, 'tmp'),
    cwd: path.join(dir, 'work'),
    inputsDir: path.join(dir, 'inputs'),
  };
  try {
    for (const d of [run.homeDir, run.tmpDir, run.cwd, run.inputsDir]) fs.mkdirSync(d, { mode: 0o700 });
    for (const input of inputs) copyInput(run, input);
    fs.chmodSync(run.inputsDir, 0o555);
    if (owner) for (const d of [run.dir, run.homeDir, run.tmpDir, run.cwd]) fs.chownSync(d, owner.uid, owner.gid);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return run;
}

function readSecretFile(file) {
  const st = fs.statSync(file);
  if ((st.mode & 0o077) !== 0) refuse(`secret file ${file} must not be readable by group/others`);
  return fs.readFileSync(file, 'utf8').trim();
}

export function buildChildEnv({ provider, authProfileDir, run, parentEnv = process.env, oauthTokenFile = null, homes = null, owner = null }) {
  const homeList = homes ?? [os.homedir(), parentEnv.HOME].filter(Boolean);
  const ownerUid = owner ? owner.uid : (process.getuid ? process.getuid() : null);
  const profile = assertSafeProfileDir(authProfileDir, { homes: homeList, ownerUid });
  const env = {
    PATH: parentEnv.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: run.homeDir,
    TMPDIR: run.tmpDir,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
  };
  if (provider === 'claude_agent') {
    env.CLAUDE_CONFIG_DIR = profile;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    if (oauthTokenFile) env.CLAUDE_CODE_OAUTH_TOKEN = readSecretFile(oauthTokenFile);
  } else if (provider === 'codex') {
    env.CODEX_HOME = profile;
  } else {
    refuse(`unknown provider ${provider}`);
  }
  return env;
}

// ---------- Claude Code CLI ----------
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_FLAGS = {
  '-p': null,
  '--output-format': (v) => v === 'stream-json',
  '--input-format': (v) => v === 'stream-json',
  '--verbose': null,
  '--tools': (v) => v === '',
  '--strict-mcp-config': null,
  '--mcp-config': (v) => path.isAbsolute(v),
  '--allowedTools': (v) => v === 'mcp__paper',
  '--permission-mode': (v) => v === 'dontAsk',
  '--permission-prompts': (v) => v === 'none',
  '--disable-slash-commands': null,
  '--no-chrome': null,
  '--restricted': null,
  '--session-id': (v) => UUID_RE.test(v),
  '--resume': (v) => UUID_RE.test(v),
  '--effort': (v) => EFFORTS.includes(v),
  '--model': (v) => /^[a-z0-9][a-z0-9.-]{0,63}$/.test(v),
};
const CLAUDE_REQUIRED = ['-p', '--output-format', '--tools', '--strict-mcp-config', '--mcp-config', '--allowedTools', '--permission-mode', '--permission-prompts', '--disable-slash-commands', '--restricted'];

// Allowlist: every flag must be known, carry a valid value, appear once, and the required
// lock-down flags must all be present. Prompts go through stdin, never argv.
export function assertSafeClaudeArgs(args) {
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!Object.hasOwn(CLAUDE_FLAGS, a)) refuse(`flag or argument ${JSON.stringify(a)} is not allowlisted`);
    if (seen.has(a)) refuse(`flag ${a} repeated`);
    seen.add(a);
    const check = CLAUDE_FLAGS[a];
    if (check) {
      const v = args[++i];
      if (v === undefined || !check(v)) refuse(`invalid value for ${a}: ${JSON.stringify(v)}`);
    }
  }
  for (const r of CLAUDE_REQUIRED) if (!seen.has(r)) refuse(`required flag ${r} missing`);
  if (seen.has('--session-id') === seen.has('--resume')) refuse('exactly one of --session-id or --resume <uuid> is required');
  return args;
}

export function buildClaudeArgs({ sessionId, resumeSessionId, mcpConfigPath, effort = null, model = null }) {
  if (!sessionId && !resumeSessionId) refuse('an explicit session id (new) or resume id is required');
  if (sessionId && resumeSessionId) refuse('both session id and resume id given');
  const id = sessionId || resumeSessionId;
  if (!UUID_RE.test(id)) refuse(`session id must be a uuid: ${id}`);
  if (!mcpConfigPath) refuse('mcp config path required');
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', '',
    '--restricted',
    '--strict-mcp-config',
    '--mcp-config', mcpConfigPath,
    '--allowedTools', 'mcp__paper',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--disable-slash-commands',
    '--no-chrome',
  ];
  if (sessionId) args.push('--session-id', sessionId);
  else args.push('--resume', resumeSessionId);
  if (effort) args.push('--effort', effort);
  if (model) args.push('--model', model);
  return assertSafeClaudeArgs(args);
}

// ---------- Codex app-server ----------
// Verified with `codex features list` (0.161.0): these report false when set via -c features.X=false.
export const CODEX_DISABLED_FEATURES = ['shell_tool', 'unified_exec_tty', 'shell_snapshot', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'browser_annotation_api', 'computer_use', 'apps', 'code_mode_host', 'view_image', 'skill_search', 'tool_suggest', 'goals', 'sleep_tool'];
// Reported as still enabled after -c / --disable / config.toml in 0.161.0.
export const CODEX_NON_DISABLEABLE = ['unified_exec'];

export function buildCodexArgs({ listen = 'stdio://' }) {
  if (listen !== 'stdio://') refuse(`app-server must use private stdio, not ${listen}`);
  return [
    'app-server', '--listen', 'stdio://',
    '-c', 'sandbox_mode="read-only"',
    // escalations outside the sandbox become approval requests, which we decline. 0.161.0 rejects
    // "untrusted" at startup (although the generated schema still lists it), so commands that stay
    // inside the read-only sandbox run without asking → an outer filesystem sandbox is required.
    '-c', 'approval_policy="on-request"',
    ...CODEX_DISABLED_FEATURES.flatMap((f) => ['-c', `features.${f}=false`]),
  ];
}

// ---------- processes ----------
function procStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { state: f[0], pgrp: Number(f[2]), starttime: Number(f[19]) };
  } catch {
    return null;
  }
}

export function spawnIsolated({ cmd, args, env, cwd, owner = null }) {
  const opts = { env, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] };
  if (owner) Object.assign(opts, { uid: owner.uid, gid: owner.gid });
  const child = spawn(cmd, args, opts);
  const handle = { child, pgid: child.pid, spawnError: null, leaderStart: child.pid ? procStat(child.pid)?.starttime ?? null : null };
  handle.exited = new Promise((resolve) => {
    child.on('error', (err) => { handle.spawnError = err; resolve({ code: null, signal: null, error: err }); });
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return handle;
}

// The only way to start a provider: requires an admission decision (registry + user approval +
// auth sentinel, see decideModelCall) for exactly this provider, and validated arguments.
export function startProviderRun({ admission, provider, cmd, args, env, cwd, owner = null }) {
  if (!admission?.allowed) refuse(`no admission for ${provider}${admission?.reason ? `: ${admission.reason}` : ''}`);
  if (admission.provider !== provider) refuse(`admission is for ${admission.provider}, not ${provider}`);
  if (provider === 'claude_agent') {
    const i = args.indexOf('-p');
    if (i < 0) refuse('claude runs must use -p');
    assertSafeClaudeArgs(args.slice(i));
  } else if (provider === 'codex') {
    const i = args.indexOf('app-server');
    if (i < 0 || JSON.stringify(args.slice(i)) !== JSON.stringify(buildCodexArgs({}))) refuse('codex args must be exactly buildCodexArgs()');
  } else {
    refuse(`unknown provider ${provider}`);
  }
  return spawnIsolated({ cmd, args, env, cwd, owner });
}

const waitOrTimeout = (p, ms) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

// Kills processes left in the run's group after the leader exited, but only those that started
// after the leader did, so a recycled process-group id is never hit. Linux (/proc) only.
function killLeftovers(handle) {
  if (handle.leaderStart === null || !fs.existsSync('/proc/self/stat')) return [];
  const killed = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const st = procStat(name);
    if (st && st.pgrp === handle.pgid && st.starttime >= handle.leaderStart && st.state !== 'Z') {
      try { process.kill(Number(name), 'SIGKILL'); killed.push(Number(name)); } catch { /* gone */ }
    }
  }
  return killed;
}

// Signals only the run's own process group while its leader is alive (SIGINT → SIGTERM → SIGKILL).
export async function cancelRun(handle, { graceMs = 5000 } = {}) {
  const signals = [];
  let exited = false;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
    try { process.kill(-handle.pgid, sig); } catch { break; }
    signals.push(sig);
    if (await waitOrTimeout(handle.exited, graceMs)) { exited = true; break; }
  }
  const leftovers = killLeftovers(handle);
  return { signals, exited: exited || (await waitOrTimeout(handle.exited, graceMs)), leftovers };
}

// Reads newline-delimited JSON events. The session id we chose stays authoritative;
// a different id from the provider is flagged instead of adopted.
export async function collectStreamJson(handle, { expectedSessionId = null } = {}) {
  const events = [];
  if (handle.child.stdout) {
    const rl = readline.createInterface({ input: handle.child.stdout });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { events.push({ type: 'unparsed', raw: line.slice(0, 200) }); }
    }
  }
  const { code } = await handle.exited;
  const reported = events.find((e) => e.type === 'system' && e.subtype === 'init')?.session_id ?? null;
  const result = [...events].reverse().find((e) => e.type === 'result') ?? null;
  return {
    exitCode: code,
    spawnError: handle.spawnError ? String(handle.spawnError.code || handle.spawnError) : null,
    events,
    result,
    sessionId: expectedSessionId ?? reported,
    reportedSessionId: reported,
    sessionMismatch: Boolean(expectedSessionId && reported && reported !== expectedSessionId),
  };
}

export function createCodexRpcGuard(policy) {
  const allowed = new Set(policy.client_request_allowlist);
  return {
    clientRequest(method) {
      if (!allowed.has(method)) refuse(`codex method ${method} is not allowlisted`);
      return method;
    },
    // Unknown server-initiated requests are declined by default.
    serverRequest(method) {
      return policy.server_request_handling[method] || 'decline';
    },
  };
}

// Auth isolation sentinel. Runs the provider against a brand-new EMPTY profile directory with the
// same env builder used for real runs, without any model call. If the CLI still reports a login,
// it is reading credentials from a host-level source (keychain, injected token, managed config)
// that per-run env/HOME isolation cannot remove — the host must not be admitted as-is.
// Its result is the `authSentinel` input of decideModelCall().
export async function checkAuthIsolation({ provider, cmd, cmdPrefix = [], run, parentEnv = process.env, homes = null, extraEnv = {}, timeoutMs = 30000 }) {
  const emptyProfile = path.join(run.dir, 'sentinel-empty-profile');
  fs.mkdirSync(emptyProfile, { mode: 0o700 });
  const env = { ...buildChildEnv({ provider, authProfileDir: emptyProfile, run, parentEnv, homes }), ...extraEnv };
  const result = (status, detail = {}) => ({ provider, status, detail, checked_at: new Date().toISOString() });
  if (provider === 'claude_agent') {
    const r = spawnSync(cmd, [...cmdPrefix, 'auth', 'status', '--json'], { env, cwd: run.cwd, encoding: 'utf8', timeout: timeoutMs });
    try {
      const s = JSON.parse(r.stdout);
      if (s.loggedIn === true) return result('leak', { authMethod: s.authMethod ?? null, apiProvider: s.apiProvider ?? null });
      if (s.loggedIn === false) return result('isolated');
    } catch { /* fall through */ }
    return result('unknown', { exit: r.status });
  }
  if (provider === 'codex') {
    const handle = spawnIsolated({ cmd, args: [...cmdPrefix, ...buildCodexArgs({})], env, cwd: run.cwd });
    const responses = new Map();
    if (handle.child.stdout) {
      const rl = readline.createInterface({ input: handle.child.stdout });
      rl.on('line', (line) => { try { const m = JSON.parse(line); if (m.id !== undefined) responses.set(m.id, m); } catch { /* ignore */ } });
    }
    const send = (o) => { try { handle.child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* process gone */ } };
    const waitFor = async (id) => {
      for (let waited = 0; waited < timeoutMs && !handle.spawnError; waited += 50) {
        if (responses.has(id)) return responses.get(id);
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    };
    try {
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'paper-workspace-sentinel', version: '0.0.0' } } });
      if (!(await waitFor(1))) return result('unknown', { reason: 'no initialize response' });
      send({ method: 'initialized' });
      send({ id: 2, method: 'account/read', params: {} });
      const res = await waitFor(2);
      if (!res || !res.result) return result('unknown', { reason: 'no account/read result' });
      return res.result.account === null ? result('isolated') : result('leak', { accountType: res.result.account.type ?? null });
    } finally {
      await cancelRun(handle, { graceMs: 1000 });
    }
  }
  refuse(`unknown provider ${provider}`);
}
