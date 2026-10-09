// Linux sandbox for provider processes (PW-026; spec 07 "실제 격리", RFC-004). No sudo needed.
// The program sees a fresh root built from read-only system folders (/usr, /etc certificates and
// name resolution, the Node/CLI install it needs), its own run folder read-write (inputs read-only),
// optional extra writable folders (the runtime auth profile), a private /proc, a minimal /dev and a
// private, size-limited tmpfs as /tmp (the run folder may itself live below /tmp; it is bound after). The host HOME, other users' files, the source tree, /run (Docker socket) and
// everything else simply do not exist inside. The environment is exactly the given whitelist, and
// prlimit caps CPU time, memory, processes and file size. Network is the host's ("host", needed to
// reach the provider) or none.
// Backends: bubblewrap (preferred where installed) or util-linux unshare + chroot in an unprivileged
// user namespace. There the setup runs as the namespace root (mapped to the runtime user); the root is
// then pivoted (the host tree is unmounted, so a chroot cannot climb back to it) and every capability
// is dropped with no_new_privs before the program starts, so it cannot remount or unmount anything.
// Not a guarantee against kernel exploits; see the PW-026 report for the remaining risks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

export type Backend = 'bwrap' | 'unshare';
export interface SandboxRun { dir: string; cwd: string; homeDir: string; tmpDir: string; inputsDir?: string }
export interface Limits { cpuSeconds?: number; memoryBytes?: number; maxProcesses?: number; maxFileBytes?: number }
export interface SandboxSpec {
  run: SandboxRun; network: 'none' | 'host'; readOnly?: string[]; writable?: string[];
  env: Record<string, string>; limits?: Limits; program: string[];
}

// system folders the program may read (only those that exist; symlinks are recreated, not followed)
const SYSTEM_RO = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/etc/ssl', '/etc/ca-certificates', '/etc/pki', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/localtime'];
const DEVICES = ['null', 'zero', 'random', 'urandom'];

const refuse = (m: string): never => { throw new Error(`refused: ${m}`); };
const sq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
function absPaths(list: string[] | undefined, what: string): string[] {
  return (list ?? []).map((p) => {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.split('/').includes('..')) refuse(`${what} ${p} must be an absolute path without '..'`);
    if (p === '/' || ['/root', '/home', os.homedir(), '/run', '/var/run', '/proc', '/sys', '/dev'].includes(path.resolve(p))) refuse(`${what} ${p} may not be exposed`);
    return path.resolve(p);
  });
}
const exists = (p: string) => fs.existsSync(p) || !!fs.lstatSync(p, { throwIfNoEntry: false });

export function sandboxAvailable(backend: Backend): boolean {
  if (process.platform !== 'linux') return false;
  if (backend === 'bwrap') return spawnSync('bwrap', ['--version'], { stdio: 'ignore' }).status === 0;
  return spawnSync('unshare', ['--user', '--map-root-user', '--mount', '--pid', '--fork', 'true'], { stdio: 'ignore' }).status === 0
    && spawnSync('prlimit', ['--version'], { stdio: 'ignore' }).status === 0;
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
const envPairs = (env: Record<string, string>) => Object.entries(env).filter(([, v]) => typeof v === 'string').map(([k, v]) => {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) refuse(`environment name ${k} is not allowed`);
  return `${k}=${v}`;
});

export function bwrapArgs(s: Omit<SandboxSpec, 'limits'>): string[] {
  const ro = [...SYSTEM_RO.filter(exists), ...absPaths(s.readOnly, 'read-only path')];
  const a = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session'];
  if (s.network === 'none') a.push('--unshare-net');
  for (const p of ro) {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) a.push('--symlink', fs.readlinkSync(p), p);
    else a.push('--ro-bind', p, p);
  }
  a.push('--tmpfs', '/tmp', '--bind', s.run.dir, s.run.dir);
  if (s.run.inputsDir) a.push('--ro-bind', s.run.inputsDir, s.run.inputsDir);
  for (const w of absPaths(s.writable, 'writable path')) a.push('--bind', w, w);
  a.push('--proc', '/proc', '--dev', '/dev', '--chdir', s.run.cwd, '--clearenv');
  for (const [k, v] of Object.entries(s.env)) if (typeof v === 'string') a.push('--setenv', k, v);
  return [...a, '--', ...s.program];
}

// the script the unshare backend runs as the namespace's root before dropping into the new root
function unshareScript(s: SandboxSpec, newRoot: string): string {
  const lines = ['set -eu', `NR=${sq(newRoot)}`, 'mount -t tmpfs -o mode=0755 none "$NR"'];
  const bindRo = (p: string) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { lines.push(`mkdir -p "$NR"${sq(path.dirname(p))}`, `ln -s ${sq(fs.readlinkSync(p))} "$NR"${sq(p)}`); return; }
    lines.push(st.isDirectory() ? `mkdir -p "$NR"${sq(p)}` : `mkdir -p "$NR"${sq(path.dirname(p))}; touch "$NR"${sq(p)}`);
    lines.push(`mount --rbind ${sq(p)} "$NR"${sq(p)}`, `mount -o remount,bind,ro "$NR"${sq(p)}`);
  };
  for (const p of [...SYSTEM_RO.filter(exists), ...absPaths(s.readOnly, 'read-only path')]) bindRo(p);
  lines.push('mkdir -p "$NR/tmp"', 'mount -t tmpfs -o mode=1777,size=67108864 none "$NR/tmp"');
  lines.push(`mkdir -p "$NR"${sq(s.run.dir)}`, `mount --bind ${sq(s.run.dir)} "$NR"${sq(s.run.dir)}`);
  if (s.run.inputsDir) lines.push(`mount --bind ${sq(s.run.inputsDir)} "$NR"${sq(s.run.inputsDir)}`, `mount -o remount,bind,ro "$NR"${sq(s.run.inputsDir)}`);
  for (const w of absPaths(s.writable, 'writable path')) lines.push(`mkdir -p "$NR"${sq(w)}`, `mount --bind ${sq(w)} "$NR"${sq(w)}`);
  lines.push('mkdir -p "$NR/proc" "$NR/dev"', 'mount -t proc proc "$NR/proc"');
  for (const d of DEVICES) lines.push(`touch "$NR/dev/${d}"`, `mount --bind /dev/${d} "$NR/dev/${d}"`);
  // pivot into the new root and detach the old one: nothing of the host tree stays reachable
  lines.push('mkdir "$NR/.oldroot"', 'cd "$NR"', 'pivot_root . .oldroot', 'cd /', '/usr/bin/umount -l /.oldroot', 'rmdir /.oldroot');
  const limits = limitArgs(s.limits);
  const prog = [
    '/usr/bin/setpriv', '--inh-caps=-all', '--ambient-caps=-all', '--bounding-set=-all', '--no-new-privs', '--',
    '/usr/bin/env', '-i', '-C', s.run.cwd, ...envPairs(s.env), ...(limits.length ? ['/usr/bin/prlimit', ...limits, '--'] : []), ...s.program,
  ];
  lines.push(`exec ${prog.map(sq).join(' ')}`);
  return lines.join('\n') + '\n';
}

export interface SandboxResult { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }

export async function runSandboxed(s: SandboxSpec & { backend: Backend; timeoutMs?: number; stdin?: string }): Promise<SandboxResult> {
  for (const d of [s.run.dir, s.run.cwd, s.run.homeDir, s.run.tmpDir]) if (!path.isAbsolute(d) || !fs.statSync(d, { throwIfNoEntry: false })?.isDirectory()) refuse(`run folder ${d} is missing`);
  if (!s.program.length || !path.isAbsolute(s.program[0]!)) refuse('the program must be an absolute path');
  let cmd: string;
  let args: string[];
  let newRoot: string | null = null;
  let script: string | null = null;
  if (s.backend === 'bwrap') {
    cmd = 'bwrap';
    const limits = limitArgs(s.limits);
    args = bwrapArgs({ ...s, program: limits.length ? ['/usr/bin/prlimit', ...limits, '--', ...s.program] : s.program });
  } else {
    newRoot = path.join(s.run.dir, `.root-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(newRoot, { mode: 0o700 });
    script = path.join(s.run.dir, `.sandbox-${randomUUID().slice(0, 8)}.sh`);
    fs.writeFileSync(script, unshareScript(s, newRoot), { mode: 0o500 });
    cmd = 'unshare';
    args = ['--user', '--map-root-user', '--mount', '--pid', '--fork', '--kill-child', '--propagation', 'private', ...(s.network === 'none' ? ['--net'] : []), '/bin/sh', script];
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
  if (newRoot) fs.rmSync(newRoot, { recursive: true, force: true });
  if (script) fs.rmSync(script, { force: true });
  return { code, signal, stdout, stderr, timedOut };
}

// Probes the sandbox on this host (no model call): the evidence a Codex admission needs.
export async function verifyOuterSandbox(a: { backend: Backend; runsRoot: string; nodeRoot: string }): Promise<{ kind: 'bubblewrap' | 'userns'; verified: boolean; host: string; checked_at: string; failures: string[] }> {
  const { prepareRun, removeRun } = await import('../../apps/worker/src/runner/run-dirs.ts');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-sandbox-probe-'));
  const decoy = path.join(outside, 'secret.txt');
  fs.writeFileSync(decoy, 'x', { mode: 0o600 });
  fs.mkdirSync(path.join(outside, '.claude'));
  const run = prepareRun({ runsRoot: a.runsRoot, runId: randomUUID() });
  const failures: string[] = [];
  try {
    fs.copyFileSync(new URL('./probe.mjs', import.meta.url), path.join(run.cwd, 'probe.mjs'));
    const args = { cwd: run.cwd, home: run.homeDir, inputs: run.inputsDir, hostHome: os.homedir(), decoy, outside, repo: path.resolve(new URL('../..', import.meta.url).pathname), port: 0, writable: [] };
    const r = await runSandboxed({ backend: a.backend, run, network: 'none', readOnly: [a.nodeRoot], env: { PATH: '/usr/bin:/bin', HOME: run.homeDir, TMPDIR: '/tmp' }, limits: { maxFileBytes: 1 << 20 }, program: [path.join(a.nodeRoot, 'bin', 'node'), path.join(run.cwd, 'probe.mjs'), JSON.stringify(args)], timeoutMs: 30_000 });
    let out: Record<string, unknown> = {};
    try { out = JSON.parse(r.stdout); } catch { failures.push('probe did not run'); }
    for (const k of ['readDecoy', 'listHostHome', 'readOutsideCredentials', 'dockerSocket', 'runDir', 'symlinkEscape', 'traversal']) if (out[k] !== 'ENOENT') failures.push(k);
    if (!/EROFS|EACCES/.test(String(out.writeUsr))) failures.push('writeUsr');
    if (out.hostPidVisible !== false) failures.push('hostPidVisible');
    if (out.capEff !== '0000000000000000') failures.push('capabilities');
    if (JSON.stringify(out.devEntries) !== JSON.stringify([...DEVICES].sort())) failures.push('devEntries');
  } finally {
    removeRun(run);
    fs.rmSync(outside, { recursive: true, force: true });
  }
  return { kind: a.backend === 'bwrap' ? 'bubblewrap' : 'userns', verified: failures.length === 0, host: os.hostname(), checked_at: new Date().toISOString(), failures };
}
