#!/usr/bin/env node
/* global process, setTimeout, clearTimeout, Buffer, URL */
// Runs INSIDE the sandbox (PW-026). Reports what this process can reach, as JSON on stdout.
// Used by the PW-026 tests and by verifyOuterSandbox(). It only reads, writes inside its own run
// folders and tries (expected to fail) to reach outside paths, host sockets and ports, and to escape
// (remount, unmount, nested user namespace). Every outside target is a decoy the caller created.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const a = JSON.parse(process.argv[2]);
const code = (fn) => { try { const v = fn(); return v === undefined ? 'OK' : v; } catch (e) { return e.code ?? String(e.message); } };
const status = (cmd, args) => { const r = spawnSync(cmd, args, { stdio: 'ignore' }); return r.error ? (r.error.code ?? 'error') : r.status; };
const connect = (target) => new Promise((resolve) => {
  const s = net.connect(target);
  const t = setTimeout(() => { s.destroy(); resolve('TIMEOUT'); }, 3000);
  s.on('connect', () => { clearTimeout(t); s.destroy(); resolve('CONNECTED'); });
  s.on('error', (e) => { clearTimeout(t); resolve(e.code); });
});
// HTTP CONNECT through the proxy the sandbox gives (HTTPS_PROXY): status code, or the received text
const viaProxy = (target) => new Promise((resolve) => {
  const p = process.env.HTTPS_PROXY;
  if (!p) return resolve('NO_PROXY');
  const u = new URL(p);
  const req = http.request({ host: u.hostname, port: Number(u.port), method: 'CONNECT', path: target });
  const t = setTimeout(() => { req.destroy(); resolve('TIMEOUT'); }, 5000);
  req.on('connect', (res, socket, head) => {
    if (res.statusCode !== 200) { clearTimeout(t); socket.destroy(); return resolve(res.statusCode); }
    let got = head.toString(); // bytes that arrived together with the 200
    socket.on('data', (d) => { got += d; });
    socket.on('end', () => { clearTimeout(t); resolve(got); });
    socket.on('error', (e) => { clearTimeout(t); resolve(e.code); });
  });
  req.on('error', (e) => { clearTimeout(t); resolve(e.code); });
  req.end();
});

const out = {};
fs.writeFileSync(path.join(a.cwd, 'out.txt'), 'written in the sandbox');
out.wroteCwd = fs.readFileSync(path.join(a.cwd, 'out.txt'), 'utf8') === 'written in the sandbox';
fs.writeFileSync(path.join(a.home, 'home.txt'), 'x');
out.wroteHome = true;
fs.writeFileSync('/tmp/t.txt', 'x');
out.wroteTmp = true;
out.wroteWritable = a.writable.map((w) => { fs.writeFileSync(path.join(w, 'state.txt'), 'x'); return true; });
out.readInput = code(() => fs.readFileSync(path.join(a.inputs, 'input.txt'), 'utf8'));
out.writeInputs = code(() => { fs.writeFileSync(path.join(a.inputs, 'input.txt'), 'changed'); });
out.readDecoy = code(() => fs.readFileSync(a.decoy, 'utf8'));
out.listHostHome = code(() => { fs.readdirSync(a.hostHome); });
out.readOutsideCredentials = code(() => fs.readFileSync(path.join(a.outside, '.claude', '.credentials.json'), 'utf8'));
out.readOutsideSession = code(() => fs.readFileSync(path.join(a.outside, '.claude', 'projects', 'session.jsonl'), 'utf8'));
out.dockerSocket = code(() => { fs.statSync('/var/run/docker.sock'); });
out.runDir = code(() => { fs.statSync('/run'); });
out.writeRepo = code(() => { fs.writeFileSync(path.join(a.repo, 'pw026-escape.txt'), 'x'); });
out.writeUsr = code(() => { fs.writeFileSync('/usr/pw026-escape.txt', 'x'); });
out.symlinkEscape = code(() => { fs.symlinkSync(a.decoy, path.join(a.cwd, 'link')); return fs.readFileSync(path.join(a.cwd, 'link'), 'utf8'); });
out.traversal = code(() => fs.readFileSync(path.join(a.cwd, '..', '..', '..', '..', '..', path.relative('/', a.decoy)), 'utf8'));
out.env = Object.keys(process.env);
const procStatus = fs.readFileSync('/proc/self/status', 'utf8');
out.capEff = procStatus.match(/^CapEff:\s*(\S+)/m)?.[1];
out.noNewPrivs = procStatus.match(/^NoNewPrivs:\s*(\S+)/m)?.[1];
out.devEntries = fs.readdirSync('/dev').sort();
out.passwd = code(() => fs.readFileSync('/etc/passwd', 'utf8'));
out.visiblePids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).length;
out.hostPidVisible = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).some((p) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes('vitest'); } catch { return false; } });
// escapes: the old root must be gone from the mount table; remount, unmount and a nested user
// namespace must fail (exit status; 0 means it worked)
const mountPoints = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')[4]);
out.oldRootVisible = mountPoints.some((m) => m === '/.oldroot' || m.startsWith('/.oldroot/') || m === a.hostHome || m === a.outside);
out.remountUsr = status('/usr/bin/mount', ['-o', 'remount,bind,rw', '/usr']);
out.umountTmp = status('/usr/bin/umount', ['-l', '/tmp']);
out.nestedUserns = status('/usr/bin/unshare', ['--user', '--map-root-user', '/usr/bin/true']);
out.bigWrite = code(() => { fs.writeFileSync(path.join(a.cwd, 'big.bin'), Buffer.alloc(2 << 20)); });

if (a.abstract) out.abstractSocket = await connect({ path: `\0${a.abstract}` });
if (a.tcpPort) out.hostTcp = await connect({ host: '127.0.0.1', port: a.tcpPort });
if (a.proxyTarget) out.proxyRefused = await viaProxy(a.proxyTarget);
if (a.proxyAllowed) out.proxyAllowed = await viaProxy(a.proxyAllowed);
process.stdout.write(JSON.stringify(out));
process.exit(0);
