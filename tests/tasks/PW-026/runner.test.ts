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
import { bwrapArgs, bwrapVersionOk, probeFailures, runSandboxed, sandboxAvailable, verifyOuterSandbox } from '../../../infra/sandbox/sandbox.ts';
import { isPrivateAddress, startEgressProxy } from '../../../infra/sandbox/egress-proxy.ts';

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
  fs.mkdirSync(path.join(outside, 'repo')); // a decoy source tree: a broken sandbox never writes the real one
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
  test('the unshare backend is available on this host (with the proxy network)', () => {
    expect(sandboxAvailable('unshare')).toBe(true);
    expect(sandboxAvailable('unshare', { network: 'proxy' })).toBe(true);
  });

  type Extra = { network?: 'none' | 'proxy'; tcpPort?: number; abstract?: string; proxyTarget?: string; proxyAllowed?: string; limits?: Record<string, number>; writable?: string[]; allow?: { host: string; port: number }[] };
  async function probe(extra: Extra = {}) {
    const src = fs.mkdtempSync(path.join(base, 'src-'));
    fs.writeFileSync(path.join(src, 'input.txt'), 'evidence');
    const run = prepareRun({ runsRoot, runId: randomUUID(), inputs: [{ sourceRoot: src, relPath: 'input.txt' }] });
    fs.copyFileSync(PROBE, path.join(run.cwd, 'probe.mjs'));
    const args = { cwd: run.cwd, home: run.homeDir, inputs: run.inputsDir, hostHome: os.homedir(), decoy: decoyInHome, outside, repo: path.join(outside, 'repo'), writable: extra.writable ?? [], tcpPort: extra.tcpPort, abstract: extra.abstract, proxyTarget: extra.proxyTarget, proxyAllowed: extra.proxyAllowed };
    const network = extra.network ?? 'none';
    const egress = network === 'proxy' ? await startEgressProxy({ socketPath: path.join(run.dir, 'egress.sock'), allow: extra.allow ?? [], allowPrivate: true }) : null;
    const r = await runSandboxed({
      backend: 'unshare', run, network, proxy: egress ? { socket: egress.socketPath, node: `${NODE_ROOT}/bin/node` } : undefined, readOnly: [NODE_ROOT], writable: extra.writable ?? [],
      env: { PATH: `${NODE_ROOT}/bin:/usr/bin:/bin`, HOME: run.homeDir, TMPDIR: '/tmp', LANG: 'C.UTF-8', SECRET_SHOULD_NOT_PASS: undefined as never },
      limits: { maxFileBytes: 1 << 20, maxProcesses: 256, cpuSeconds: 60, ...(extra.limits ?? {}) },
      program: [`${NODE_ROOT}/bin/node`, path.join(run.cwd, 'probe.mjs'), JSON.stringify(args)],
      timeoutMs: 30_000,
    }).finally(() => egress?.close());
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
    expect(fs.readdirSync(path.join(outside, 'repo'))).toEqual([]);
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
    expect(out.noNewPrivs).toBe('1');
    // one user with the run's home, so user lookups work (review MINOR-5)
    expect(String(out.passwd)).toMatch(/^pw:x:0:0:paper workspace run:\/.+\/home:\/usr\/sbin\/nologin\n$/);
    expect(out).toMatchObject({ oldRootVisible: false });
    for (const k of ['remountUsr', 'umountTmp', 'nestedUserns']) expect(out[k], k).not.toBe(0);
    expect(out.devEntries).toEqual(['null', 'random', 'urandom', 'zero']); // no disks, consoles or sockets
  });

  test('network "none" cannot reach a host port; limits apply (file size)', async () => {
    const server = net.createServer((s) => s.end('hello'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const { out } = await probe({ tcpPort: port });
      expect(out.hostTcp).toMatch(/ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EACCES/);
      expect(out.bigWrite).toMatch(/EFBIG|SIGXFSZ|limit/);
    } finally {
      server.close();
    }
  });

  // review MAJOR: abstract Unix sockets (X11's @/tmp/.X11-unix/X0, D-Bus …) belong to the network
  // namespace; a fresh root does not hide them, a private network namespace does
  test('host abstract sockets and loopback ports are unreachable in both network modes; the host network is refused', async () => {
    const name = `pw026-abs-${randomUUID()}`;
    const abs = net.createServer((c) => c.end('host says hi')).listen(`\0${name}`);
    const tcp = net.createServer((c) => c.end('host db'));
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
    const tcpPort = (tcp.address() as net.AddressInfo).port;
    try {
      for (const network of ['none', 'proxy'] as const) {
        const { out } = await probe({ network, abstract: name, tcpPort });
        expect(out.abstractSocket, network).toMatch(/ECONNREFUSED|ENOENT/);
        expect(out.hostTcp, network).toMatch(/ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/);
      }
      const run = prepareRun({ runsRoot, runId: randomUUID() });
      await expect(runSandboxed({ backend: 'unshare', run, network: 'host' as never, env: {}, program: ['/usr/bin/true'] })).rejects.toThrow(/network must be "none" or "proxy"/);
      removeRun(run);
    } finally {
      abs.close();
      tcp.close();
    }
  });

  test('network "proxy": only allowlisted CONNECT targets pass the host egress proxy', async () => {
    const provider = net.createServer((c) => c.end('provider answer'));
    await new Promise<void>((r) => provider.listen(0, '127.0.0.1', () => r()));
    const port = (provider.address() as net.AddressInfo).port;
    try {
      const { out } = await probe({ network: 'proxy', allow: [{ host: '127.0.0.1', port }], proxyAllowed: `127.0.0.1:${port}`, proxyTarget: 'example.org:443' });
      expect(out.proxyAllowed).toBe('provider answer');
      expect(out.proxyRefused).toBe(403);
      expect((out.env as string[]).sort()).toEqual(['ALL_PROXY', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'LANG', 'PATH', 'TMPDIR', 'http_proxy', 'https_proxy']);
    } finally {
      provider.close();
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
    expect(v).toMatchObject({ kind: 'userns', verified: true, host: os.hostname(), failures: [] });
    expect(Date.now() - Date.parse(v.checked_at)).toBeLessThan(60_000);
  });

  // review MINOR-1: every reach, write and escape result counts, not only a few reads
  test('probeFailures flags each kind of breach a broken sandbox would show', () => {
    const good = {
      readDecoy: 'ENOENT', listHostHome: 'ENOENT', readOutsideCredentials: 'ENOENT', readOutsideSession: 'ENOENT', dockerSocket: 'ENOENT', runDir: 'ENOENT', symlinkEscape: 'ENOENT', traversal: 'ENOENT',
      writeRepo: 'ENOENT', writeUsr: 'EROFS', writeInputs: 'EACCES', hostPidVisible: false, capEff: '0000000000000000', noNewPrivs: '1',
      devEntries: ['null', 'random', 'urandom', 'zero'], oldRootVisible: false, nestedUserns: 1, remountUsr: 32, umountTmp: 32,
      abstractSocket: 'ECONNREFUSED', hostTcp: 'ECONNREFUSED', proxyRefused: 403, env: ['PATH', 'HOME'],
    };
    expect(probeFailures(good, ['HOME', 'PATH'])).toEqual([]);
    const broken: [string, Record<string, unknown>][] = [
      ['writeRepo', { writeRepo: 'OK' }], ['writeInputs', { writeInputs: 'OK' }], ['readOutsideSession', { readOutsideSession: '{}' }],
      ['capabilities', { capEff: '000001ffffffffff' }], ['noNewPrivs', { noNewPrivs: '0' }], ['oldRootVisible', { oldRootVisible: true }],
      ['nestedUserns', { nestedUserns: 0 }], ['remountUsr', { remountUsr: 0 }], ['umountTmp', { umountTmp: 0 }],
      ['abstractSocket', { abstractSocket: 'CONNECTED' }], ['hostTcp', { hostTcp: 'CONNECTED' }], ['proxyRefused', { proxyRefused: 'provider answer' }],
      ['devEntries', { devEntries: ['full', 'null', 'ptmx', 'random', 'tty', 'urandom', 'zero'] }], ['env', { env: ['PATH', 'HOME', 'SECRET'] }],
    ];
    for (const [k, over] of broken) expect(probeFailures({ ...good, ...over }, ['HOME', 'PATH']), k).toEqual([k]);
  });

  test('a run folder reached through a symlink is refused (it is used by its real path)', async () => {
    const run = prepareRun({ runsRoot, runId: randomUUID() });
    const link = path.join(base, `link-${randomUUID().slice(0, 8)}`);
    fs.symlinkSync(run.dir, link);
    const via = { dir: link, cwd: path.join(link, 'work'), homeDir: path.join(link, 'home'), tmpDir: path.join(link, 'tmp') };
    await expect(runSandboxed({ backend: 'unshare', run: via, network: 'none', env: {}, program: ['/usr/bin/true'] })).rejects.toThrow(/symlink/);
    removeRun(run);
  });
});

describe('host egress proxy', () => {
  test('refuses targets outside the allowlist, plain requests, and allowed names that resolve to private addresses', async () => {
    const dir = fs.mkdtempSync(path.join(base, 'egress-'));
    const target = net.createServer((c) => c.end('reached'));
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    const port = (target.address() as net.AddressInfo).port;
    const p = await startEgressProxy({ socketPath: path.join(dir, 'e.sock'), allow: [{ host: 'localhost', port }, { host: '127.0.0.1', port }] });
    const ask = (raw: string) => new Promise<string>((resolve) => {
      const c = net.connect(p.socketPath);
      let got = '';
      c.on('data', (d) => { got += d; });
      c.on('end', () => resolve(got));
      c.on('error', () => resolve(got));
      c.write(raw);
    });
    try {
      expect(await ask(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: x\r\n\r\n`)).toMatch(/^HTTP\/1\.1 403/); // private without allowPrivate
      expect(await ask(`CONNECT localhost:${port} HTTP/1.1\r\nHost: x\r\n\r\n`)).toMatch(/^HTTP\/1\.1 403/); // a name pointing home
      expect(await ask('CONNECT example.org:443 HTTP/1.1\r\nHost: x\r\n\r\n')).toMatch(/^HTTP\/1\.1 403/); // not allowlisted
      expect(await ask('GET http://example.org/ HTTP/1.1\r\nHost: example.org\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 403/);
      expect(p.log.every((l) => !l.allowed)).toBe(true);
      expect(fs.statSync(p.socketPath).mode & 0o777).toBe(0o600);
    } finally {
      await p.close();
      target.close();
    }
    expect(fs.existsSync(path.join(dir, 'e.sock'))).toBe(false);
    for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ['93.184.216.34', '160.79.104.10', '2606:4700::1']) expect(isPrivateAddress(a), a).toBe(false);
    // re-review MINOR-2: the rest of link-local, embedded IPv4 forms, benchmark, multicast, reserved
    for (const a of ['fe90::1', 'febf::1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::1', '::127.0.0.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255', 'ff02::1', '2001::1', 'not-an-ip']) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ['64:ff9b::5db8:d822', '::ffff:93.184.216.34']) expect(isPrivateAddress(a), a).toBe(false);
  });

  test('re-review: bytes sent with the CONNECT reach the target; a socket replaced by the sandbox does not crash close()', async () => {
    const dir = fs.mkdtempSync(path.join(base, 'egress-'));
    let got = '';
    const target = net.createServer((c) => c.on('data', (d) => { got += d; c.end('ok'); }));
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    const port = (target.address() as net.AddressInfo).port;
    const p = await startEgressProxy({ socketPath: path.join(dir, 'e.sock'), allow: [{ host: '127.0.0.1', port }], allowPrivate: true });
    const reply = await new Promise<string>((resolve) => {
      const c = net.connect(p.socketPath);
      let r = '';
      c.on('data', (d) => { r += d; });
      c.on('end', () => resolve(r));
      c.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: x\r\n\r\nfirst bytes`);
    });
    expect(reply).toMatch(/200 Connection Established[\s\S]*ok$/);
    expect(got).toBe('first bytes');
    // the program inside could swap the socket file for a folder
    fs.rmSync(p.socketPath);
    fs.mkdirSync(p.socketPath);
    await expect(p.close()).resolves.toBeUndefined();
    expect(fs.statSync(p.socketPath).isDirectory()).toBe(true); // left for the run folder removal
    target.close();
  });
});

describe('bubblewrap backend (argv only; bwrap is not installed here)', () => {
  test('the argv binds the system read-only, the run read-write, and clears the environment', () => {
    const run = { dir: '/r/run1', cwd: '/r/run1/work', homeDir: '/r/run1/home', tmpDir: '/r/run1/tmp', inputsDir: '/r/run1/inputs' };
    const a = bwrapArgs({ run, network: 'proxy', readOnly: ['/opt/node22'], writable: ['/p/profile'], env: { PATH: '/usr/bin', HOME: run.homeDir }, program: ['/opt/node22/bin/node', 'x.mjs'] }, { dir: '/r/run1/.pw-setup-1', passwd: '/r/run1/.pw-setup-1/passwd', group: '/r/run1/.pw-setup-1/group' });
    const s = a.join(' ');
    // review MINOR-4: own network, cgroup and no nested user namespaces; capabilities dropped explicitly
    expect(s).toContain('--unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-net --unshare-cgroup-try --disable-userns --cap-drop ALL --die-with-parent --new-session');
    // review MINOR-2: the four devices only (bwrap's --dev would add tty, ptmx, pts, shm …)
    expect(a).not.toContain('--dev');
    expect(s).toContain('--dir /dev --dev-bind /dev/null /dev/null --dev-bind /dev/zero /dev/zero --dev-bind /dev/random /dev/random --dev-bind /dev/urandom /dev/urandom');
    expect(s).toContain('--ro-bind /r/run1/.pw-setup-1/passwd /etc/passwd');
    expect(s).toContain('--ro-bind /usr /usr');
    expect(s).toContain('--bind /r/run1 /r/run1');
    expect(s).toContain('--ro-bind /r/run1/inputs /r/run1/inputs');
    expect(s).toContain('--bind /p/profile /p/profile');
    expect(s).toContain('--clearenv');
    expect(s).toContain('--chdir /r/run1/work');
    expect(bwrapArgs({ run, network: 'none', env: {}, program: ['x'] })).toContain('--unshare-net');
    expect(a.slice(-3)).toEqual(['--', '/opt/node22/bin/node', 'x.mjs']);
    expect(s).not.toMatch(/docker\.sock|--(ro-)?bind \/ |--bind \/root|--bind \/home /);
    expect(s).toContain('--tmpfs /tmp --bind /r/run1 /r/run1'); // /tmp first: a run below /tmp stays visible
    expect(bwrapVersionOk('bubblewrap 0.11.0')).toBe(true);
    expect(bwrapVersionOk('bubblewrap 0.6.1')).toBe(false); // no --disable-userns
  });

  // review MINOR-3: the sandbox itself refuses developer state and credentials below a home directory
  test('read-only or writable paths exposing a home, developer CLI state or credentials are refused', () => {
    const run = { dir: '/r/run1', cwd: '/r/run1/work', homeDir: '/r/run1/home', tmpDir: '/r/run1/tmp' };
    const h = os.homedir();
    for (const bad of [h, path.dirname(h), `${h}/.ssh`, `${h}/.claude`, `${h}/.claude/projects`, `${h}/.codex`, `${h}/.config/gcloud`, `${h}/.aws`, `${h}/.config`, '/etc', '/run/user']) {
      for (const key of ['readOnly', 'writable'] as const) expect(() => bwrapArgs({ run, network: 'none', env: {}, program: ['x'], [key]: [bad] }), `${key} ${bad}`).toThrow(/refused/);
    }
    expect(() => bwrapArgs({ run, network: 'none', env: {}, program: ['x'], writable: [`${h}/.local/share/paper-workspace/profiles/claude`] })).not.toThrow();
    // re-review nit: never the shared /tmp, never a folder others can write
    const shared = fs.mkdtempSync(path.join(base, 'shared-'));
    fs.chmodSync(shared, 0o777);
    for (const bad of ['/tmp', '/var/tmp', os.tmpdir(), shared]) expect(() => bwrapArgs({ run, network: 'none', env: {}, program: ['x'], writable: [bad] }), bad).toThrow(/refused/);
    expect(() => bwrapArgs({ run, network: 'none', env: {}, program: ['x'], readOnly: [shared] })).not.toThrow();
  });
});
