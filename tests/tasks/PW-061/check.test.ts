// PW-061 TST-061B: the deployment check refuses unbounded storage on the OS disk or a container layer, a
// public listen address, the test or development database as production, and versions that are not exact
// pins or that changed without a passed upgrade check. Also: the logs are bounded.
import { afterAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkDeployment, fsTypeOf, lockfileSha, type DeployConfig, type Pins, type Probe, type UpgradeRecord } from '../../../infra/deploy/check.ts';
import { RotatingLog } from '../../../infra/deploy/logs.ts';
import { ADDS_FILES } from '../../../infra/deploy/serve.ts';
import { childEnv, loadVersions, recordedSupervisor, startTicks } from '../../../infra/deploy/pwctl.ts';
import { spawn } from 'node:child_process';

const tmp: string[] = [];
afterAll(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });
const newDir = (p: string, mode = 0o700) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); fs.chmodSync(d, mode); tmp.push(d); return d; };

const home = newDir('pw061-home-');
const app = newDir('pw061-app-');
const root = newDir('pw061-data-');
const GiB = 1024 ** 3;
const cfg = (over: Partial<DeployConfig> = {}): DeployConfig => ({
  data_root: root, max_data_bytes: 20 * GiB, database_url_env: 'PW_DATABASE_URL', listen: { host: '127.0.0.1', port: 8787 },
  public_origin: 'http://127.0.0.1:8787', web_dist: path.join(app, 'apps/web/dist'), log: { max_bytes: 10 * 1024 * 1024, keep: 5 }, ...over,
});
const PINS: Pins = { node: '22.22.0', postgres: '16', pnpm_lock: 'a'.repeat(64), libreoffice: '24.2.7.2', claude_code: null };
const probe = (over: Partial<Probe> = {}): Probe => ({
  fsType: () => 'ext4', home, uid: process.getuid!(), appDir: app,
  installed: { node: '22.22.0', postgres: '16', pnpm_lock: 'a'.repeat(64), libreoffice: '24.2.7.2' },
  env: { PW_DATABASE_URL: 'postgres://pw@localhost:5432/paper_workspace?host=/run/pw', PW_TEST_DATABASE_URL: 'postgres://pw@localhost:54329/pw_test?host=/tmp/sock' }, ...over,
});
const run = (c: DeployConfig, p: Probe = probe(), pins: Pins = PINS, up: UpgradeRecord[] = []) => checkDeployment(c, pins, up, p);
const refused = (r: { ok: boolean; problems: string[] }, re: RegExp) => { expect(r.ok).toBe(false); expect(r.problems.join('\n')).toMatch(re); };

describe('TST-061B: the deployment check', () => {
  test('a dedicated private folder with a cap, loopback, its own database and exact pins: accepted', () => {
    expect(run(cfg())).toEqual({ ok: true, problems: [], warnings: [] });
    expect(run(cfg({ public_origin: 'https://pw.lab.example' })).ok).toBe(true);
    expect(run(cfg({ listen: { host: '::1', port: 8787 } })).ok).toBe(true);
  });

  test('storage: a container layer or memory, no cap, a tiny cap, or unbounded logs are refused', () => {
    for (const t of ['overlay', 'tmpfs', 'ramfs', 'aufs']) refused(run(cfg(), probe({ fsType: () => t })), new RegExp(`on ${t}: not a durable volume`));
    refused(run(cfg(), probe({ fsType: () => 'unknown' })), /could not be determined .* refused rather than assumed durable/);
    expect(run(cfg({ max_data_bytes: 2 ** 52 })).warnings.join()).toMatch(/less than max_data_bytes .* the disk fills before the cap/);
    refused(run(cfg({ max_data_bytes: undefined as never })), /max_data_bytes must be set/);
    refused(run(cfg({ max_data_bytes: 100 * 1024 * 1024 })), /max_data_bytes must be set/);
    refused(run(cfg({ log: { max_bytes: 0, keep: 5 } })), /log\.max_bytes/);
    refused(run(cfg({ log: { max_bytes: 1024 * 1024, keep: 0 } })), /log\.keep/);
  });

  test('the data root must be a dedicated, private folder of the user, outside the app and developer CLI state', () => {
    refused(run(cfg({ data_root: 'relative/dir' })), /absolute/);
    refused(run(cfg({ data_root: path.join(root, 'missing') })), /does not exist/);
    const open = newDir('pw061-open-', 0o755);
    refused(run(cfg({ data_root: open })), /private \(mode 0700; it is 755\)/);
    const link = path.join(newDir('pw061-l-'), 'link');
    fs.symlinkSync(root, link);
    refused(run(cfg({ data_root: link })), /symlink/);
    refused(run(cfg(), probe({ uid: process.getuid!() + 1 })), /owned by the user/);
    refused(run(cfg({ data_root: home }), probe()), /not the home folder/);
    const inApp = path.join(app, 'data');
    fs.mkdirSync(inApp, { mode: 0o700 });
    refused(run(cfg({ data_root: inApp })), /outside the app/);
    for (const dev of ['.claude', '.codex', '.config/claude']) {
      const d = path.join(home, dev, 'pw');
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      refused(run(cfg({ data_root: d })), new RegExp(`inside ~/${dev.replace('.', '\\.')}`));
    }
  });

  test('network: only loopback is listened on; plain http only for this machine', () => {
    for (const host of ['0.0.0.0', '::', '192.168.0.10', 'pw.lab.example']) refused(run(cfg({ listen: { host, port: 8787 } })), /listen\.host must be loopback/);
    refused(run(cfg({ listen: { host: '127.0.0.1', port: 80 } })), /listen\.port/);
    refused(run(cfg({ public_origin: 'http://pw.lab.example' })), /plain http is only for this machine/);
    refused(run(cfg({ public_origin: 'https://pw.lab.example/app' })), /origin only/);
  });

  test('the production database is never the test or development one, and a remote one needs verified TLS', () => {
    const env = (url: string) => probe({ env: { PW_DATABASE_URL: url, PW_TEST_DATABASE_URL: 'postgres://pw@localhost:54329/pw_test?host=/tmp/sock' } });
    refused(run(cfg(), env('postgres://pw@localhost:54329/pw_test_123?host=/tmp/sock')), /not be a test or development database \(pw_test_123\)/);
    refused(run(cfg(), env('postgres://pw@localhost:54329/pw_dev?host=/tmp/sock')), /test or development database \(pw_dev\)/);
    refused(run(cfg(), probe({ env: { PW_DATABASE_URL: 'postgres://pw@localhost:54329/papers?host=/tmp/sock', PW_TEST_DATABASE_URL: 'postgres://pw@localhost:54329/papers?host=/tmp/sock' } })), /is the test database/);
    refused(run(cfg(), env('postgres://pw:x@db.lab.example:5432/papers')), /sslmode=verify-full/);
    refused(run(cfg(), env('postgres://pw:x@db.lab.example:5432/papers?sslmode=require')), /sslmode=verify-full/);
    expect(run(cfg(), env('postgres://pw@db.lab.example:5432/papers?sslmode=verify-full')).ok).toBe(true);
    // the same database however the URL spells it (review n2)
    for (const test of ['postgres://pw@127.0.0.1/papers', 'postgres://pw@[::1]:5432/papers', 'postgres://other@localhost:5432/papers']) {
      refused(run(cfg(), probe({ env: { PW_DATABASE_URL: 'postgres://pw@localhost/papers', PW_TEST_DATABASE_URL: test } })), /is the test database/);
    }
    refused(run(cfg(), probe({ env: { PW_DATABASE_URL: 'postgres://pw@x/papers?host=/run/pw/', PW_TEST_DATABASE_URL: 'postgres://pw@y/papers?host=/run/pw' } })), /is the test database/);
    expect(run(cfg(), probe({ env: { PW_DATABASE_URL: 'postgres://pw@localhost:5433/papers', PW_TEST_DATABASE_URL: 'postgres://pw@localhost:5432/papers' } })).ok).toBe(true);
    refused(run(cfg(), probe({ env: {} })), /PW_DATABASE_URL is not set/);
    refused(run(cfg({ database_url_env: 'pw url' })), /database_url_env/);
  });

  test('versions: only exact pins; a changed version needs a passed upgrade check first', () => {
    for (const v of ['latest', '^22.1.0', '22.x', 'lts', '>=16', 'next']) refused(run(cfg(), probe(), { ...PINS, node: v }), new RegExp(`pin node=${v.replace(/[\^.*+?()[\]{}|$]/g, '\\$&')} is not an exact version`));
    const newer = probe({ installed: { ...probe().installed, node: '22.23.0' } });
    refused(run(cfg(), newer), /node: installed 22\.23\.0, pinned 22\.22\.0 — run `pwctl verify-upgrade node`/);
    const passed: UpgradeRecord = { component: 'node', from: '22.22.0', to: '22.23.0', verified_at: '2026-10-10T00:00:00Z', commands: [{ cmd: 'pnpm run test:contracts', exit: 0 }] };
    const r = run(cfg(), newer, PINS, [passed]);
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/node: 22\.23\.0 was checked by verify-upgrade; update the pin/);
    refused(run(cfg(), newer, PINS, [{ ...passed, commands: [{ cmd: 'pnpm run test:contracts', exit: 1 }] }]), /verify-upgrade/);
    refused(run(cfg(), newer, PINS, [{ ...passed, commands: [] }]), /verify-upgrade/);
    refused(run(cfg(), newer, PINS, [{ ...passed, to: '22.24.0' }]), /verify-upgrade/);
    refused(run(cfg(), probe({ installed: { ...probe().installed, claude_code: '2.1.0' } })), /claude_code: installed 2\.1\.0, pinned nothing/);
    refused(run(cfg(), probe({ installed: { ...probe().installed, gemini: '1.0.0' } })), /gemini is installed \(1\.0\.0\) but has no pin/);
  });

  test('the repository\'s own pins are exact and match this checkout (a dependency change needs a new pin)', () => {
    const { pins, verify_commands } = loadVersions();
    for (const [c, v] of Object.entries(pins)) if (v !== null) expect(v, c).toMatch(/^\d+(\.\d+){0,3}$|^[0-9a-f]{64}$/);
    expect(pins.node).toBe(process.versions.node);
    expect(pins.pnpm_lock).toBe(lockfileSha(path.resolve('.')));
    expect(verify_commands.length).toBeGreaterThan(0);
  });

  test('the filesystem of a folder is read from the mount table (longest mount point)', () => {
    const mounts = '/dev/vda / ext4 rw 0 0\noverlay /var/lib/x overlay rw 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/vdb /data xfs rw 0 0\n';
    expect(fsTypeOf('/data/pw', mounts)).toBe('xfs');
    expect(fsTypeOf('/var/lib/x/pw', mounts)).toBe('overlay');
    expect(fsTypeOf('/run/user/1000/pw', mounts)).toBe('tmpfs');
    expect(fsTypeOf('/home/u/pw', mounts)).toBe('ext4');
    expect(fsTypeOf('/datax/pw', mounts)).toBe('ext4');
    // mount points with spaces or tabs are escaped octal in /proc/mounts (review n2)
    expect(fsTypeOf('/mnt/my disk/pw', `${mounts}/dev/vdc /mnt/my\\040disk tmpfs rw 0 0\n`)).toBe('tmpfs');
    expect(fsTypeOf('/mnt/a\tb/pw', `${mounts}/dev/vdc /mnt/a\\011b overlay rw 0 0\n`)).toBe('overlay');
  });
});

describe('TST-061B: logs are bounded', () => {
  test('a log never holds more than (keep + 1) × max_bytes', () => {
    const d = newDir('pw061-logs-');
    const log = new RotatingLog(d, 'api', 1000, 2);
    for (let i = 0; i < 500; i++) log.write(`line ${i} ${'x'.repeat(40)}\n`);
    log.close();
    const files = fs.readdirSync(d).sort();
    expect(files).toEqual(['api.log', 'api.log.1', 'api.log.2']);
    const total = files.reduce((n, f) => n + fs.statSync(path.join(d, f)).size, 0);
    expect(total).toBeLessThanOrEqual(3000);
    expect(fs.readFileSync(path.join(d, 'api.log'), 'utf8')).toContain('line 499');
    for (const f of files) expect(fs.statSync(path.join(d, f)).mode & 0o077).toBe(0);
  });
});

describe('TST-061B: the supervisor gives its children a built environment, not its own', () => {
  test('only the named settings reach the API and the worker', () => {
    const operator = {
      PATH: '/usr/bin', HOME: '/home/u', PW_DATABASE_URL: 'postgres://pw@localhost/papers?host=/run/pw', PW_TEST_DATABASE_URL: 'postgres://pw@localhost/pw_test',
      ANTHROPIC_API_KEY: 'synthetic-not-a-key', GITHUB_TOKEN: 'synthetic', SSH_AUTH_SOCK: '/tmp/agent', CLAUDE_CONFIG_DIR: '/home/u/.claude', PW_SOFFICE: '/usr/bin/soffice', PW_AI_PAUSE_RECHECK_S: '5',
    };
    const e = childEnv(cfg(), operator, '/home/u/.config/paper-workspace/deploy.json');
    expect(Object.keys(e).sort()).toEqual(['HOME', 'LANG', 'NODE_ENV', 'PATH', 'PW_AI_PAUSE_RECHECK_S', 'PW_ASSET_DIR', 'PW_DATABASE_URL', 'PW_DEPLOY_CONFIG', 'PW_PROVIDER', 'PW_SOFFICE', 'TMPDIR']);
    expect(e).toMatchObject({ TMPDIR: path.join(root, 'tmp'), PW_ASSET_DIR: path.join(root, 'assets'), PW_PROVIDER: 'mock' });
    // a database URL kept under another name is handed to the app under the name it reads
    const named = childEnv(cfg({ database_url_env: 'PW_PROD_URL' }), { ...operator, PW_PROD_URL: 'postgres://pw@localhost/prod' }, '/x.json');
    expect(named.PW_PROD_URL).toBe('postgres://pw@localhost/prod');
    expect(named.PW_DATABASE_URL).toBe('postgres://pw@localhost/prod');
  });
});

describe('TST-061B: over the size cap, every route that adds a file is refused', () => {
  test('the routes that write into the data root are all caught; editing is not', () => {
    const P = '/api/papers/00000000-0000-4000-8000-000000000000';
    // every route that stores a file (asset store or export row): reviewed list (review m3)
    const writes: [string, string][] = [
      [`${P}/assets?license=cc-by`, 'application/pdf'],
      [`${P}/assets/fetch`, 'application/json'],
      [`${P}/figures/f/files?name=a.png`, 'image/png'],
      [`${P}/imports`, 'application/json'],
      [`${P}/imports?name=a.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      [`${P}/exports`, 'application/json'],
      [`${P}/submissions`, 'application/json'],
    ];
    for (const [url, type] of writes) expect(ADDS_FILES('POST', url, type), url).toBe(true);
    for (const url of [`${P}/documents/d/saves`, `${P}/story/revisions`, `${P}/assets/a/anchors`, `${P}/snapshots`]) expect(ADDS_FILES('POST', url, 'application/json; charset=utf-8'), url).toBe(false);
    expect(ADDS_FILES('GET', `${P}/exports`, 'application/json')).toBe(false);
  });
});

describe('TST-061A: a recorded supervisor is trusted only if it is still that process', () => {
  test('pid, start time and command must all match', async () => {
    // a process whose command line looks like a supervisor (another installation, or a reused pid)
    const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'infra/deploy/pwctl.ts', 'run'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const start = startTicks(p.pid!);
      expect(start).toMatch(/^\d+$/);
      expect(recordedSupervisor({ pid: p.pid, pid_start: start })).toBe(p.pid);
      expect(recordedSupervisor({ pid: p.pid, pid_start: String(Number(start) - 1) })).toBeNull(); // the pid was reused
      expect(recordedSupervisor({ pid: p.pid })).toBeNull();
      expect(recordedSupervisor({ pid: process.pid, pid_start: startTicks(process.pid) })).toBeNull(); // not a supervisor
      expect(recordedSupervisor(null)).toBeNull();
    } finally { p.kill('SIGKILL'); }
  });
});

