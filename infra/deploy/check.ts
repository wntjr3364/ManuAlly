// PW-061 deployment check (spec 12 "기본 배포", "업그레이드"). One private installation for one user, without
// sudo: the API (with the built web app) and the worker run as the user, bound to loopback, with every
// file they write under one dedicated data root that has a size cap. The check refuses, before anything
// starts:
//  - a data root that is not a dedicated, private, durable folder: relative, missing, a symlink, not the
//    user's, open to others, the home folder itself, inside the app's install folder or a developer CLI's
//    state (~/.claude, ~/.codex, ~/.config/claude), or on tmpfs / ramfs / an overlay (a container layer);
//  - no size cap (the data root may not grow without bound — on the OS disk least of all);
//  - a listen address that is not loopback (a reverse proxy in front is the user's choice; the app and the
//    agent ports are never exposed directly), or a public origin over plain http other than loopback;
//  - the production database being the test or development database (a pw_test* / pw_dev name, the test URL,
//    or a URL with the password written in the config), or a remote database without verified TLS;
//  - version pins that are not exact (latest, ranges, tags), or installed versions that differ from the
//    pins without a recorded, passed upgrade check (pwctl verify-upgrade).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface DeployConfig {
  data_root: string;
  max_data_bytes: number;
  database_url_env: string;
  listen: { host: string; port: number };
  public_origin: string;
  web_dist: string;
  log: { max_bytes: number; keep: number };
  backup_dir?: string;
}
export interface Pins { [component: string]: string | null }
export interface UpgradeRecord { component: string; from: string | null; to: string; verified_at: string; commands: { cmd: string; exit: number }[] }
export interface Probe {
  fsType: (p: string) => string;
  home: string;
  uid: number;
  appDir: string;
  installed: Record<string, string | null>; // what is installed now (null: not installed / not used)
  env: Record<string, string | undefined>;
}
export interface CheckResult { ok: boolean; problems: string[]; warnings: string[] }

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const EXACT = /^\d+(\.\d+){0,3}$|^[0-9a-f]{64}$/; // a version number, or a sha256 (lockfile)
const VOLATILE_FS = new Set(['tmpfs', 'ramfs', 'overlay', 'overlayfs', 'aufs', 'squashfs']);
export const DATA_DIRS = ['assets', 'logs', 'tmp', 'run'] as const;

const inside = (p: string, dir: string) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// the filesystem type of the mount that holds p (longest mount point prefix in /proc/mounts)
export function fsTypeOf(p: string, mounts = fs.readFileSync('/proc/mounts', 'utf8')): string {
  let best = '';
  let type = 'unknown';
  for (const line of mounts.split('\n')) {
    const [, mnt, t] = line.split(' ');
    if (!mnt || !t) continue;
    const m = mnt.replace(/\\040/g, ' ');
    if (inside(p, m) && m.length >= best.length) { best = m; type = t; }
  }
  return type;
}
export function lockfileSha(appDir: string): string | null {
  try { return createHash('sha256').update(fs.readFileSync(path.join(appDir, 'pnpm-lock.yaml'))).digest('hex'); } catch { return null; }
}

export function checkDeployment(cfg: DeployConfig, pins: Pins, upgrades: UpgradeRecord[], probe: Probe): CheckResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const no = (m: string) => problems.push(m);

  // the data root
  const root = cfg.data_root;
  if (typeof root !== 'string' || !path.isAbsolute(root)) no('data_root must be an absolute path');
  else {
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(root); } catch { no(`data_root ${root} does not exist (create it, mode 0700, owned by you)`); }
    if (st) {
      if (st.isSymbolicLink()) no('data_root must not be a symlink');
      else if (!st.isDirectory()) no('data_root must be a folder');
      else {
        if (st.uid !== probe.uid) no('data_root must be owned by the user who runs the app');
        if ((st.mode & 0o077) !== 0) no(`data_root must be private (mode 0700; it is ${(st.mode & 0o777).toString(8)})`);
      }
    }
    const real = st && !st.isSymbolicLink() ? fs.realpathSync(root) : root;
    if (path.resolve(real) === path.resolve(probe.home)) no('data_root must be its own folder, not the home folder');
    if (inside(real, probe.appDir) || inside(probe.appDir, real)) no('data_root must be outside the app\'s install folder');
    for (const dev of ['.claude', '.codex', '.config/claude', '.config/codex']) if (inside(real, path.join(probe.home, dev))) no(`data_root must not be inside ~/${dev} (a developer CLI's state)`);
    const t = probe.fsType(real);
    if (VOLATILE_FS.has(t)) no(`data_root is on ${t}: not a durable volume (a container layer or memory) — use a disk folder or a mounted volume`);
    if (t === 'unknown') warnings.push('the filesystem of data_root could not be determined');
  }
  if (!Number.isSafeInteger(cfg.max_data_bytes) || cfg.max_data_bytes < 1024 ** 3) no('max_data_bytes must be set: the size cap of the data root (at least 1 GiB) — it may not grow without bound');
  if (!Number.isSafeInteger(cfg.log?.max_bytes) || cfg.log.max_bytes < 1024 || cfg.log.max_bytes > 1024 ** 3 || !Number.isInteger(cfg.log?.keep) || cfg.log.keep < 1 || cfg.log.keep > 50) no('log.max_bytes (1 KiB–1 GiB) and log.keep (1–50) must bound the logs');

  // network: loopback only
  if (!LOOPBACK.has(cfg.listen?.host)) no(`listen.host must be loopback (127.0.0.1 or ::1), not ${String(cfg.listen?.host)}; put a TLS reverse proxy in front for other machines`);
  if (!Number.isInteger(cfg.listen?.port) || cfg.listen.port < 1024 || cfg.listen.port > 65535) no('listen.port must be 1024–65535 (no root needed)');
  let origin: URL | null = null;
  try { origin = new URL(cfg.public_origin); } catch { no('public_origin must be a URL (the address users open)'); }
  if (origin) {
    if (origin.pathname !== '/' || origin.search || origin.hash || origin.username) no('public_origin must be an origin only (scheme, host, port)');
    if (origin.protocol === 'http:' && !LOOPBACK.has(origin.hostname.replace(/^\[|\]$/g, ''))) no('public_origin over plain http is only for this machine (loopback); other machines need https through a reverse proxy');
    if (!['http:', 'https:'].includes(origin.protocol)) no('public_origin must be http(s)');
  }

  // the database: its own, never the test or development one
  const name = cfg.database_url_env;
  const url = typeof name === 'string' ? probe.env[name] : undefined;
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name)) no('database_url_env must name the environment variable that holds the database URL');
  else if (!url) no(`${name} is not set`);
  else {
    let u: URL | null = null;
    try { u = new URL(url); } catch { no(`${name} is not a database URL`); }
    if (u) {
      const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (/^pw_(test|dev)(_|$)/.test(db)) no(`the production database must not be a test or development database (${db})`);
      if (probe.env.PW_TEST_DATABASE_URL && sameDb(url, probe.env.PW_TEST_DATABASE_URL)) no('the production database is the test database (PW_TEST_DATABASE_URL)');
      const socket = u.searchParams.get('host');
      const local = socket ? socket.startsWith('/') : LOOPBACK.has(u.hostname.replace(/^\[|\]$/g, ''));
      if (!local && u.searchParams.get('sslmode') !== 'verify-full') no('a database on another machine needs sslmode=verify-full');
    }
  }

  // versions: exact pins, and what is installed matches them (or a passed upgrade check says so)
  for (const [c, v] of Object.entries(pins)) {
    if (v !== null && (typeof v !== 'string' || !EXACT.test(v))) no(`pin ${c}=${String(v)} is not an exact version (latest, ranges and tags are refused)`);
  }
  for (const [c, have] of Object.entries(probe.installed)) {
    if (!(c in pins)) { no(`${c} is installed (${have}) but has no pin`); continue; }
    const want = pins[c];
    if (have === want) continue;
    const verified = upgrades.some((r) => r.component === c && r.to === have && r.commands.length > 0 && r.commands.every((x) => x.exit === 0) && !Number.isNaN(Date.parse(r.verified_at)));
    if (!verified) no(`${c}: installed ${have ?? 'nothing'}, pinned ${want ?? 'nothing'} — run \`pwctl verify-upgrade ${c}\` (contract and export checks) before using it`);
    else warnings.push(`${c}: ${have} was checked by verify-upgrade; update the pin`);
  }
  return { ok: problems.length === 0, problems, warnings };
}

function sameDb(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const key = (u: URL) => `${u.searchParams.get('host') ?? u.hostname}|${u.port}|${u.pathname}`;
    return key(x) === key(y);
  } catch { return false; }
}

export function defaultProbe(appDir: string, env: Record<string, string | undefined>, installed: Record<string, string | null>): Probe {
  return { fsType: (p) => fsTypeOf(p), home: os.homedir(), uid: process.getuid?.() ?? -1, appDir, installed, env };
}
