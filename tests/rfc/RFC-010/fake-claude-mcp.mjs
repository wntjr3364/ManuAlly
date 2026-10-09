#!/usr/bin/env node
/* global process, setTimeout, clearTimeout */
// RFC-010 test stand-in for the Claude Code CLI, run INSIDE the sandbox. No network, no model.
// Like the real CLI it starts the MCP servers named in --mcp-config (here: the paper tool bridge) and
// talks MCP to them; it makes the tool call the profile asks for (`tool-call.json`) and reports, as
// assistant text, what the tool answered and what it could reach from inside (`PROBE {...}`): files
// outside its run, the gateway folder (read-only), the host's loopback and abstract sockets.
// CLAUDE_CONFIG_DIR is the paper's own state folder; the login is its `.credentials.json` (bound in from
// the login profile). Test controls are files the test puts in the state folder: `probe.json` (paths
// and ports to try), `grandchild` (start a detached `sleep` in a new session, named by the file's
// content, then wait), `slow` (wait before answering), `refresh` (rewrite the credential in place, as a
// token refresh would). Each turn leaves a transcript in sessions/<id>.json, as the real CLI does.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  // a version check that could read a host file was not run inside the sandbox: report a wrong version
  const probeFile = path.join(process.env.CLAUDE_CONFIG_DIR ?? '/nonexistent', 'probe.json');
  if (fs.existsSync(probeFile) && fs.existsSync(JSON.parse(fs.readFileSync(probeFile, 'utf8')).decoy)) { process.stdout.write('9.9.9 (outside the sandbox)\n'); process.exit(0); }
  process.stdout.write('2.1.294 (Claude Code)\n'); process.exit(0);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const profile = process.env.CLAUDE_CONFIG_DIR;
const has = (f) => fs.existsSync(path.join(profile, f));
const read = (f) => fs.readFileSync(path.join(profile, f), 'utf8');
const id = get('--session-id') ?? get('--resume');
const say = (text) => out({ type: 'assistant', session_id: id, message: { content: [{ type: 'text', text }], usage: { input_tokens: 30, output_tokens: 7 } } });

function mcpCall(server, calls) {
  return new Promise((resolve) => {
    const child = spawn(server.command, server.args ?? [], { stdio: ['pipe', 'pipe', 'inherit'] });
    const rl = readline.createInterface({ input: child.stdout });
    const answers = {};
    rl.on('line', (l) => {
      const m = JSON.parse(l);
      answers[m.id] = m.result ?? { error: m.error };
      if (Object.keys(answers).length === calls.length) { child.stdin.end(); resolve(answers); }
    });
    for (const [i, c] of calls.entries()) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...c }) + '\n');
      if (i === 0) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    }
  });
}
const tryFs = (fn) => { try { fn(); return 'OK'; } catch (e) { return e.code ?? String(e.message); } };
const tryConnect = (opts) => new Promise((r) => {
  const s = net.connect(opts);
  const t = setTimeout(() => { s.destroy(); r('TIMEOUT'); }, 1000);
  s.on('connect', () => { clearTimeout(t); s.destroy(); r('CONNECTED'); });
  s.on('error', (e) => { clearTimeout(t); r(e.code ?? 'ERROR'); });
});

process.stdin.resume(); // the prompt (not used by this stand-in)
process.stdin.on('end', async () => {
  if (!has('.credentials.json') || !read('.credentials.json').trim()) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in · Please run /login', session_id: id }); process.exit(1); }
  fs.mkdirSync(path.join(profile, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'sessions', `${id}.json`), JSON.stringify({ transcript: 'this paper only' }));
  if (has('refresh')) fs.writeFileSync(path.join(profile, '.credentials.json'), read('refresh'));
  out({ type: 'system', subtype: 'init', session_id: id, tools: [], mcp_servers: [], model: 'fake-model' });
  const cfg = JSON.parse(fs.readFileSync(get('--mcp-config'), 'utf8'));
  const server = cfg.mcpServers.paper;
  const calls = [{ method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } } }, { method: 'tools/list' }];
  if (has('tool-call.json')) { const t = JSON.parse(read('tool-call.json')); calls.push({ method: 'tools/call', params: { name: t.tool, arguments: t.arguments } }); }
  const answers = await mcpCall(server, calls);
  say(`TOOLS ${JSON.stringify(answers)}`);
  if (has('probe.json')) {
    const p = JSON.parse(read('probe.json'));
    const sock = server.args[1];
    const probe = {
      readDecoy: tryFs(() => fs.readFileSync(p.decoy)),
      readOtherPaperState: p.otherState ? tryFs(() => fs.readdirSync(p.otherState)) : null,
      readLoginProfileOther: p.loginExtra ? tryFs(() => fs.readFileSync(p.loginExtra)) : null,
      credentialReadable: tryFs(() => fs.readFileSync(path.join(profile, '.credentials.json'))),
      writeOutside: tryFs(() => fs.writeFileSync(path.join(p.outsideDir, 'x'), 'x')),
      listRunsRoot: (() => { try { return fs.readdirSync(p.runsRoot); } catch (e) { return e.code; } })(),
      replaceSocket: tryFs(() => fs.unlinkSync(sock)),
      // wherever the run's egress socket is (the run folder is the parent of the work folder)
      replaceEgressSocket: tryFs(() => fs.unlinkSync([path.join(path.dirname(process.cwd()), 'egress.sock'), path.join(path.dirname(sock), 'egress.sock')].find((f) => fs.existsSync(f)) ?? '/nonexistent-egress')),
      writeGatewayDir: tryFs(() => fs.writeFileSync(path.join(path.dirname(sock), 'planted'), 'x')),
      hostTcp: await tryConnect({ host: '127.0.0.1', port: p.tcpPort }),
      abstractSocket: await tryConnect({ path: `\0${p.abstract}` }),
      env: Object.keys(process.env).sort(),
      pid: process.pid,
    };
    say(`PROBE ${JSON.stringify(probe)}`);
  }
  if (has('grandchild')) {
    // a process that leaves the session and the process group: only the sandbox's end can reach it
    spawn('/usr/bin/setsid', ['/usr/bin/sleep', '600', read('grandchild').trim()], { detached: true, stdio: 'ignore' }).unref();
  }
  const delay = has('slow') ? 600_000 : 0;
  setTimeout(() => {
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 30, output_tokens: 7 }, session_id: id, total_cost_usd: 0.01 });
  }, delay);
});
