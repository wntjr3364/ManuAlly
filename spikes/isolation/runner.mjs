// PW-004 spike: per-run isolation for provider CLIs (Claude Code `-p`, Codex `app-server`).
//
// What this layer guarantees (process level):
// - fresh HOME/TMPDIR per run, env built from a whitelist (no inherited keys, sockets or DB URLs)
// - auth comes from a dedicated runtime profile dir (never the developer's ~/.claude or ~/.codex)
// - only selected input files are copied in, read-only; symlinks and traversal are refused
// - explicit session ids only; no --continue / latest-session / bare --resume
// - no built-in shell/file tools; model tools come only from the paper MCP gateway
// - cancel signals the run's own process group (SIGINT → SIGTERM → SIGKILL), nothing else
// What it does NOT guarantee: kernel-level isolation. A dedicated OS user plus a sandbox
// (bubblewrap/container) is still required on the deployment host (see report).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const refuse = (msg) => { throw new Error(`refused: ${msg}`); };
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);

export function prepareRun({ runsRoot, runId, inputs = [] }) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(runId)) refuse(`invalid run id ${runId}`);
  fs.mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
  const dir = path.join(fs.realpathSync(runsRoot), runId);
  fs.mkdirSync(dir, { mode: 0o700 }); // throws if it already exists: runs are never reused
  const run = {
    id: runId,
    dir,
    homeDir: path.join(dir, 'home'),
    tmpDir: path.join(dir, 'tmp'),
    cwd: path.join(dir, 'work'),
    inputsDir: path.join(dir, 'inputs'),
  };
  for (const d of [run.homeDir, run.tmpDir, run.cwd, run.inputsDir]) fs.mkdirSync(d, { mode: 0o700 });

  for (const { sourceRoot, relPath } of inputs) {
    if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) refuse(`input path must be relative without '..': ${relPath}`);
    const rootReal = fs.realpathSync(sourceRoot);
    const candidate = path.join(rootReal, relPath);
    let st;
    try { st = fs.lstatSync(candidate); } catch { refuse(`input does not exist: ${relPath}`); }
    if (st.isSymbolicLink()) refuse(`input is a symlink: ${relPath}`);
    const real = fs.realpathSync(candidate);
    if (real !== candidate || !within(real, rootReal)) refuse(`input resolves outside its source root: ${relPath}`);
    if (!st.isFile()) refuse(`input is not a regular file: ${relPath}`);
    const dest = path.join(run.inputsDir, relPath.replaceAll(/[\\/]/g, '__'));
    fs.copyFileSync(real, dest, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dest, 0o444);
  }
  return run;
}

function readSecretFile(file) {
  const st = fs.statSync(file);
  if ((st.mode & 0o077) !== 0) refuse(`secret file ${file} must not be readable by group/others`);
  return fs.readFileSync(file, 'utf8').trim();
}

export function buildChildEnv({ provider, authProfileDir, run, parentEnv = process.env, oauthTokenFile = null, devHome = os.homedir() }) {
  if (!authProfileDir || !path.isAbsolute(authProfileDir)) refuse('auth profile dir must be absolute');
  const resolved = path.resolve(authProfileDir);
  for (const dev of [path.join(devHome, '.claude'), path.join(devHome, '.codex'), path.join(devHome, '.config', 'claude')]) {
    if (within(resolved, dev)) refuse(`${resolved} is the developer CLI config directory`);
  }
  if (parentEnv.HOME && within(resolved, path.resolve(parentEnv.HOME, '.claude'))) refuse(`${resolved} is inside the parent HOME CLI config`);
  const env = {
    PATH: parentEnv.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: run.homeDir,
    TMPDIR: run.tmpDir,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
  };
  if (provider === 'claude_agent') {
    env.CLAUDE_CONFIG_DIR = resolved;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    if (oauthTokenFile) env.CLAUDE_CODE_OAUTH_TOKEN = readSecretFile(oauthTokenFile);
  } else if (provider === 'codex') {
    env.CODEX_HOME = resolved;
  } else {
    refuse(`unknown provider ${provider}`);
  }
  return env;
}

const FORBIDDEN_CLAUDE_FLAGS = new Set(['-c', '--continue', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--add-dir', '--bare', '--fork-session', '--remote-control', '--plugin-url', '--plugin-dir', '--chrome', '--cloud', '--teleport', '--from-pr', '--ide', '--bg', '--background', '--worktree']);

export function assertSafeClaudeArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (FORBIDDEN_CLAUDE_FLAGS.has(a.split('=')[0])) refuse(`flag ${a}`);
    if (a === '--resume' || a === '-r') {
      const v = args[i + 1];
      if (!v || !UUID_RE.test(v)) refuse('--resume requires an explicit session uuid');
    }
  }
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
  if (effort) {
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) refuse(`effort ${effort}`);
    args.push('--effort', effort);
  }
  if (model) args.push('--model', model);
  return assertSafeClaudeArgs(args);
}

export function buildCodexArgs({ listen = 'stdio://' }) {
  if (listen !== 'stdio://') refuse(`app-server must use private stdio, not ${listen}`);
  return ['app-server', '--listen', 'stdio://', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'];
}

export function spawnIsolated({ cmd, args, env, cwd }) {
  const child = spawn(cmd, args, { env, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, pgid: child.pid, exited };
}

const waitOrTimeout = (p, ms) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

// Signals only the run's own process group. Escalates when the CLI does not finish its turn.
export async function cancelRun(handle, { graceMs = 5000 } = {}) {
  const signals = [];
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
    try { process.kill(-handle.pgid, sig); } catch { break; }
    signals.push(sig);
    if (await waitOrTimeout(handle.exited, graceMs)) break;
  }
  // Leftover grandchildren in the group (e.g. a background task) are cleaned up too.
  try { process.kill(-handle.pgid, 'SIGKILL'); } catch { /* group already gone */ }
  return { signals, exited: await waitOrTimeout(handle.exited, graceMs) };
}

// Reads newline-delimited JSON events. The session id we chose stays authoritative;
// a different id from the provider is flagged instead of adopted.
export async function collectStreamJson(handle, { expectedSessionId = null } = {}) {
  const events = [];
  const rl = readline.createInterface({ input: handle.child.stdout });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { events.push({ type: 'unparsed', raw: line.slice(0, 200) }); }
  }
  const { code } = await handle.exited;
  const reported = events.find((e) => e.type === 'system' && e.subtype === 'init')?.session_id ?? null;
  const result = [...events].reverse().find((e) => e.type === 'result') ?? null;
  return {
    exitCode: code,
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
export async function checkAuthIsolation({ provider, cmd, cmdPrefix = [], run, parentEnv = process.env, extraEnv = {}, timeoutMs = 30000 }) {
  const emptyProfile = path.join(run.dir, 'sentinel-empty-profile');
  fs.mkdirSync(emptyProfile, { mode: 0o700 });
  const env = { ...buildChildEnv({ provider, authProfileDir: emptyProfile, run, parentEnv }), ...extraEnv };
  if (provider === 'claude_agent') {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(cmd, [...cmdPrefix, 'auth', 'status', '--json'], { env, cwd: run.cwd, encoding: 'utf8', timeout: timeoutMs });
    try {
      const s = JSON.parse(r.stdout);
      if (s.loggedIn === true) return { status: 'leak', detail: { authMethod: s.authMethod ?? null, apiProvider: s.apiProvider ?? null } };
      if (s.loggedIn === false) return { status: 'isolated', detail: {} };
    } catch { /* fall through */ }
    return { status: 'unknown', detail: { exit: r.status } };
  }
  if (provider === 'codex') {
    const handle = spawnIsolated({ cmd, args: [...cmdPrefix, ...buildCodexArgs({})], env, cwd: run.cwd });
    const responses = new Map();
    const rl = readline.createInterface({ input: handle.child.stdout });
    rl.on('line', (line) => { try { const m = JSON.parse(line); if (m.id !== undefined) responses.set(m.id, m); } catch { /* ignore */ } });
    const send = (o) => handle.child.stdin.write(JSON.stringify(o) + '\n');
    const waitFor = async (id) => {
      for (let waited = 0; waited < timeoutMs; waited += 50) {
        if (responses.has(id)) return responses.get(id);
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    };
    try {
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'paper-workspace-sentinel', version: '0.0.0' } } });
      if (!(await waitFor(1))) return { status: 'unknown', detail: { reason: 'no initialize response' } };
      send({ method: 'initialized' });
      send({ id: 2, method: 'account/read', params: {} });
      const res = await waitFor(2);
      if (!res || !res.result) return { status: 'unknown', detail: { reason: 'no account/read result' } };
      return res.result.account === null ? { status: 'isolated', detail: {} } : { status: 'leak', detail: { accountType: res.result.account.type ?? null } };
    } finally {
      await cancelRun(handle, { graceMs: 1000 });
    }
  }
  refuse(`unknown provider ${provider}`);
}
