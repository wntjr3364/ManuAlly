#!/usr/bin/env node
// PW-001 preflight: non-destructive environment survey.
// Never creates, modifies or reads the contents of any path it inspects.
// The only write is the optional --out report file chosen by the caller.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TOOLS = ['node', 'pnpm', 'npm', 'psql', 'docker', 'pandoc', 'java', 'git', 'claude', 'codex'];
const DEFAULT_MIN_FREE_BYTES = 20 * 1024 ** 3;

// Wraps an fs module and records which operations touched which paths.
export function createRecordingFs(base) {
  const calls = [];
  const wrapped = {};
  for (const op of ['lstatSync', 'statSync', 'existsSync', 'accessSync', 'statfsSync', 'readFileSync', 'readdirSync', 'openSync', 'mkdirSync', 'writeFileSync']) {
    wrapped[op] = (p, ...rest) => {
      calls.push({ op, path: String(p) });
      return base[op](p, ...rest);
    };
  }
  wrapped.constants = base.constants;
  return { fs: wrapped, calls };
}

export function probeTool(name) {
  const r = spawnSync(name, ['--version'], { encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
  if (r.error || r.status !== 0) return { found: false, version: null };
  const line = `${r.stdout}${r.stderr}`.split('\n').find((l) => l.trim() && !l.startsWith('WARNING') && !l.startsWith('Picked up'));
  return { found: true, version: line ? line.trim() : null };
}

function statPath(fsApi, p) {
  try {
    const st = fsApi.lstatSync(p);
    return { exists: true, type: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : 'file' };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, type: null };
    return { exists: null, type: null, error: err.code || String(err) };
  }
}

function inspectDataRoot(fsApi, dataRoot, approved, minFreeBytes) {
  if (!dataRoot) return { path: null, status: 'undecided', reason: 'data root not specified by user', free_bytes: null };
  const abs = path.resolve(dataRoot);
  const base = { path: abs, free_bytes: null };
  const st = statPath(fsApi, abs);
  if (st.exists === null) return { ...base, status: 'blocked', reason: `cannot stat path (${st.error})` };
  if (!st.exists) return { ...base, status: 'blocked', reason: 'path does not exist; preflight never creates it' };
  if (st.type !== 'directory') return { ...base, status: 'blocked', reason: `path is a ${st.type}, expected a real directory` };
  try {
    fsApi.accessSync(abs, fs.constants.W_OK);
  } catch {
    return { ...base, status: 'blocked', reason: 'directory is not writable by this OS user' };
  }
  let free = null;
  try {
    const s = fsApi.statfsSync(abs);
    free = Number(s.bavail) * Number(s.bsize);
  } catch {
    return { ...base, status: 'blocked', reason: 'free space could not be determined' };
  }
  if (!Number.isFinite(free)) return { ...base, status: 'blocked', reason: 'free space could not be determined' };
  if (free < minFreeBytes) return { ...base, free_bytes: free, status: 'blocked', reason: `free space ${free} below minimum ${minFreeBytes}` };
  if (!approved) return { ...base, free_bytes: free, status: 'undecided', reason: 'checks passed but user has not approved this path' };
  return { ...base, free_bytes: free, status: 'approved', reason: 'exists, writable, enough free space, user approved' };
}

export function collectPreflight({
  dataRoot = null,
  approvedDataRoot = false,
  protectPaths = [],
  home = os.homedir(),
  runTool = probeTool,
  toolNames = DEFAULT_TOOLS,
  fsApi = fs,
  minFreeBytes = DEFAULT_MIN_FREE_BYTES,
} = {}) {
  const tools = {};
  for (const name of toolNames) tools[name] = runTool(name);

  // Development CLI state is always protected: the product runtime must use its own config dirs.
  const devConfig = ['.claude', '.claude.json', '.codex', '.config/claude'].map((rel) => ({ path: path.join(home, rel), kind: 'dev_cli_state' }));
  const userProtected = protectPaths.map((p) => ({ path: path.resolve(p), kind: 'user_research_data' }));
  const protectedPaths = [...devConfig, ...userProtected].map((p) => ({ ...p, ...statPath(fsApi, p.path), access: 'never_read_never_write' }));

  const dr = inspectDataRoot(fsApi, dataRoot, approvedDataRoot, minFreeBytes);
  const undecided = [
    { kind: 'backup_location', path: null, reason: 'off-host encrypted backup target not chosen' },
    { kind: 'runtime_os_user', path: null, reason: 'dedicated OS user for provider runner not created' },
    { kind: 'provider_auth_profile_dir', path: null, reason: 'isolated CLAUDE_CONFIG_DIR / CODEX_HOME not chosen' },
  ];
  if (dr.status === 'undecided') undecided.unshift({ kind: 'data_root', path: dr.path, reason: dr.reason });

  const blocked = [];
  if (dr.status === 'blocked') blocked.push({ item: 'data_root', reason: dr.reason });
  for (const p of protectedPaths) if (p.exists === null) blocked.push({ item: `protected:${p.path}`, reason: `cannot stat (${p.error})` });

  return {
    scope: 'PREFLIGHT_ONLY_NOT_PRODUCT_TEST',
    generated_at: new Date().toISOString(),
    host: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpus: os.cpus().length,
      mem_total_bytes: os.totalmem(),
      os_user: (() => { try { return os.userInfo().username; } catch { return null; } })(),
    },
    tools,
    data_root: dr,
    paths: {
      approved: dr.status === 'approved' ? [{ kind: 'data_root', path: dr.path }] : [],
      undecided,
      protected: protectedPaths,
    },
    blocked,
  };
}

function parseArgs(argv) {
  const out = { protectPaths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data-root') out.dataRoot = argv[++i];
    else if (a === '--approved') out.approvedDataRoot = true;
    else if (a === '--protect') out.protectPaths.push(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--label') out.label = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  const report = { label: args.label || null, ...collectPreflight(args) };
  const text = JSON.stringify(report, null, 2) + '\n';
  if (args.out) fs.writeFileSync(args.out, text);
  process.stdout.write(text);
  process.exitCode = report.blocked.length ? 2 : 0;
}
