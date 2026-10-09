// Tool gateway transport for one provider run (PW-027). The worker starts this next to the run: a Unix
// socket file (0600) inside the run folder, bound to the run token. Inside the sandbox the MCP bridge
// (mcp-bridge.mjs, for Claude) or the Codex adapter's tool callback talks to it; the token itself never
// enters the sandbox. Newline-delimited JSON: {id, method: 'tools/list' | 'tools/call', params}.
// Requests are size-limited; anything malformed is answered with an error, never executed.
import fs from 'node:fs';
import net from 'node:net';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { callTool, toolDefinitions } from '@pw/domain/tool-policy/index.ts';

export const MAX_LINE_BYTES = 256 * 1024;
export const MAX_QUEUED = 16;

export async function serveToolSocket(a: { pool: TxPool; socketPath: string; token: string; maxConnections?: number }): Promise<{ close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((c) => {
    sockets.add(c);
    c.on('close', () => sockets.delete(c));
    c.on('error', () => c.destroy());
    let buf = '';
    let chain = Promise.resolve(); // answers in request order
    let queued = 0; // requests read but not answered yet (bounded: re-review nit)
    const send = (o: unknown) => { if (!c.destroyed) c.write(JSON.stringify(o) + '\n'); };
    c.setEncoding('utf8');
    c.on('data', (d: string) => {
      buf += d;
      if (Buffer.byteLength(buf) > MAX_LINE_BYTES && !buf.includes('\n')) {
        send({ id: null, error: { code: 'too_large', message: `a request may hold at most ${MAX_LINE_BYTES} bytes` } });
        buf = '';
        c.end();
        return;
      }
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) { send({ id: null, error: { code: 'too_large', message: 'request too large' } }); c.end(); return; }
        if (++queued > MAX_QUEUED) { send({ id: null, error: { code: 'too_many_requests', message: `at most ${MAX_QUEUED} requests may wait` } }); c.end(); return; }
        chain = chain.then(() => handle(line).then(send, () => send({ id: null, error: { code: 'internal', message: 'the gateway failed' } }))).finally(() => { queued--; });
      }
    });
  });
  server.maxConnections = a.maxConnections ?? 8;

  async function handle(line: string): Promise<unknown> {
    let m: { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown } };
    try { m = JSON.parse(line); } catch { return { id: null, error: { code: 'bad_request', message: 'not JSON' } }; }
    const id = typeof m?.id === 'number' || typeof m?.id === 'string' ? m.id : null;
    if (m?.method === 'tools/list') return { id, result: { tools: await toolDefinitions(a.pool, a.token) } };
    if (m?.method === 'tools/call') return { id, result: await callTool(a.pool, a.token, m.params?.name, m.params?.arguments ?? {}) };
    return { id, error: { code: 'bad_request', message: 'unknown method' } };
  }

  if (fs.existsSync(a.socketPath)) throw new Error(`refused: ${a.socketPath} already exists`);
  await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(a.socketPath, () => res()); });
  fs.chmodSync(a.socketPath, 0o600);
  return {
    close: () => new Promise<void>((res) => {
      for (const s of sockets) s.destroy();
      server.close(() => {
        // the run folder is writable from the sandbox: remove only a socket, never throw here
        try { if (fs.lstatSync(a.socketPath, { throwIfNoEntry: false })?.isSocket()) fs.unlinkSync(a.socketPath); } catch { /* removed with the run */ }
        res();
      });
    }),
  };
}
