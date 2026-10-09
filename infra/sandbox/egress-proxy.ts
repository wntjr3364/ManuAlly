// Host-side egress proxy for sandboxed provider runs (PW-026 review MAJOR). The sandbox has its own
// network namespace: no host loopback services, no abstract Unix sockets (X11, D-Bus), no route out.
// Its only exit is this proxy, reached through a Unix socket FILE inside the run folder (file sockets
// cross network namespaces, abstract ones do not). The proxy accepts only HTTP CONNECT to an allowlisted
// host:port and refuses targets that resolve to loopback, private or link-local addresses (unless a
// test explicitly allows them), so an allowed name cannot be pointed back at the host.
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import dns from 'node:dns/promises';

export interface EgressTarget { host: string; port: number }
export interface EgressProxy { socketPath: string; log: { target: string; allowed: boolean; reason?: string }[]; close(): Promise<void> }

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
export function isPrivateAddress(a: string): boolean {
  if (net.isIPv4(a)) return PRIVATE_V4.some((r) => r.test(a));
  const v = a.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

function parseTarget(s: string | undefined): EgressTarget | null {
  const m = /^([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]+\]):(\d{1,5})$/.exec(s ?? '');
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1]!.replace(/^\[|\]$/g, '').toLowerCase(), port } : null;
}

export async function startEgressProxy(a: { socketPath: string; allow: EgressTarget[]; allowPrivate?: boolean; connectTimeoutMs?: number }): Promise<EgressProxy> {
  const allow = new Set(a.allow.map((t) => `${t.host.toLowerCase()}:${t.port}`));
  const log: EgressProxy['log'] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    log.push({ target: String(req.url).slice(0, 200), allowed: false, reason: 'only CONNECT is proxied' });
    res.writeHead(403).end();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('connect', (req, client: net.Socket) => {
    const deny = (reason: string, status = '403 Forbidden') => {
      log.push({ target: String(req.url).slice(0, 200), allowed: false, reason });
      client.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\n\r\n`);
    };
    const t = parseTarget(req.url);
    if (!t) return deny('malformed target');
    if (!allow.has(`${t.host}:${t.port}`)) return deny('target is not allowlisted');
    void (async () => {
      let addrs: string[];
      try {
        addrs = net.isIP(t.host) ? [t.host] : (await dns.lookup(t.host, { all: true })).map((x) => x.address);
      } catch {
        return deny('name does not resolve', '502 Bad Gateway');
      }
      if (!a.allowPrivate && addrs.some(isPrivateAddress)) return deny('target resolves to a private or loopback address');
      const up = net.connect({ host: addrs[0]!, port: t.port, timeout: a.connectTimeoutMs ?? 15_000 });
      sockets.add(up);
      up.on('close', () => sockets.delete(up));
      up.once('connect', () => {
        up.setTimeout(0);
        log.push({ target: `${t.host}:${t.port}`, allowed: true });
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.pipe(client);
        client.pipe(up);
      });
      up.once('timeout', () => up.destroy(new Error('timeout')));
      up.once('error', () => { if (!client.destroyed) deny('upstream connection failed', '502 Bad Gateway'); });
      client.on('error', () => up.destroy());
    })();
  });
  if (fs.existsSync(a.socketPath)) throw new Error(`refused: ${a.socketPath} already exists`);
  await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(a.socketPath, () => res()); });
  fs.chmodSync(a.socketPath, 0o600);
  return {
    socketPath: a.socketPath,
    log,
    close: () => new Promise<void>((res) => {
      for (const s of sockets) s.destroy();
      server.close(() => { fs.rmSync(a.socketPath, { force: true }); res(); });
    }),
  };
}
