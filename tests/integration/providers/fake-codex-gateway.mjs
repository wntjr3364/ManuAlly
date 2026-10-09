#!/usr/bin/env node
/* global process, setTimeout, clearTimeout */
// PW-030: the PW-025 stand-in, extended so the tool call it makes during a turn is read from the
// profile (`tool-call.json`: {"tool": ..., "arguments": ...}) and its answer is recorded; the token
// usage it reports grows across turns of a thread, as a cumulative counter does.
// Test stand-in for `codex app-server --listen stdio://` (JSON-RPC lines on stdin/stdout). No network.
// Implements initialize, thread/start|resume, turn/start|interrupt with documented-shaped results and
// notifications; during a turn it asks the client for a command approval (a server request) and, when
// the profile holds `ask-tool`, for a tool call. It records every client message and our answers to
// its server requests in $HOME/seen.json. Profile files are test controls (`slow` keeps a turn open,
// `die` exits in the middle of a turn, `stubborn` ignores SIGTERM and a closed stdin, `late` answers
// after 300 ms, `ignore-interrupt` never completes an interrupted turn).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

if (process.argv[2] === '--version') { process.stdout.write('codex-cli 0.161.0\n'); process.exit(0); }
const home = process.env.HOME;
const profile = process.env.CODEX_HOME;
const seen = { pid: process.pid, args: process.argv.slice(2), env: Object.keys(process.env).sort(), client: [], answers: {} };
const save = () => fs.writeFileSync(path.join(home, 'seen.json'), JSON.stringify(seen));
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const has = (f) => fs.existsSync(path.join(profile, f));
const threads = new Set();
const usageSoFar = { input: 0, output: 0 }; // cumulative per process (one thread in these tests)
const pendingFinish = new Map(); // turn id -> timer (an interrupt cancels the normal finish)
let turnNo = 0;
let serverReq = 1000;
const pending = new Map();

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  seen.client.push(m.method ?? (m.id !== undefined ? `response:${m.id}` : 'unknown'));
  save();
  if (m.method === undefined && m.id !== undefined) { // answer to one of our server requests
    seen.answers[pending.get(m.id)] = m.result ?? { error: m.error };
    save();
    return;
  }
  const reply = (result) => send({ id: m.id, result });
  switch (m.method) {
    case 'initialize': return reply({ userAgent: 'codex_cli_rs/0.161.0 (fake)' });
    case 'initialized': return;
    case 'thread/start': {
      const id = `th-${threads.size + 1}`;
      threads.add(id);
      reply({ thread: { id } });
      return send({ method: 'thread/started', params: { thread: { id } } });
    }
    case 'thread/resume':
      if (!threads.has(m.params?.threadId) && !has(`thread-${m.params?.threadId}`)) return send({ id: m.id, error: { code: -32000, message: 'thread not found' } });
      threads.add(m.params.threadId);
      return reply({ thread: { id: m.params.threadId } });
    case 'turn/start': {
      const threadId = m.params?.threadId;
      const text = m.params?.input?.[0]?.text ?? '';
      const turnId = `tu-${++turnNo}`;
      reply({ turn: { id: turnId } });
      send({ method: 'turn/started', params: { turn: { id: turnId } } });
      const id = serverReq++;
      pending.set(id, 'item/commandExecution/requestApproval');
      send({ id, method: 'item/commandExecution/requestApproval', params: { threadId, command: 'cat /etc/passwd' } });
      const id2 = serverReq++;
      pending.set(id2, 'made/up/request');
      send({ id: id2, method: 'made/up/request', params: {} });
      if (has('tool-call.json')) {
        const id3 = serverReq++;
        pending.set(id3, 'item/tool/call');
        send({ id: id3, method: 'item/tool/call', params: JSON.parse(fs.readFileSync(path.join(profile, 'tool-call.json'), 'utf8')) });
      }
      send({ method: 'item/agentMessage/delta', params: { delta: 'Echo: ' } });
      send({ method: 'item/agentMessage/delta', params: { delta: text } });
      const finish = () => {
        send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: `Echo: ${text}` } } });
        usageSoFar.input += 900; usageSoFar.output += 40;
        send({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: usageSoFar.input, outputTokens: usageSoFar.output }, modelContextWindow: 200000 } } });
        send({ method: 'fs/changed', params: {} });
        pendingFinish.delete(turnId);
        send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
      };
      if (has('die')) return setTimeout(() => process.exit(3), 20);
      if (has('slow') || has('stubborn')) return; // stays open until turn/interrupt
      // `late`: the answer takes 300 ms (time for a consumer to walk away from the turn)
      return pendingFinish.set(turnId, setTimeout(finish, has('late') ? 300 : 50));
    }
    case 'turn/interrupt':
      clearTimeout(pendingFinish.get(m.params?.turnId));
      pendingFinish.delete(m.params?.turnId);
      reply({});
      if (has('ignore-interrupt')) return; // a turn that will not stop
      return send({ method: 'turn/completed', params: { turn: { id: m.params?.turnId, status: 'interrupted' } } });
    default:
      return send({ id: m.id, error: { code: -32601, message: `fake: ${m.method} not handled` } });
  }
});
setTimeout(() => {}, 1 << 30); // stay alive until stdin closes
if (has('stubborn')) process.on('SIGTERM', () => {});
rl.on('close', () => { if (!has('stubborn')) process.exit(0); });
