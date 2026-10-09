#!/usr/bin/env node
/* global process, setTimeout, clearTimeout */
// MCP stdio server for Claude Code (PW-027): the run's --mcp-config names this script with the tool
// gateway's socket path. It speaks MCP (newline-delimited JSON-RPC 2.0 on stdin/stdout: initialize,
// tools/list, tools/call, ping) and forwards tools/list and tools/call to the gateway socket, which
// holds the run token and decides everything. Nothing else (resources, prompts, sampling) is offered.
// The MCP message shapes follow the published specification; the Claude CLI's use of them is
// verified in the live smoke (PW-030), not here.
// Usage: mcp-bridge.mjs <gateway socket>
import net from 'node:net';
import readline from 'node:readline';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const sockPath = process.argv[2];
if (!sockPath) { process.stderr.write('mcp-bridge: missing socket path\n'); process.exit(64); }

const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const gw = net.connect(sockPath);
let nextId = 1;
const waiting = new Map();
let buf = '';
gw.setEncoding('utf8');
gw.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const w = waiting.get(m.id);
    if (w) { waiting.delete(m.id); w(m); }
  }
});
gw.on('error', (e) => { process.stderr.write(`mcp-bridge: gateway ${e.code ?? e.message}\n`); process.exit(69); });
gw.on('close', () => process.exit(0));
// a gateway that does not answer within a minute: the call fails visibly instead of hanging
const ask = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  const t = setTimeout(() => { waiting.delete(id); resolve({ id, error: { code: 'timeout', message: 'the tool gateway did not answer' } }); }, 60_000);
  waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
  gw.write(JSON.stringify({ id, method, params }) + '\n');
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return out({ id: null, error: { code: -32700, message: 'parse error' } }); }
  if (m.id === undefined) return; // notifications (initialized, cancelled): nothing to answer
  switch (m.method) {
    case 'initialize': {
      const want = m.params?.protocolVersion;
      return out({ id: m.id, result: { protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0], capabilities: { tools: {} }, serverInfo: { name: 'paper-workspace-tools', version: '1' } } });
    }
    case 'ping':
      return out({ id: m.id, result: {} });
    case 'tools/list': {
      const r = await ask('tools/list');
      if (!r.result) return out({ id: m.id, error: { code: -32603, message: r.error?.message ?? 'the tool gateway failed' } });
      return out({ id: m.id, result: { tools: (r.result.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) } });
    }
    case 'tools/call': {
      const r = await ask('tools/call', { name: m.params?.name, arguments: m.params?.arguments ?? {} });
      const o = r.result ?? { ok: false, error: r.error ?? { code: 'internal', message: 'no answer' } };
      return out({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(o.ok ? o.result : o.error) }], isError: !o.ok } });
    }
    default:
      return out({ id: m.id, error: { code: -32601, message: `${String(m.method).slice(0, 60)} is not offered` } });
  }
});
rl.on('close', () => gw.end());
