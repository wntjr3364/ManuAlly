// PW-061 TST-061A: a clean, dedicated installation is deployed privately, reports its state and stops
// safely — with the real operator command (pwctl), a production database of its own (not a test name),
// the real built web app, and a real browser. TST-061B where it needs a running system: a refused check
// starts nothing; migrations of a database with data run only after a backup; over the size cap uploads
// are refused.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import pg from 'pg';
import { chromium } from '@playwright/test';
import { requireTestDatabaseUrl } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { recordDisk } from '../../../infra/deploy/pwctl.ts';
import { startServer, SECURITY_HEADERS } from '../../../infra/deploy/serve.ts';
import type { DeployConfig } from '../../../infra/deploy/check.ts';
import { PAPER_V1 } from '../PW-035/fixtures.ts';

const MIGRATIONS = path.resolve('db/migrations');
const tmp: string[] = [];
const dbs: string[] = [];
const newDir = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); fs.chmodSync(d, 0o700); tmp.push(d); return d; };
// a production-named database on the local test cluster (never pw_test*: the deploy check refuses those)
async function prodDb(): Promise<string> {
  const base = requireTestDatabaseUrl();
  const name = `pwdrill_${randomBytes(4).toString('hex')}`;
  const c = new pg.Client({ connectionString: base });
  await c.connect();
  try { await c.query(`CREATE DATABASE "${name}"`); } finally { await c.end(); }
  dbs.push(name);
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
}
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const ctl = (args: string[], env: Record<string, string>) => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'infra/deploy/pwctl.ts', ...args], { env, encoding: 'utf8', timeout: 180_000 });
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
};
const until = async (what: string | (() => string), f: () => Promise<boolean> | boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await f()) return; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`timed out waiting for: ${typeof what === 'function' ? what() : what}`);
};

let root: string;
let dist: string;
let url: string;
let port: number;
let origin: string;
let configFile: string;
let cfg: DeployConfig;
let env: Record<string, string>;
let sup: ChildProcess | null = null;
let supExit: Promise<number | null>;
let pool: pg.Pool;
let supErrFile = '';

beforeAll(async () => {
  root = newDir('pw061-root-');
  dist = path.join(newDir('pw061-web-'), 'dist');
  // the real web app, built for production
  const b = spawnSync(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.config.ts', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: path.resolve('apps/web'), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' }, encoding: 'utf8', timeout: 180_000 });
  if (b.status !== 0) throw new Error(`web build failed: ${b.stderr}`);
  url = await prodDb();
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  cfg = { data_root: root, max_data_bytes: 2 * 1024 ** 3, database_url_env: 'PW_PROD_URL', listen: { host: '127.0.0.1', port }, public_origin: origin, web_dist: dist, log: { max_bytes: 64 * 1024, keep: 2 }, backup_dir: newDir('pw061-backups-') };
  configFile = path.join(newDir('pw061-cfg-'), 'deploy.json');
  fs.writeFileSync(configFile, JSON.stringify(cfg));
  env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', PW_PROD_URL: url, PW_TEST_DATABASE_URL: requireTestDatabaseUrl(), PW_DEPLOY_CONFIG: configFile, PW_AI_PAUSE_RECHECK_S: '1' };
  pool = new pg.Pool({ connectionString: url, max: 3 });
}, 240_000);
let ownerMade = false;
const owner = async () => { if (!ownerMade) { await createOwner(pool, { username: 'drill', password: 'correct horse battery' }); ownerMade = true; } };
afterAll(async () => {
  if (sup && sup.exitCode === null) sup.kill('SIGKILL');
  await pool?.end();
  const c = new pg.Client({ connectionString: requireTestDatabaseUrl() });
  await c.connect();
  for (const d of dbs) await c.query(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
  await c.end();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

describe('TST-061A: a private deployment that reports its state and stops safely', () => {
  test('check passes; run refuses an unmigrated database; migrate prepares it (a fresh one needs no backup)', () => {
    const c = ctl(['check'], env);
    expect(c.json, c.stderr).toMatchObject({ ok: true, problems: [] });
    const early = ctl(['run'], env);
    expect(early.code).toBe(1);
    expect(early.stderr).toMatch(/schema is not current .*pwctl migrate/);
    const m = ctl(['migrate'], env);
    expect(m.code, m.stderr).toBe(0);
    expect(m.json.migrated.length).toBe(fs.readdirSync(MIGRATIONS).length);
    expect(ctl(['migrate'], env).json).toEqual({ migrated: [], note: 'the schema is current' });
  });

  test('run: API and web on loopback with the hardening headers; the built app works under them in a browser', async () => {
    // the supervisor's own output goes to a file: `pwctl stop` below runs synchronously, and a pipe nobody
    // reads meanwhile could fill up and block the supervisor
    supErrFile = path.join(newDir('pw061-sup-'), 'supervisor.err');
    const errFd = fs.openSync(supErrFile, 'w');
    sup = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'infra/deploy/pwctl.ts', 'run'], { env, stdio: ['ignore', 'ignore', errFd] });
    fs.closeSync(errFd);
    const supErr = () => fs.readFileSync(supErrFile, 'utf8');
    supExit = new Promise((r) => sup!.on('exit', (code) => r(code)));
    await until(() => `the API answers (${supErr()})`,  async () => { try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; } });

    const h = await fetch(`${origin}/api/health`);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(h.headers.get(k), k).toBe(v);
    const page = await fetch(`${origin}/`);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await page.text();
    const js = html.match(/src="(\/assets\/[^"]+\.js)"/)![1]!;
    expect((await fetch(`${origin}${js}`)).headers.get('content-type')).toMatch(/javascript/);
    // client-side routes get the app; nothing outside the build is served
    expect(await (await fetch(`${origin}/papers/x`)).text()).toBe(html);
    expect(await (await fetch(`${origin}/..%2f..%2f..%2fetc%2fpasswd`)).text()).toBe(html);
    expect((await fetch(`${origin}/api/no-such-route`)).status).toBe(404);
    // nothing listens beyond loopback
    const outward = os.networkInterfaces();
    const lan = Object.values(outward).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (lan) await expect(fetch(`http://${lan}:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow(); // (some sandboxes have no LAN address; the listen host rule is also unit-tested)

    // a browser: sign in and see the paper list, with no CSP violation
    await owner();
    const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });
    try {
      const p = await browser.newPage();
      const violations: string[] = [];
      p.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
      p.on('pageerror', (e) => violations.push(e.message));
      await p.goto(`${origin}/`);
      await p.getByLabel('사용자 이름').fill('drill');
      await p.getByLabel('비밀번호').fill('correct horse battery');
      await p.getByRole('button', { name: '로그인' }).click();
      await p.getByRole('button', { name: '로그아웃' }).waitFor({ timeout: 15_000 });
      expect(violations).toEqual([]);
    } finally { await browser.close(); }
  }, 180_000);

  test('status: processes, health, schema, AI, disk, queue, last backup, logs — what is not known is UNKNOWN', async () => {
    const s = ctl(['status'], env);
    expect(s.code, s.stdout + s.stderr).toBe(0);
    expect(s.json.processes).toMatchObject({ supervisor: true, api: true, worker: true });
    expect(s.json.health).toEqual({ ok: true, status: 200 });
    expect(s.json.db).toMatchObject({ reachable: true, schema: { current: true, pending: [] }, ai: { paused: false }, running_ai_jobs: 0 });
    expect(s.json.db.disk.cap_bytes).toBe(2 * 1024 ** 3);
    expect(s.json.db.disk.used_bytes).toBeGreaterThanOrEqual(0); // measured when the supervisor started
    expect(Date.parse(s.json.db.disk.checked_at)).not.toBeNaN();
    expect(s.json.db.disk.pressure).toBe(false);
    expect(s.json.last_backup).toBe('none');
    expect(s.json.logs_bytes).toBeGreaterThan(0);
    // the worker's temporary files are under the data root
    expect(fs.existsSync(path.join(root, 'tmp'))).toBe(true);
    const noBackupDir = path.join(newDir('pw061-cfg2-'), 'deploy.json');
    fs.writeFileSync(noBackupDir, JSON.stringify({ ...cfg, backup_dir: undefined }));
    expect(ctl(['status', '--config', noBackupDir], env).json.last_backup).toBe('UNKNOWN');
  });

  test('pause-ai: AI work waits while manual editing goes on; resume-ai lets it run', async () => {
    await owner();
    const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'drill', password: 'correct horse battery' }) });
    const H = { cookie: String(login.headers.get('set-cookie')).split(';')[0]!, 'x-pw-csrf': (await login.json()).csrfToken as string, origin, 'content-type': 'application/json' };
    const post = async (u: string, body: unknown) => { const r = await fetch(`${origin}${u}`, { method: 'POST', headers: H, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
    const paper = (await post('/api/papers', { working_title: 'Drill', article_type: 'research_article' })).json;
    const P = `/api/papers/${paper.id}`;
    const story = { question: 'Does ABC1 respond to drought in roots of this species?', main_message: 'ABC1 is induced by drought', novelty: 'First root-specific marker', evidence_links: [], competing_explanations: [], presentation_order: [], limitations: [] };
    const brief = { purpose: 'drill', audience: 'x', known_facts: [], missing_material: [], avoid_claims: [] };
    const s1 = (await post(`${P}/story/revisions`, { parent_revision_id: null, brief, story })).json;
    expect((await post(`${P}/story/revisions/${s1.id}/approve`, { intent: 'approve_story', content_hash: s1.content_hash })).status).toBe(200);

    expect(ctl(['pause-ai'], env).code).toBe(2); // a reason is required
    expect(ctl(['pause-ai', '--reason', 'drill: provider maintenance'], env).json).toEqual({ ai_paused: true });
    const run = await post(`${P}/story-alternatives/runs`, { base_story_revision_id: s1.id, idempotency_key: `k-${Date.now()}` });
    expect(run.status, JSON.stringify(run.json)).toBe(201);
    const jobState = async () => (await pool.query<{ status: string; last_error: string | null }>('SELECT status, last_error FROM jobs WHERE id = $1', [run.json.job.id])).rows[0]!;
    await until('the worker has seen the paused job', async () => /\[ai_paused\]/.test((await jobState()).last_error ?? ''), 30_000);
    await new Promise((r) => setTimeout(r, 2500));
    expect((await jobState()).status).not.toBe('SUCCEEDED');
    expect(ctl(['status'], env).json.db.ai).toMatchObject({ paused: true, reason: 'drill: provider maintenance' });
    // manual editing is not paused
    const manual = await post(`${P}/story/revisions`, { parent_revision_id: s1.id, brief, story: { ...story, main_message: 'ABC1 is induced by drought (edited by hand)' } });
    expect(manual.status).toBe(201);

    expect(ctl(['resume-ai', '--reason', 'drill: maintenance done'], env).json).toEqual({ ai_paused: false });
    await until('the AI job ran after the pause', async () => (await jobState()).status === 'SUCCEEDED', 45_000);
  }, 120_000);

  test('a crashed worker is restarted by the supervisor; the logs stay bounded', async () => {
    const before = JSON.parse(fs.readFileSync(path.join(root, 'run', 'state.json'), 'utf8'));
    process.kill(before.worker_pid, 'SIGKILL');
    await until('a new worker', () => { try { const s = JSON.parse(fs.readFileSync(path.join(root, 'run', 'state.json'), 'utf8')); return s.worker_pid !== before.worker_pid && s.worker_pid !== null; } catch { return false; } }, 30_000);
    const now = JSON.parse(fs.readFileSync(path.join(root, 'run', 'state.json'), 'utf8'));
    expect(() => process.kill(now.worker_pid, 0)).not.toThrow();
    expect(fs.readFileSync(path.join(root, 'logs', 'worker.log'), 'utf8')).toMatch(/\[supervisor\] worker exited \(SIGKILL\)|worker running/);
    for (const name of ['api', 'worker']) {
      const files = fs.readdirSync(path.join(root, 'logs')).filter((f) => f.startsWith(`${name}.log`));
      expect(files.length).toBeLessThanOrEqual(3);
      for (const f of files) expect(fs.statSync(path.join(root, 'logs', f)).size).toBeLessThanOrEqual(64 * 1024);
    }
  }, 60_000);

  test('stop: the worker finishes and stops, then the API; the supervisor exits cleanly', async () => {
    const s = ctl(['stop'], env);
    const tail = (f: string) => { try { return fs.readFileSync(path.join(root, 'logs', f), 'utf8').slice(-1500); } catch { return '(none)'; } };
    const st = (() => { try { return fs.readFileSync(path.join(root, 'run', 'state.json'), 'utf8'); } catch { return '(no state)'; } })();
    expect(s.json, `${s.stderr}\nsupervisor: ${fs.readFileSync(supErrFile, 'utf8')}\nstate: ${st}\nworker.log: ${tail('worker.log')}\napi.log: ${tail('api.log')}`).toEqual({ stopped: true });
    expect(await supExit).toBe(0);
    expect(fs.existsSync(path.join(root, 'run', 'state.json'))).toBe(false);
    const after = ctl(['status'], env);
    expect(after.code).toBe(1);
    expect(after.json.processes).toBe('not running');
    expect(after.json.health.ok).toBe(false);
    expect(ctl(['stop'], env).json).toEqual({ stopped: true, note: 'was not running' });
  }, 300_000);
});

describe('TST-061B: refused before anything starts, backups before migrations, the size cap', () => {
  test('a config the check refuses starts nothing', async () => {
    const bad = path.join(newDir('pw061-bad-'), 'deploy.json');
    const p2 = await freePort();
    fs.writeFileSync(bad, JSON.stringify({ ...cfg, listen: { host: '0.0.0.0', port: p2 } }));
    const r = ctl(['run', '--config', bad], env);
    expect(r.code).toBe(1);
    expect(r.json.problems.join()).toMatch(/listen\.host must be loopback/);
    await expect(fetch(`http://127.0.0.1:${p2}/api/health`, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
    const testDb = path.join(newDir('pw061-bad2-'), 'deploy.json');
    fs.writeFileSync(testDb, JSON.stringify({ ...cfg, database_url_env: 'PW_TEST_DATABASE_URL' }));
    expect(ctl(['run', '--config', testDb], env).json.problems.join()).toMatch(/test or development database|is the test database/);
  });

  test('migrating a database that holds data takes a complete backup first; without a backup folder it is refused', async () => {
    const older = await prodDb();
    const dir = newDir('pw061-old-migrations-');
    for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f < 'pw_061')) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
    const c = new pg.Client({ connectionString: older });
    await c.connect();
    await migrate(c, dir);
    await c.end();
    const e2 = { ...env, PW_PROD_URL: older };
    const noBackup = path.join(newDir('pw061-nb-'), 'deploy.json');
    fs.writeFileSync(noBackup, JSON.stringify({ ...cfg, backup_dir: undefined }));
    const refused = ctl(['migrate', '--config', noBackup], e2);
    expect(refused.code).toBe(1);
    expect(refused.json.refused).toMatch(/set backup_dir/);
    const ok = ctl(['migrate'], e2);
    expect(ok.code, ok.stderr + ok.stdout).toBe(0);
    expect(ok.json.migrated).toEqual(fs.readdirSync(MIGRATIONS).filter((f) => f >= 'pw_061').sort());
    const sets = fs.readdirSync(cfg.backup_dir!).filter((n) => n.startsWith('before-migrate-'));
    expect(sets.length).toBe(1);
    expect(fs.existsSync(path.join(cfg.backup_dir!, sets[0]!, 'COMPLETE'))).toBe(true);
  }, 120_000);

  test('over the size cap uploads and new files are refused (507); reading and editing go on', async () => {
    const p3 = await freePort();
    const local: DeployConfig = { ...cfg, listen: { host: '127.0.0.1', port: p3 }, public_origin: `http://127.0.0.1:${p3}` };
    { const c = await pool.connect(); await migrate(c, MIGRATIONS); c.release(); } // (nothing to do after the drill above; lets this test run alone)
    await owner();
    await recordDisk(pool, cfg.max_data_bytes, cfg.max_data_bytes);
    const srv = await startServer(local, env);
    try {
      const o = `http://127.0.0.1:${p3}`;
      const login = await fetch(`${o}/api/auth/login`, { method: 'POST', headers: { origin: o, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'drill', password: 'correct horse battery' }) });
      const H = { cookie: String(login.headers.get('set-cookie')).split(';')[0]!, 'x-pw-csrf': (await login.json()).csrfToken as string, origin: o };
      const paper = await fetch(`${o}/api/papers`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ working_title: 'Pressure', article_type: 'research_article' }) });
      expect(paper.status).toBe(201);
      const id = (await paper.json()).id;
      const up = await fetch(`${o}/api/papers/${id}/assets?license=cc-by`, { method: 'POST', headers: { ...H, 'content-type': 'application/pdf' }, body: new Uint8Array(Buffer.from('%PDF-1.4 drill')) });
      expect(up.status).toBe(507);
      expect((await up.json()).error).toBe('disk_pressure');
      expect((await fetch(`${o}/api/papers/${id}`, { headers: H })).status).toBe(200);
      // when space is back an upload works, and a served original keeps its own, stricter policy (PW-034 sandbox)
      await recordDisk(pool, 1, cfg.max_data_bytes);
      await new Promise((r) => setTimeout(r, 5500)); // the server re-reads the flag every 5 s
      const ok = await fetch(`${o}/api/papers/${id}/assets?license=cc-by`, { method: 'POST', headers: { ...H, 'content-type': 'application/pdf' }, body: new Uint8Array(PAPER_V1()) });
      expect(ok.status, await ok.clone().text()).toBe(201);
      const content = await fetch(`${o}/api/papers/${id}/assets/${(await ok.json()).id}/content`, { headers: H });
      expect(content.status).toBe(200);
      expect(content.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
      expect(content.headers.get('x-frame-options')).toBe('DENY');
      const log = (await pool.query("SELECT control, actor FROM ops_control_log WHERE control LIKE 'disk%' ORDER BY id")).rows;
      expect(log.slice(-2)).toEqual([{ control: 'disk_pressure_on', actor: 'supervisor' }, { control: 'disk_pressure_off', actor: 'supervisor' }]);
    } finally {
      await srv.close();
      await recordDisk(pool, 1, cfg.max_data_bytes);
    }
  }, 90_000);
});
