// PW-061 operator command for one private installation (no sudo, no container runtime). Commands:
//   check                 the deployment check (check.ts) — nothing starts unless it passes
//   migrate               takes a backup (PW-060) into backup_dir, then applies pending migrations
//   run                   the supervisor: API + web (serve.ts) and the worker, as children with a built
//                         environment; bounded logs; restarts a crashed child (at most 5 times in 10 min);
//                         measures the data root every minute and sets disk_pressure at the cap
//   status                health, schema, AI pause, disk, queue, running AI jobs, last backup, logs (JSON;
//                         what cannot be observed is "UNKNOWN", never 0)
//   pause-ai --reason R   AI waits (manual editing goes on); resume-ai lifts it
//   stop                  safe stop: the worker finishes the job in hand and stops taking jobs, then the API
//   verify-upgrade C V    runs the verification commands of versions.json for component C at version V and
//                         records the result (a pin changes only after a passed check)
// The config file is named by --config or PW_DEPLOY_CONFIG. Exit: 0 ok, 1 refused/failed, 2 usage.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { checkDeployment, defaultProbe, lockfileSha, DATA_DIRS, type DeployConfig, type Pins, type UpgradeRecord } from './check.ts';
import { RotatingLog } from './logs.ts';
import { MIGRATIONS_DIR, schemaState } from './serve.ts';
import { migrate } from '../../apps/api/src/db/migrate.ts';
import { createBackup } from '../backup/backup.ts';
import { findSoffice, libreofficeVersion } from '../../packages/exports/src/pdf/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(HERE, '../..');
const VERSIONS = path.join(HERE, 'versions.json');
const AI_INTENTS_SQL = "intent NOT IN ('parse_source', 'export')"; // every job but PDF parsing and exports is AI work

type Env = Record<string, string | undefined>;
const out = (x: unknown) => process.stdout.write(`${JSON.stringify(x, null, 2)}\n`);
const dirs = (cfg: DeployConfig) => Object.fromEntries(DATA_DIRS.map((d) => [d, path.join(cfg.data_root, d)])) as Record<(typeof DATA_DIRS)[number], string>;

export function loadConfig(file: string): DeployConfig { return JSON.parse(fs.readFileSync(file, 'utf8')) as DeployConfig; }
export function loadVersions(file = VERSIONS): { pins: Pins; verify_commands: string[][] } { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function upgradesOf(cfg: DeployConfig): UpgradeRecord[] {
  try { return JSON.parse(fs.readFileSync(path.join(dirs(cfg).run, 'upgrades.json'), 'utf8')) as UpgradeRecord[]; } catch { return []; }
}

// what is installed now, for the components that are pinned (a null pin is a component not in use)
export async function installedVersions(pins: Pins, env: Env, pool: pg.Pool | null): Promise<Record<string, string | null>> {
  const have: Record<string, string | null> = {};
  if ('node' in pins) have.node = process.versions.node;
  if ('pnpm_lock' in pins) have.pnpm_lock = lockfileSha(APP_DIR);
  if ('postgres' in pins && pool) {
    try { have.postgres = String(Math.floor(Number((await pool.query<{ v: string }>('SHOW server_version_num')).rows[0]!.v) / 10000)); } catch { have.postgres = null; }
  }
  if (pins.libreoffice !== undefined && pins.libreoffice !== null) {
    const s = await findSoffice(env as NodeJS.ProcessEnv);
    have.libreoffice = s ? await libreofficeVersion(s, env as NodeJS.ProcessEnv) : null;
  }
  return have;
}

async function check(cfg: DeployConfig, env: Env) {
  const { pins } = loadVersions();
  const pool = env[cfg.database_url_env] ? new pg.Pool({ connectionString: env[cfg.database_url_env], max: 1, connectionTimeoutMillis: 5000 }) : null;
  try {
    const installed = await installedVersions(pins, env, pool);
    return checkDeployment(cfg, pins, upgradesOf(cfg), defaultProbe(APP_DIR, env, installed));
  } finally { await pool?.end(); }
}

// ---- operations controls ---------------------------------------------------------------------------
export async function setAiPause(pool: pg.Pool, paused: boolean, reason: string, actor: 'operator' | 'supervisor' = 'operator') {
  const r = reason.trim().slice(0, 500);
  if (!r) throw new Error('give a reason');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('UPDATE ops_controls SET ai_paused = $1, ai_reason = $2, ai_changed_at = clock_timestamp()', [paused, paused ? r : null]);
    await c.query('INSERT INTO ops_control_log (control, reason, actor) VALUES ($1, $2, $3)', [paused ? 'ai_pause' : 'ai_resume', r, actor]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}
export async function recordDisk(pool: pg.Pool, used: number, cap: number) {
  const pressure = used >= cap;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const was = (await c.query<{ p: boolean }>('SELECT disk_pressure AS p FROM ops_controls FOR UPDATE')).rows[0]!.p;
    await c.query('UPDATE ops_controls SET disk_pressure = $1, disk_used_bytes = $2, disk_cap_bytes = $3, disk_checked_at = clock_timestamp()', [pressure, used, cap]);
    if (was !== pressure) await c.query('INSERT INTO ops_control_log (control, reason, actor) VALUES ($1, $2, $3)', [pressure ? 'disk_pressure_on' : 'disk_pressure_off', `${used} of ${cap} bytes`, 'supervisor']);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}
// bytes used under a folder (files only, symlinks not followed)
export function usedBytes(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { n += fs.lstatSync(p).size; } catch { /* removed meanwhile */ } }
    }
  };
  walk(dir);
  return n;
}

// ---- status ----------------------------------------------------------------------------------------
function health(cfg: DeployConfig): Promise<{ ok: boolean; status: number | null; headers: Record<string, string> }> {
  return new Promise((resolve) => {
    // loopback only: the check refuses any other listen host
    const req = http.get({ host: cfg.listen.host, port: cfg.listen.port, path: '/api/health', timeout: 3000 }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode ?? null, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)])) }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false, status: null, headers: {} }));
  });
}
const alive = (pid: unknown) => { if (typeof pid !== 'number' || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
function lastBackup(cfg: DeployConfig): { dir: string; created_at: string; age_hours: number } | 'none' | 'UNKNOWN' {
  if (!cfg.backup_dir) return 'UNKNOWN';
  let best: { dir: string; created_at: string } | null = null;
  try {
    for (const name of fs.readdirSync(cfg.backup_dir)) {
      const d = path.join(cfg.backup_dir, name);
      if (!fs.existsSync(path.join(d, 'COMPLETE'))) continue; // an unfinished or failed set is not a backup
      try {
        const m = JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8')) as { status: string; created_at: string };
        if (m.status === 'complete' && (!best || m.created_at > best.created_at)) best = { dir: d, created_at: m.created_at };
      } catch { /* not a set */ }
    }
  } catch { return 'UNKNOWN'; }
  return best ? { ...best, age_hours: Math.round((Date.now() - Date.parse(best.created_at)) / 36e5 * 10) / 10 } : 'none';
}
export async function status(cfg: DeployConfig, env: Env) {
  const state = (() => { try { return JSON.parse(fs.readFileSync(path.join(dirs(cfg).run, 'state.json'), 'utf8')) as Record<string, unknown>; } catch { return null; } })();
  const processes = state ? { supervisor: alive(state.pid), api: alive(state.api_pid), worker: alive(state.worker_pid), started_at: state.started_at } : 'not running';
  const h = await health(cfg);
  const pool = new pg.Pool({ connectionString: env[cfg.database_url_env], max: 1, connectionTimeoutMillis: 5000 });
  let db: Record<string, unknown>;
  try {
    const s = await schemaState(pool);
    const ops = (await pool.query('SELECT ai_paused, ai_reason, ai_changed_at, disk_pressure, disk_used_bytes, disk_cap_bytes, disk_checked_at FROM ops_controls')).rows[0];
    const queue = Object.fromEntries((await pool.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM jobs GROUP BY status ORDER BY status')).rows.map((r) => [r.status, r.n]));
    const runningAi = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE status = 'RUNNING' AND ${AI_INTENTS_SQL}`)).rows[0]!.n;
    const oldest = (await pool.query<{ s: number | null }>("SELECT extract(epoch FROM clock_timestamp() - min(created_at))::int AS s FROM jobs WHERE status = 'QUEUED'")).rows[0]!.s;
    db = {
      reachable: true, schema: s, queue, running_ai_jobs: runningAi, oldest_queued_s: oldest,
      ai: { paused: ops.ai_paused, reason: ops.ai_reason, since: ops.ai_changed_at },
      disk: ops.disk_checked_at ? { used_bytes: Number(ops.disk_used_bytes), cap_bytes: Number(ops.disk_cap_bytes), pressure: ops.disk_pressure, checked_at: ops.disk_checked_at } : 'UNKNOWN',
    };
  } catch (e) { db = { reachable: false, error: (e as Error).message.slice(0, 200) }; } finally { await pool.end(); }
  const logs = fs.existsSync(dirs(cfg).logs) ? usedBytes(dirs(cfg).logs) : 'UNKNOWN';
  return { processes, health: { ok: h.ok, status: h.status }, db, last_backup: lastBackup(cfg), logs_bytes: logs };
}

// ---- the supervisor --------------------------------------------------------------------------------
// the environment a child gets: built, never the operator's whole environment
export function childEnv(cfg: DeployConfig, env: Env, configFile: string): Record<string, string> {
  const d = dirs(cfg);
  const e: Record<string, string> = {
    PATH: env.PATH ?? '/usr/bin:/bin', HOME: env.HOME ?? '/nonexistent', LANG: 'C.UTF-8', TMPDIR: d.tmp, NODE_ENV: 'production',
    PW_DEPLOY_CONFIG: configFile, PW_ASSET_DIR: d.assets, PW_PROVIDER: env.PW_PROVIDER ?? 'mock',
  };
  e[cfg.database_url_env] = env[cfg.database_url_env]!;
  if (cfg.database_url_env !== 'PW_DATABASE_URL') e.PW_DATABASE_URL = env[cfg.database_url_env]!;
  for (const k of ['PW_SOFFICE', 'PW_PDFTOTEXT', 'XDG_RUNTIME_DIR', 'PW_AI_PAUSE_RECHECK_S']) if (env[k]) e[k] = env[k]!;
  return e;
}

export async function supervise(cfg: DeployConfig, env: Env, configFile: string, o: { measureEveryMs?: number; restartLimit?: number } = {}): Promise<number> {
  const d = dirs(cfg);
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true, mode: 0o700 });
  fs.rmSync(d.tmp, { recursive: true, force: true }); // parser temp files of a previous run
  fs.mkdirSync(d.tmp, { mode: 0o700 });
  const pool = new pg.Pool({ connectionString: env[cfg.database_url_env], max: 2 });
  const s = await schemaState(pool);
  if (!s.current) { await pool.end(); process.stderr.write(`schema is not current (${s.pending.length} pending): run pwctl migrate\n`); return 1; }
  const childEnvs = childEnv(cfg, env, configFile);
  const node = process.execPath;
  const specs = {
    api: [node, '--experimental-strip-types', '--no-warnings', path.join(HERE, 'serve.ts')],
    worker: [node, '--experimental-strip-types', '--no-warnings', path.join(APP_DIR, 'apps/worker/src/main.ts')],
  } as const;
  const children: Record<keyof typeof specs, ChildProcess | null> = { api: null, worker: null };
  const crashes: number[] = [];
  let stopping = false;
  let exitCode = 0;
  const writeState = () => fs.writeFileSync(path.join(d.run, 'state.json'), JSON.stringify({ pid: process.pid, api_pid: children.api?.pid ?? null, worker_pid: children.worker?.pid ?? null, started_at: new Date().toISOString() }), { mode: 0o600 });
  let shutdown: () => Promise<void> = async () => undefined;
  let done!: () => void;
  const finished = new Promise<void>((r) => { done = r; });
  const start = (name: keyof typeof specs) => {
    const [cmd, ...args] = specs[name];
    const log = new RotatingLog(d.logs, name, cfg.log.max_bytes, cfg.log.keep);
    const child = spawn(cmd, args, { cwd: APP_DIR, env: childEnvs, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', (b: Buffer) => log.write(b));
    child.stderr!.on('data', (b: Buffer) => log.write(b));
    child.on('exit', (code, signal) => {
      log.write(`[supervisor] ${name} exited (${signal ?? code})\n`);
      log.close();
      children[name] = null;
      if (stopping) { if (!children.api && !children.worker) done(); return; }
      const now = Date.now();
      crashes.push(now);
      while (crashes.length && crashes[0]! < now - 10 * 60_000) crashes.shift();
      if (crashes.length > (o.restartLimit ?? 5)) { exitCode = 1; void shutdown(); return; }
      setTimeout(() => { if (!stopping) { start(name); writeState(); } }, Math.min(1000 * 2 ** crashes.length, 30_000));
    });
    children[name] = child;
  };
  const measure = async () => {
    try { await recordDisk(pool, usedBytes(cfg.data_root), cfg.max_data_bytes); } catch (e) { process.stderr.write(`disk measure: ${(e as Error).message}\n`); }
  };
  await measure();
  const timer = setInterval(() => void measure(), o.measureEveryMs ?? 60_000);
  // safe stop: the worker first (it finishes the job in hand and takes no new one), then the API
  shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    const stopOne = (c: ChildProcess | null) => new Promise<void>((r) => {
      if (!c || c.exitCode !== null) return r();
      const kill = setTimeout(() => c.kill('SIGKILL'), 120_000);
      c.once('exit', () => { clearTimeout(kill); r(); });
      c.kill('SIGTERM');
    });
    await stopOne(children.worker);
    await stopOne(children.api);
    if (!children.api && !children.worker) done();
  };
  start('api');
  start('worker');
  writeState();
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  await finished;
  await pool.end();
  fs.rmSync(path.join(d.run, 'state.json'), { force: true });
  return exitCode;
}

// ---- verify-upgrade ----------------------------------------------------------------------------------
export function verifyUpgrade(cfg: DeployConfig, component: string, version: string, env: Env): UpgradeRecord {
  const { pins, verify_commands } = loadVersions();
  if (!(component in pins)) throw new Error(`${component} is not a pinned component`);
  if (!/^\d+(\.\d+){0,3}$|^[0-9a-f]{64}$/.test(version)) throw new Error('give the exact version that is installed (no latest, ranges or tags)');
  const commands = verify_commands.map(([cmd, ...args]) => {
    const r = spawnSync(cmd!, args, { cwd: APP_DIR, env: { PATH: env.PATH ?? '/usr/bin:/bin', HOME: env.HOME ?? '/nonexistent', PW_TEST_DATABASE_URL: env.PW_TEST_DATABASE_URL ?? '' }, stdio: 'inherit', timeout: 30 * 60_000 });
    return { cmd: [cmd, ...args].join(' '), exit: r.status ?? 1 };
  });
  const rec: UpgradeRecord = { component, from: pins[component] ?? null, to: version, verified_at: new Date().toISOString(), commands };
  const file = path.join(dirs(cfg).run, 'upgrades.json');
  const all = upgradesOf(cfg);
  all.push(rec);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
  return rec;
}

// ---- command line ----------------------------------------------------------------------------------
export async function main(argv: string[], env: Env): Promise<number> {
  const i = argv.indexOf('--config');
  const configFile = path.resolve(i >= 0 ? argv[i + 1] ?? '' : env.PW_DEPLOY_CONFIG ?? '');
  const args = i >= 0 ? argv.filter((_, k) => k !== i && k !== i + 1) : argv;
  const [cmd, ...rest] = args;
  if (!cmd) { process.stderr.write('usage: pwctl check|migrate|run|status|pause-ai --reason R|resume-ai --reason R|stop|verify-upgrade C V  [--config FILE]\n'); return 2; }
  let cfg: DeployConfig;
  try { cfg = loadConfig(configFile); } catch { process.stderr.write(`cannot read the config ${configFile} (--config or PW_DEPLOY_CONFIG)\n`); return 2; }
  const reason = () => { const k = rest.indexOf('--reason'); return k >= 0 ? rest[k + 1] ?? '' : ''; };
  const pool = () => new pg.Pool({ connectionString: env[cfg.database_url_env], max: 2 });

  if (cmd === 'check') {
    const r = await check(cfg, env);
    out(r);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'run' || cmd === 'migrate') {
    const r = await check(cfg, env);
    if (!r.ok) { out(r); return 1; }
    if (cmd === 'run') return supervise(cfg, env, configFile);
    // migrate: a complete backup first (when the database already holds data), then the migrations
    const p = pool();
    try {
      const s = await schemaState(p);
      if (s.current) { out({ migrated: [], note: 'the schema is current' }); return 0; }
      if (s.applied > 0) {
        if (!cfg.backup_dir) { out({ refused: 'set backup_dir: migrations run only after a backup (spec 12: restore before down migrations)' }); return 1; }
        const b = await createBackup({ databaseUrl: env[cfg.database_url_env]!, assetDir: dirs(cfg).assets, outDir: path.join(cfg.backup_dir, `before-migrate-${new Date().toISOString().replace(/[:.]/g, '-')}`) });
        if (b.status !== 'complete') { out({ refused: 'the backup before migrating failed', problems: b.manifest.problems }); return 1; }
      }
      const c = await p.connect();
      try { out({ migrated: await migrate(c, MIGRATIONS_DIR) }); } finally { c.release(); }
      return 0;
    } finally { await p.end(); }
  }
  if (cmd === 'status') {
    const s = await status(cfg, env);
    out(s);
    return s.health.ok && (s.db as { reachable: boolean }).reachable ? 0 : 1;
  }
  if (cmd === 'pause-ai' || cmd === 'resume-ai') {
    const p = pool();
    try { await setAiPause(p, cmd === 'pause-ai', reason()); } catch (e) { process.stderr.write(`${(e as Error).message} (--reason "...")\n`); return 2; } finally { await p.end(); }
    out({ ai_paused: cmd === 'pause-ai' });
    return 0;
  }
  if (cmd === 'stop') {
    let pid: number | null = null;
    try { pid = (JSON.parse(fs.readFileSync(path.join(dirs(cfg).run, 'state.json'), 'utf8')) as { pid: number }).pid; } catch { /* not running */ }
    if (!alive(pid)) { out({ stopped: true, note: 'was not running' }); return 0; }
    process.kill(pid!, 'SIGTERM');
    const deadline = Date.now() + 5 * 60_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    out({ stopped: !alive(pid) });
    return alive(pid) ? 1 : 0;
  }
  if (cmd === 'verify-upgrade') {
    const [component, version] = rest;
    if (!component || !version) { process.stderr.write('verify-upgrade needs the component and the installed version\n'); return 2; }
    const r = verifyUpgrade(cfg, component, version, env);
    out(r);
    return r.commands.every((x) => x.exit === 0) ? 0 : 1;
  }
  process.stderr.write(`unknown command ${cmd}\n`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (e: unknown) => { process.stderr.write(`${(e as Error).message}\n`); process.exitCode = 1; });
}
