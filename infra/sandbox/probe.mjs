#!/usr/bin/env node
/* global process, setTimeout, Buffer */
// Runs INSIDE the sandbox (PW-026). Reports what this process can reach, as JSON on stdout.
// Used by the PW-026 tests and by verifyOuterSandbox(). It only reads, writes inside its own run
// folders and tries (expected to fail) to reach outside paths and a host port.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const a = JSON.parse(process.argv[2]);
const code = (fn) => { try { const v = fn(); return v === undefined ? 'OK' : v; } catch (e) { return e.code ?? String(e.message); } };
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
out.capEff = fs.readFileSync('/proc/self/status', 'utf8').match(/^CapEff:\s*(\S+)/m)?.[1];
out.devEntries = fs.readdirSync('/dev').sort();
out.visiblePids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).length;
out.hostPidVisible = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).some((p) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes('vitest'); } catch { return false; } });
out.bigWrite = code(() => { fs.writeFileSync(path.join(a.cwd, 'big.bin'), Buffer.alloc(2 << 20)); });
const finish = () => { process.stdout.write(JSON.stringify(out)); process.exit(0); };
if (a.port) {
  const s = net.connect(a.port, '127.0.0.1');
  s.on('connect', () => { out.connect = 'CONNECTED'; s.destroy(); finish(); });
  s.on('error', (e) => { out.connect = e.code; finish(); });
  setTimeout(() => { out.connect = 'TIMEOUT'; finish(); }, 3000);
} else finish();
