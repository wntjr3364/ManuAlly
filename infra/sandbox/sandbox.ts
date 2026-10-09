// Linux sandbox for provider processes (PW-026; spec 07 "실제 격리", RFC-004). No sudo needed.
// The program sees a fresh root built from read-only system folders (/usr, /etc certificates, the
// Node/CLI install it needs), its own run folder read-write (inputs read-only), optional extra
// writable folders (the runtime auth profile), a private /proc, a minimal /dev, a private size-limited
// tmpfs as /tmp (the run folder may itself live below /tmp; it is bound after) and a one-user
// /etc/passwd. The host HOME, other users' files, the source tree, /run (Docker socket) and everything
// else simply do not exist inside. The environment is exactly the given whitelist, and prlimit caps
// CPU time, memory, processes and file size.
// Network: always a private network namespace, so host loopback services and abstract Unix sockets
// (X11, D-Bus …) are unreachable (review MAJOR). "none" has no way out; "proxy" adds one: a forwarder
// inside listens on 127.0.0.1:3128 and relays to the host egress proxy (egress-proxy.ts) through a
// Unix socket file in the run folder, and the program gets HTTPS_PROXY. Only allowlisted hosts pass.
// Backends: bubblewrap (preferred where installed, ≥ 0.8) or util-linux unshare in an unprivileged
// user namespace. There the setup runs as the namespace root (mapped to the runtime user); the root is
// then pivoted (the host tree is unmounted, so a chroot cannot climb back to it) and every capability
// is dropped with no_new_privs before the program starts, so it cannot remount, unmount or open a
// nested user namespace.
// Not a guarantee against kernel exploits; see the PW-026 report for the remaining risks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { startEgressProxy } from './egress-proxy.ts';

export type Backend = 'bwrap' | 'unshare';
export type Network = 'none' | 'proxy';
export interface SandboxRun { dir: string; cwd: string; homeDir: string; tmpDir: string; inputsDir?: string }
export interface Limits { cpuSeconds?: number; memoryBytes?: number; maxProcesses?: number; maxFileBytes?: number }
export interface SandboxSpec {
  run: SandboxRun; network: Network;
  // network "proxy": the egress proxy's socket file (inside the run folder) and the node binary that
  // runs the forwarder (its install folder must be among the read-only paths)
  proxy?: { socket: string; node: string };
  readOnly?: string[]; writable?: string[];
  env: Record<string, string>; limits?: Limits; program: string[];
}
export const PROXY_PORT = 3128;
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];

// system folders the program may read (only those that exist; symlinks are recreated, not followed).
// No /etc/resolv.conf: names are resolved by the host egress proxy.
const SYSTEM_RO = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/etc/ssl', '/etc/ca-certificates', '/etc/pki', '/etc/hosts', '/etc/nsswitch.conf', '/etc/localtime'];
const DEVICES = ['null', 'zero', 'random', 'urandom'];
// below a home directory: developer CLI state and credentials are never mounted (review MINOR-3)
const HOME_DENY = ['.claude', '.claude.json', '.codex', '.config/claude', '.ssh', '.gnupg', '.aws', '.azure', '.config/gcloud', '.docker', '.kube', '.netrc', '.git-credentials', '.pki', '.password-store', '.local/share/keyrings'];

const refuse = (m: string): never => { throw new Error(`refused: ${m}`); };
const sq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');
const realOr = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
function absPaths(list: string[] | undefined, what: string, homes = [os.homedir()]): string[] {
  return (list ?? []).map((p) => {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.split('/').includes('..')) refuse(`${what} ${p} must be an absolute path without '..'`);
    const r = path.resolve(p);
    for (const c of new Set([r, realOr(r)])) {
      if (c === '/' || ['/root', '/home', '/etc'].includes(c) || ['/run', '/var/run', '/proc', '/sys', '/dev'].some((x) => within(c, x))) refuse(`${what} ${p} may not be exposed`);
      for (const h of homes.flatMap((x) => [path.resolve(x), realOr(x)])) {
        if (within(h, c)) refuse(`${what} ${p} is or contains the home directory ${h}`);
        for (const d of HOME_DENY) if (within(c, path.join(h, d)) || within(path.join(h, d), c)) refuse(`${what} ${p} would expose ${path.join(h, d)}`);
      }
    }
    return r;
  });
}
// a writable folder must be the runtime user's own and private: never the host /tmp (it would hide the
// private one and show other runs' folders) or a folder others can write (re-review nit)
function writablePaths(list: string[] | undefined): string[] {
  return absPaths(list, 'writable path').map((w) => {
    if (['/tmp', '/var/tmp', os.tmpdir()].map(realOr).includes(realOr(w))) refuse(`writable path ${w} is a shared temporary folder`);
    const st = fs.lstatSync(w, { throwIfNoEntry: false });
    if (st && (st.isSymbolicLink() || !st.isDirectory() || st.mode & 0o022 || (process.getuid && st.uid !== process.getuid()))) refuse(`writable path ${w} must be a private directory of the runtime user`);
    return w;
  });
}
const exists = (p: string) => fs.existsSync(p) || !!fs.lstatSync(p, { throwIfNoEntry: false });

const BRING_LO_UP = [
  'import socket, fcntl, struct',
  's = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)',
  "f = struct.unpack('16sH14s', fcntl.ioctl(s.fileno(), 0x8913, struct.pack('16sH14s', b'lo', 0, b'')))[1]",
  "fcntl.ioctl(s.fileno(), 0x8914, struct.pack('16sH14s', b'lo', f | 1, b''))",
].join('\n');

export function bwrapVersionOk(text: string): boolean {
  const m = /bubblewrap (\d+)\.(\d+)/.exec(text);
  return !!m && (Number(m[1]) > 0 || Number(m[2]) >= 8); // --disable-userns arrived in 0.8.0
}

export function sandboxAvailable(backend: Backend, opts: { network?: Network } = {}): boolean {
  if (process.platform !== 'linux') return false;
  if (backend === 'bwrap') {
    const r = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
    return r.status === 0 && bwrapVersionOk(r.stdout) && spawnSync('prlimit', ['--version'], { stdio: 'ignore' }).status === 0;
  }
  const ok = spawnSync('unshare', ['--user', '--map-root-user', '--mount', '--pid', '--net', '--fork', 'true'], { stdio: 'ignore' }).status === 0
    && ['/usr/bin/prlimit', '/usr/bin/setpriv', '/usr/bin/env'].every((p) => fs.existsSync(p));
  // "proxy" brings up loopback inside the namespace without `ip`: needs python3 for one ioctl
  return ok && (opts.network !== 'proxy' || spawnSync('/usr/bin/python3', ['-I', '-c', 'import fcntl'], { stdio: 'ignore' }).status === 0);
}

function limitArgs(l: Limits | undefined): string[] {
  const out: string[] = [];
  const n = (v: unknown, name: string) => { if (v !== undefined && !(Number.isInteger(v) && (v as number) > 0)) refuse(`limit ${name} must be a positive integer`); return v as number | undefined; };
  if (n(l?.cpuSeconds, 'cpuSeconds')) out.push(`--cpu=${l!.cpuSeconds}`);
  if (n(l?.memoryBytes, 'memoryBytes')) out.push(`--as=${l!.memoryBytes}`);
  if (n(l?.maxProcesses, 'maxProcesses')) out.push(`--nproc=${l!.maxProcesses}`);
  if (n(l?.maxFileBytes, 'maxFileBytes')) out.push(`--fsize=${l!.maxFileBytes}`);
  return out;
}
function checkEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) refuse(`environment name ${k} is not allowed`);
    if (PROXY_ENV.includes(k)) refuse(`${k} is set by the sandbox`);
    out[k] = v;
  }
  return out;
}

// What the sandbox prepares next to the run: helper files, all read-only inside.
interface Setup { dir: string; passwd: string; group: string; forwarder: string | null }
function writeSetup(run: SandboxRun, uid: number, gid: number, withForwarder: boolean): Setup {
  const dir = path.join(run.dir, `.pw-setup-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const passwd = path.join(dir, 'passwd');
  const group = path.join(dir, 'group');
  // one user, so programs that look up the current user work (review MINOR-5)
  fs.writeFileSync(passwd, `pw:x:${uid}:${gid}:paper workspace run:${run.homeDir}:/usr/sbin/nologin\n`, { mode: 0o444 });
  fs.writeFileSync(group, `pw:x:${gid}:\n`, { mode: 0o444 });
  let forwarder: string | null = null;
  if (withForwarder) {
    forwarder = path.join(dir, 'forwarder.mjs');
    fs.copyFileSync(new URL('./forwarder.mjs', import.meta.url), forwarder);
    fs.chmodSync(forwarder, 0o444);
  }
  return { dir, passwd, group, forwarder };
}

// the program as it starts inside: limits, then (for "proxy") the forwarder, then the program
function innerProgram(s: SandboxSpec, setup: Setup): string[] {
  const limits = limitArgs(s.limits);
  const fwd = s.network === 'proxy' ? [s.proxy!.node, setup.forwarder!, s.proxy!.socket, String(PROXY_PORT), '--'] : [];
  return [...(limits.length ? ['/usr/bin/prlimit', ...limits, '--'] : []), ...fwd, ...s.program];
}
function innerEnv(s: SandboxSpec): Record<string, string> {
  const env = checkEnv(s.env);
  if (s.network === 'proxy') {
    const url = `http://127.0.0.1:${PROXY_PORT}`;
    Object.assign(env, { HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url, ALL_PROXY: url });
  }
  return env;
}

export function bwrapArgs(s: Omit<SandboxSpec, 'limits'>, setup?: Pick<Setup, 'passwd' | 'group' | 'dir'>): string[] {
  const ro = [...SYSTEM_RO.filter(exists), ...absPaths(s.readOnly, 'read-only path')];
  // bwrap drops capabilities when unprivileged; said explicitly anyway (review MINOR-4)
  const a = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net', '--unshare-cgroup-try', '--disable-userns', '--cap-drop', 'ALL', '--die-with-parent', '--new-session'];
  for (const p of ro) {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) a.push('--symlink', fs.readlinkSync(p), p);
    else a.push('--ro-bind', p, p);
  }
  a.push('--tmpfs', '/tmp', '--bind', s.run.dir, s.run.dir);
  if (s.run.inputsDir) a.push('--ro-bind', s.run.inputsDir, s.run.inputsDir);
  if (setup) a.push('--ro-bind', setup.dir, setup.dir, '--ro-bind', setup.passwd, '/etc/passwd', '--ro-bind', setup.group, '/etc/group');
  for (const w of writablePaths(s.writable)) a.push('--bind', w, w);
  // the four devices only, not bwrap's --dev (tty, ptmx, pts, shm …; review MINOR-2)
  a.push('--proc', '/proc', '--dir', '/dev');
  for (const d of DEVICES) a.push('--dev-bind', `/dev/${d}`, `/dev/${d}`);
  a.push('--chdir', s.run.cwd, '--clearenv');
  for (const [k, v] of Object.entries(s.env)) if (typeof v === 'string') a.push('--setenv', k, v);
  return [...a, '--', ...s.program];
}

// the script the unshare backend runs as the namespace's root before dropping into the new root
function unshareScript(s: SandboxSpec, setup: Setup, newRoot: string): string {
  const lines = ['set -eu', `NR=${sq(newRoot)}`, 'mount -t tmpfs -o mode=0755 none "$NR"'];
  const bindRo = (p: string, at = p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { lines.push(`mkdir -p "$NR"${sq(path.dirname(at))}`, `ln -s ${sq(fs.readlinkSync(p))} "$NR"${sq(at)}`); return; }
    lines.push(st.isDirectory() ? `mkdir -p "$NR"${sq(at)}` : `mkdir -p "$NR"${sq(path.dirname(at))}; touch "$NR"${sq(at)}`);
    lines.push(`mount --rbind ${sq(p)} "$NR"${sq(at)}`, `mount -o remount,bind,ro "$NR"${sq(at)}`);
  };
  for (const p of [...SYSTEM_RO.filter(exists), ...absPaths(s.readOnly, 'read-only path')]) bindRo(p);
  bindRo(setup.passwd, '/etc/passwd');
  bindRo(setup.group, '/etc/group');
  lines.push('mkdir -p "$NR/tmp"', 'mount -t tmpfs -o mode=1777,size=67108864 none "$NR/tmp"');
  lines.push(`mkdir -p "$NR"${sq(s.run.dir)}`, `mount --bind ${sq(s.run.dir)} "$NR"${sq(s.run.dir)}`);
  if (s.run.inputsDir) lines.push(`mount --bind ${sq(s.run.inputsDir)} "$NR"${sq(s.run.inputsDir)}`, `mount -o remount,bind,ro "$NR"${sq(s.run.inputsDir)}`);
  lines.push(`mount --bind ${sq(setup.dir)} "$NR"${sq(setup.dir)}`, `mount -o remount,bind,ro "$NR"${sq(setup.dir)}`);
  for (const w of writablePaths(s.writable)) lines.push(`mkdir -p "$NR"${sq(w)}`, `mount --bind ${sq(w)} "$NR"${sq(w)}`);
  lines.push('mkdir -p "$NR/proc" "$NR/dev"', 'mount -t proc proc "$NR/proc"');
  for (const d of DEVICES) lines.push(`touch "$NR/dev/${d}"`, `mount --bind /dev/${d} "$NR/dev/${d}"`);
  if (s.network === 'proxy') lines.push(`/usr/bin/python3 -I -c ${sq(BRING_LO_UP)}`);
  // pivot into the new root and detach the old one: nothing of the host tree stays reachable
  lines.push('mkdir "$NR/.oldroot"', 'cd "$NR"', 'pivot_root . .oldroot', 'cd /', '/usr/bin/umount -l /.oldroot', 'rmdir /.oldroot');
  const env = Object.entries(innerEnv(s)).map(([k, v]) => `${k}=${v}`);
  const prog = [
    '/usr/bin/setpriv', '--inh-caps=-all', '--ambient-caps=-all', '--bounding-set=-all', '--no-new-privs', '--',
    '/usr/bin/env', '-i', '-C', s.run.cwd, ...env, ...innerProgram(s, setup),
  ];
  lines.push(`exec ${prog.map(sq).join(' ')}`);
  return lines.join('\n') + '\n';
}

export interface SandboxResult { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }

export async function runSandboxed(s: SandboxSpec & { backend: Backend; timeoutMs?: number; stdin?: string }): Promise<SandboxResult> {
  if ((s.network as string) !== 'none' && s.network !== 'proxy') refuse('network must be "none" or "proxy" (the host network exposes loopback services and abstract sockets)');
  for (const d of [s.run.dir, s.run.cwd, s.run.homeDir, s.run.tmpDir]) if (!path.isAbsolute(d) || !fs.statSync(d, { throwIfNoEntry: false })?.isDirectory()) refuse(`run folder ${d} is missing`);
  // the run folder is used by its real path; a symlinked run folder is refused (review nit)
  if (fs.realpathSync(s.run.dir) !== path.resolve(s.run.dir)) refuse(`run folder ${s.run.dir} must not be or lie below a symlink`);
  if (!s.program.length || !path.isAbsolute(s.program[0]!)) refuse('the program must be an absolute path');
  if (s.network === 'proxy') {
    if (!s.proxy || !path.isAbsolute(s.proxy.node) || !within(path.resolve(s.proxy.socket), path.resolve(s.run.dir))) refuse('network "proxy" needs the egress socket inside the run folder and an absolute node path');
    if (!fs.lstatSync(s.proxy!.socket, { throwIfNoEntry: false })?.isSocket()) refuse(`the egress proxy socket ${s.proxy!.socket} is not listening`);
  }
  innerEnv(s); // refuse a bad environment before anything is created
  const uid = s.backend === 'bwrap' ? (process.getuid?.() ?? 0) : 0;
  const gid = s.backend === 'bwrap' ? (process.getgid?.() ?? 0) : 0;
  const setup = writeSetup(s.run, uid, gid, s.network === 'proxy');
  let cmd: string;
  let args: string[];
  try {
    if (s.backend === 'bwrap') {
      cmd = 'bwrap';
      args = bwrapArgs({ ...s, env: innerEnv(s), program: innerProgram(s, setup) }, setup);
    } else {
      const newRoot = path.join(setup.dir, 'root');
      fs.mkdirSync(newRoot, { mode: 0o700 });
      const script = path.join(setup.dir, 'setup.sh');
      fs.writeFileSync(script, unshareScript(s, setup, newRoot), { mode: 0o500 });
      cmd = 'unshare';
      args = ['--user', '--map-root-user', '--mount', '--pid', '--net', '--fork', '--kill-child', '--propagation', 'private', '/bin/sh', script];
    }
  } catch (e) {
    fs.rmSync(setup.dir, { recursive: true, force: true });
    throw e;
  }
  const child = spawn(cmd, args, { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, cwd: s.run.dir, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-20_000); });
  child.stdin.on('error', () => {});
  child.stdin.end(s.stdin ?? '');
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } }, s.timeoutMs ?? 60_000);
  const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>((r) => child.on('close', (c, sg) => r({ code: c, signal: sg })));
  clearTimeout(t);
  fs.rmSync(setup.dir, { recursive: true, force: true });
  return { code, signal, stdout, stderr, timedOut };
}

// Judges a probe report (probe.mjs). Every reach, write and escape check counts (review MINOR-1).
export function probeFailures(out: Record<string, unknown>, expectedEnv: string[]): string[] {
  const f: string[] = [];
  for (const k of ['readDecoy', 'listHostHome', 'readOutsideCredentials', 'readOutsideSession', 'dockerSocket', 'runDir', 'symlinkEscape', 'traversal']) if (out[k] !== 'ENOENT') f.push(k);
  for (const k of ['writeRepo', 'writeUsr', 'writeInputs']) if (!/^(ENOENT|EROFS|EACCES|EPERM)$/.test(String(out[k]))) f.push(k);
  if (out.hostPidVisible !== false) f.push('hostPidVisible');
  if (out.capEff !== '0000000000000000') f.push('capabilities');
  if (out.noNewPrivs !== '1') f.push('noNewPrivs');
  if (JSON.stringify(out.devEntries) !== JSON.stringify([...DEVICES].sort())) f.push('devEntries');
  if (out.oldRootVisible !== false) f.push('oldRootVisible');
  for (const k of ['nestedUserns', 'remountUsr', 'umountTmp']) if (out[k] === 0 || out[k] === undefined) f.push(k);
  for (const k of ['abstractSocket', 'hostTcp']) if (out[k] === 'CONNECTED' || out[k] === undefined) f.push(k);
  if (out.proxyRefused !== 403) f.push('proxyRefused');
  if (JSON.stringify([...((out.env as string[] | undefined) ?? [])].sort()) !== JSON.stringify([...expectedEnv].sort())) f.push('env');
  return f;
}

// Probes the sandbox on this host (no model call): the evidence a Codex admission needs. Everything
// it touches outside the sandbox is a decoy it creates; the real source tree is never a target.
export async function verifyOuterSandbox(a: { backend: Backend; runsRoot: string; nodeRoot: string }): Promise<{ kind: 'bubblewrap' | 'userns'; verified: boolean; host: string; checked_at: string; failures: string[] }> {
  const { prepareRun, removeRun } = await import('../../apps/worker/src/runner/run-dirs.ts');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-sandbox-probe-'));
  const decoy = path.join(outside, 'secret.txt');
  const repo = path.join(outside, 'repo');
  fs.writeFileSync(decoy, 'x', { mode: 0o600 });
  fs.mkdirSync(path.join(outside, '.claude', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(outside, '.claude', '.credentials.json'), '{}');
  fs.writeFileSync(path.join(outside, '.claude', 'projects', 'session.jsonl'), '{}\n');
  fs.mkdirSync(repo);
  const abstract = `pw-probe-${randomUUID()}`;
  const hostSock = net.createServer((c) => c.end('host')).listen(`\0${abstract}`);
  const hostTcp = net.createServer((c) => c.end('host'));
  await new Promise<void>((r) => hostTcp.listen(0, '127.0.0.1', () => r()));
  const run = prepareRun({ runsRoot: a.runsRoot, runId: randomUUID() });
  const egress = await startEgressProxy({ socketPath: path.join(run.dir, 'egress.sock'), allow: [] });
  const failures: string[] = [];
  try {
    fs.chmodSync(run.inputsDir, 0o700);
    fs.writeFileSync(path.join(run.inputsDir, 'input.txt'), 'evidence', { mode: 0o444 });
    fs.chmodSync(run.inputsDir, 0o555);
    fs.copyFileSync(new URL('./probe.mjs', import.meta.url), path.join(run.cwd, 'probe.mjs'));
    const node = path.join(a.nodeRoot, 'bin', 'node');
    const args = { cwd: run.cwd, home: run.homeDir, inputs: run.inputsDir, hostHome: os.homedir(), decoy, outside, repo, writable: [], abstract, tcpPort: (hostTcp.address() as net.AddressInfo).port, proxyTarget: 'example.org:443' };
    const env = { PATH: '/usr/bin:/bin', HOME: run.homeDir, TMPDIR: '/tmp' };
    const r = await runSandboxed({ backend: a.backend, run, network: 'proxy', proxy: { socket: egress.socketPath, node }, readOnly: [a.nodeRoot], env, limits: { maxFileBytes: 1 << 20 }, program: [node, path.join(run.cwd, 'probe.mjs'), JSON.stringify(args)], timeoutMs: 30_000 });
    let out: Record<string, unknown> = {};
    try { out = JSON.parse(r.stdout); } catch { failures.push('probe did not run'); }
    if (!failures.length) failures.push(...probeFailures(out, [...Object.keys(env), 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY']));
    if (fs.readdirSync(repo).length) failures.push('decoy repo written');
  } finally {
    await egress.close();
    removeRun(run);
    hostSock.close();
    hostTcp.close();
    fs.rmSync(outside, { recursive: true, force: true });
  }
  return { kind: a.backend === 'bwrap' ? 'bubblewrap' : 'userns', verified: failures.length === 0, host: os.hostname(), checked_at: new Date().toISOString(), failures };
}
