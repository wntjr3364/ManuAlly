#!/usr/bin/env node
/* global process */
// Runs INSIDE the sandbox before the provider program (PW-026 review MAJOR). The sandbox's network
// namespace has only loopback; this listens on 127.0.0.1:<port> there and relays every connection to
// the host egress proxy's Unix socket file. The program gets HTTPS_PROXY pointing here. Then it starts
// the program with inherited stdio and exits with its status.
// Usage: forwarder.mjs <unix socket> <port> -- <program> [args...]
import net from 'node:net';
import { spawn } from 'node:child_process';

const [sock, portText, sep, ...program] = process.argv.slice(2);
if (!sock || sep !== '--' || !program.length) { process.stderr.write('forwarder: bad arguments\n'); process.exit(64); }
const server = net.createServer((c) => {
  const up = net.connect(sock);
  c.pipe(up);
  up.pipe(c);
  c.on('error', () => up.destroy());
  up.on('error', () => c.destroy());
});
server.on('error', (e) => { process.stderr.write(`forwarder: ${e.message}\n`); process.exit(70); });
server.listen(Number(portText), '127.0.0.1', () => {
  const child = spawn(program[0], program.slice(1), { stdio: 'inherit' });
  child.on('error', (e) => { process.stderr.write(`forwarder: ${e.message}\n`); process.exit(127); });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
});
