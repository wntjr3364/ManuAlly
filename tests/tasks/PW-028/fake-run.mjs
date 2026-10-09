#!/usr/bin/env node
/* global process, setInterval, setTimeout */
// Stand-in for a provider run (PW-028): streams a chunk every 50 ms on stdout, starts a grandchild in
// its own process group (it must die with the run), and stops when "interrupt" arrives on stdin.
// Flags: ignore-interrupt (keeps streaming), ignore-term (survives SIGTERM), pidfile=<path> (writes
// "<pid> <grandchild pid>").
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const flags = new Set(process.argv.slice(2));
const pidfile = process.argv.slice(2).find((a) => a.startsWith('pidfile='))?.slice(8);
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
// unmarked-child: a child with an empty environment (no run marker) in the same process group, which
// the leader leaves behind when it exits
const unmarked = flags.has('unmarked-child') ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: {} }) : null;
if (flags.has('unmarked-child')) fs.writeFileSync(`${pidfile}.unmarked`, String(unmarked.pid));
if (flags.has('exit-soon')) setTimeout(() => process.exit(0), 200);
if (pidfile) fs.writeFileSync(pidfile, `${process.pid} ${grandchild.pid}`);
if (flags.has('ignore-term')) process.on('SIGTERM', () => {});
let n = 0;
setInterval(() => process.stdout.write(`chunk ${n++}\n`), 50);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (d.includes('interrupt') && !flags.has('ignore-interrupt')) {
    process.stdout.write('interrupted\n');
    grandchild.kill(); // the unmarked child is left behind on purpose
    setTimeout(() => process.exit(0), 20);
  }
});
