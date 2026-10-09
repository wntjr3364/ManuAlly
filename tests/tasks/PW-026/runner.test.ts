// PW-026 — run folders and the Linux sandbox (unshare backend here; bubblewrap argv checked statically,
// bubblewrap itself is not installed in this container).
// TST-026A: a run writes only inside its own folders; the source tree, a developer CLI state folder and
//   an existing session state stay unchanged.
// TST-026B: symlinks, path traversal, the host HOME, the Docker socket and original write paths are
//   not reachable from inside the sandbox.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto, { randomUUID } from 'node:crypto';
import { prepareRun, removeRun } from '../../../apps/worker/src/runner/index.ts';
import { bwrapArgs, runSandboxed, sandboxAvailable, verifyOuterSandbox } from '../../../infra/sandbox/sandbox.ts';

const NODE_ROOT = path.dirname(path.dirname(process.execPath));
const PROBE = path.resolve('infra/sandbox/probe.mjs');
let base: string;
let runsRoot: string;
let outside: string; // stands for host data: a developer CLI state folder, a session state, a secret
let decoyInHome: string;
const hash = (dir: string) => {
  const h = crypto.createHash('sha256');
  const walk = (d: string) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); const st = fs.lstatSync(p); h.update(`${p}:${st.mode}:${st.size}:${st.mtimeMs}`); if (st.isDirectory()) walk(p); else if (st.isFile()) h.update(fs.readFileSync(p)); } };
  walk(dir);
  return h.digest('hex');
};

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'pw026-'));
  runsRoot = path.join(base, 'runs');
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pw026-host-'));
  fs.mkdirSync(path.join(outside, '.claude', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(outside, '.claude', '.credentials.json'), '{"token":"developer-secret"}');
  fs.writeFileSync(path.join(outside, '.claude', 'projects', 'session.jsonl'), '{"existing":"session"}\n');
  fs.writeFileSync(path.join(outside, 'sentinel.json'), '{"claude_agent":{"status":"isolated"}}');
  decoyInHome = path.join(os.homedir(), `.pw026-decoy-${randomUUID()}`);
  fs.writeFileSync(decoyInHome, 'host home secret', { mode: 0o600 });
});
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(decoyInHome, { force: true });
});

describe('run folders', () => {
  test('a run gets private folders and read-only copies of its inputs', () => {
    const src = fs.mkdtempSync(path.join(base, 'src-'));
    fs.writeFileSync(path.join(src, 'data.csv'), 'a,b\n1,2\n');
    const run = prepareRun({ runsRoot, runId: randomUUID(), inputs: [{ sourceRoot: src, relPath: 'data.csv' }] });
    for (const d of [run.dir, run.cwd, run.homeDir, run.tmpDir]) expect(fs.statSync(d).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(run.inputsDir, 'data.csv'), 'utf8')).toBe('a,b\n1,2\n');
    expect(fs.statSync(path.join(run.inputsDir, 'data.csv')).mode & 0o777).toBe(0o444);
    expect(() => prepareRun({ runsRoot, runId: run.id })).toThrow(/EEXIST|exists/); // never reused
    removeRun(run);
    expect(fs.existsSync(run.dir)).toBe(false);
  });

  test('TST-026B: symlinked, hard-linked, traversing or absolute inputs are refused and leave nothing', () => {
    const src = fs.mkdtempSync(path.join(base, 'src-'));
    fs.symlinkSync(path.join(outside, '.claude', '.credentials.json'), path.join(src, 'link.json'));
    fs.linkSync(path.join(outside, 'sentinel.json'), path.join(src, 'hard.json'));
    const count = () => (fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot).length : 0);
    const before = count();
    for (const [rel, why] of [['link.json', /symlink/], ['hard.json', /hard link/], ['../x', /relative without/], ['/etc/passwd', /relative without/]] as const) {
      expect(() => prepareRun({ runsRoot, runId: randomUUID(), inputs: [{ sourceRoot: src, relPath: rel }] })).toThrow(why);
    }
    expect(count()).toBe(before);
  });

  test('a runs root that is a symlink or writable by others is refused', () => {
    const loose = path.join(base, 'loose');
    fs.mkdirSync(loose);
    fs.chmodSync(loose, 0o777);
    expect(() => prepareRun({ runsRoot: loose, runId: randomUUID() })).toThrow(/writable/);
    const link = path.join(base, 'linkroot');
    fs.symlinkSync(runsRoot, link);
    expect(() => prepareRun({ runsRoot: link, runId: randomUUID() })).toThrow(/real directory/);
    expect(() => prepareRun({ runsRoot, runId: '../escape' })).toThrow(/invalid run id/);
  });
});

// no conditional skip (PW-007): a host without unprivileged user namespaces fails here, visibly
describe('sandbox (unshare backend)', () => {
  test('the unshare backend is available on this host', () => {
    expect(sandboxAvailable('unshare')).toBe(true);
  });

  async function probe(extra: { network?: 'none' | 'host'; port?: number; limits?: Record<string, number>; writable?: string[] } = {}) {
    const src = fs.mkdtempSync(path.join(base, 'src-'));
    fs.writeFileSync(path.join(src, 'input.txt'), 'evidence');
    const run = prepareRun({ runsRoot, runId: randomUUID(), inputs: [{ sourceRoot: src, relPath: 'input.txt' }] });
    fs.copyFileSync(PROBE, path.join(run.cwd, 'probe.mjs'));
    const args = { cwd: run.cwd, home: run.homeDir, inputs: run.inputsDir, hostHome: os.homedir(), decoy: decoyInHome, outside, repo: path.resolve('.'), port: extra.port ?? 0, writable: extra.writable ?? [] };
    const r = await runSandboxed({
      backend: 'unshare', run, network: extra.network ?? 'none', readOnly: [NODE_ROOT], writable: extra.writable ?? [],
      env: { PATH: `${NODE_ROOT}/bin:/usr/bin:/bin`, HOME: run.homeDir, TMPDIR: '/tmp', LANG: 'C.UTF-8', SECRET_SHOULD_NOT_PASS: undefined as never },
      limits: { maxFileBytes: 1 << 20, maxProcesses: 256, cpuSeconds: 60, ...(extra.limits ?? {}) },
      program: [`${NODE_ROOT}/bin/node`, path.join(run.cwd, 'probe.mjs'), JSON.stringify(args)],
      timeoutMs: 30_000,
    });
    expect(r.stderr).toBe('');
    return { run, r, out: JSON.parse(r.stdout) as Record<string, unknown> };
  }

  test('TST-026A: the run writes only inside its folders; outside state is unchanged', async () => {
    const before = { outside: hash(outside), repo: hash(path.resolve('infra')) };
    const { run, r, out } = await probe();
    expect(r.code).toBe(0);
    expect(out).toMatchObject({ wroteCwd: true, wroteHome: true, wroteTmp: true });
    expect(fs.readFileSync(path.join(run.cwd, 'out.txt'), 'utf8')).toBe('written in the sandbox');
    expect(fs.existsSync(path.join(run.homeDir, 'home.txt'))).toBe(true);
    expect({ outside: hash(outside), repo: hash(path.resolve('infra')) }).toEqual(before);
    // the setup's own files (new root, script) are gone after the run
    expect(fs.readdirSync(run.dir).sort()).toEqual(['home', 'inputs', 'tmp', 'work']);
  });

  test('TST-026B: host HOME, outside folders, the Docker socket and the source tree are not reachable', async () => {
    const { out } = await probe();
    expect(out).toMatchObject({
      readDecoy: 'ENOENT', listHostHome: 'ENOENT', readOutsideCredentials: 'ENOENT', readOutsideSession: 'ENOENT',
      dockerSocket: 'ENOENT', runDir: 'ENOENT', writeRepo: expect.stringMatching(/ENOENT|EROFS|EACCES/),
      writeUsr: expect.stringMatching(/EROFS|EACCES/), writeInputs: expect.stringMatching(/EROFS|EACCES/),
      symlinkEscape: 'ENOENT', traversal: 'ENOENT',
    });
    expect(out.readInput).toBe('evidence');
  });

  test('only the given environment reaches the program; host processes are not visible', async () => {
    const { out } = await probe();
    expect((out.env as string[]).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR']);
    expect(out.visiblePids as number).toBeLessThan(10);
    expect(out.hostPidVisible).toBe(false);
    expect(out.capEff).toBe('0000000000000000');
    expect(out.devEntries).toEqual(['null', 'random', 'urandom', 'zero']); // no disks, consoles or sockets
  });

  test('network "none" cannot reach a host port; limits apply (file size)', async () => {
    const server = net.createServer((s) => s.end('hello'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const { out } = await probe({ port });
      expect(out.connect).toMatch(/ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EACCES/);
      expect(out.bigWrite).toMatch(/EFBIG|SIGXFSZ|limit/);
    } finally {
      server.close();
    }
  });

  test('an extra writable folder (e.g. the runtime auth profile) is writable; nothing else is', async () => {
    const profile = fs.mkdtempSync(path.join(base, 'profile-'));
    const { out } = await probe({ writable: [profile] });
    expect(out.wroteWritable).toEqual([true]);
    expect(fs.existsSync(path.join(profile, 'state.txt'))).toBe(true);
  });

  // the program runs as root of its user namespace: without dropped capabilities and a pivoted root it
  // could chroot its way back to the host tree, remount read-only folders or unmount the private /tmp
  test('the program has no capabilities and cannot leave its root (chroot escape, remount, umount)', async () => {
    const run = prepareRun({ runsRoot, runId: randomUUID() });
    const script = [
      'import os, sys, json',
      'out = {}',
      'out["capEff"] = [l.split()[1] for l in open("/proc/self/status") if l.startswith("CapEff")][0]',
      'def tryit(name, fn):',
      '    try: out[name] = fn()',
      '    except Exception as e: out[name] = type(e).__name__ + ":" + str(getattr(e, "errno", ""))',
      'def escape():',
      '    os.makedirs("jail", exist_ok=True); os.chroot("jail")',
      '    for _ in range(64): os.chdir("..")',
      '    os.chroot(".")',
      `    return os.path.exists(${JSON.stringify(decoyInHome)})`,
      'tryit("chrootEscape", escape)',
      'tryit("remountUsr", lambda: os.system("/usr/bin/mount -o remount,bind,rw /usr 2>/dev/null"))',
      'tryit("umountTmp", lambda: os.system("/usr/bin/umount -l /tmp 2>/dev/null"))',
      'tryit("oldRootVisible", lambda: any(" / / " not in l and "/.oldroot" in l or "pw026-host" in l for l in open("/proc/self/mountinfo")))',
      'print(json.dumps(out))',
    ].join('\n');
    fs.writeFileSync(path.join(run.cwd, 'escape.py'), script);
    try {
      const r = await runSandboxed({ backend: 'unshare', run, network: 'none', env: { PATH: '/usr/bin:/bin', HOME: run.homeDir }, program: [fs.realpathSync('/usr/bin/python3'), '-I', path.join(run.cwd, 'escape.py')], timeoutMs: 30_000 });
      const out = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(out.capEff).toBe('0000000000000000');
      expect(out.chrootEscape).not.toBe(true);
      expect(out.chrootEscape).toMatch(/PermissionError/);
      expect(out.remountUsr).not.toBe(0);
      expect(out.umountTmp).not.toBe(0);
      expect(out.oldRootVisible).toBe(false);
    } finally {
      removeRun(run);
    }
  });

  test('verifyOuterSandbox produces the evidence Codex admission needs', async () => {
    const v = await verifyOuterSandbox({ backend: 'unshare', runsRoot, nodeRoot: NODE_ROOT });
    expect(v).toMatchObject({ kind: 'userns', verified: true, host: os.hostname() });
    expect(Date.now() - Date.parse(v.checked_at)).toBeLessThan(60_000);
  });
});

describe('bubblewrap backend (argv only; bwrap is not installed here)', () => {
  test('the argv binds the system read-only, the run read-write, and clears the environment', () => {
    const run = { dir: '/r/run1', cwd: '/r/run1/work', homeDir: '/r/run1/home', tmpDir: '/r/run1/tmp', inputsDir: '/r/run1/inputs' };
    const a = bwrapArgs({ run, network: 'host', readOnly: ['/opt/node22'], writable: ['/p/profile'], env: { PATH: '/usr/bin', HOME: run.homeDir }, program: ['/opt/node22/bin/node', 'x.mjs'] });
    const s = a.join(' ');
    expect(s).toContain('--unshare-user --unshare-pid --unshare-ipc --unshare-uts --die-with-parent --new-session');
    expect(s).toContain('--ro-bind /usr /usr');
    expect(s).toContain('--bind /r/run1 /r/run1');
    expect(s).toContain('--ro-bind /r/run1/inputs /r/run1/inputs');
    expect(s).toContain('--bind /p/profile /p/profile');
    expect(s).toContain('--clearenv');
    expect(s).toContain('--chdir /r/run1/work');
    expect(a).not.toContain('--unshare-net');
    expect(bwrapArgs({ run, network: 'none', env: {}, program: ['x'] })).toContain('--unshare-net');
    expect(a.slice(-3)).toEqual(['--', '/opt/node22/bin/node', 'x.mjs']);
    expect(s).not.toMatch(/docker\.sock|--(ro-)?bind \/ |--bind \/root|--bind \/home /);
    expect(s).toContain('--tmpfs /tmp --bind /r/run1 /r/run1'); // /tmp first: a run below /tmp stays visible
  });
});
