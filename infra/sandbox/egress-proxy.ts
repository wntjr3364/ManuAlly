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

// Not a public unicast address: private, loopback, link-local, shared, documentation, benchmark,
// multicast, reserved and broadcast ranges (IANA special-purpose registries). IPv6 forms that embed an
// IPv4 address (mapped, compatible, NAT64, 6to4) are judged by that IPv4 address; Teredo is refused.
const BLOCKED = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) BLOCKED.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['64:ff9b:1::', 48]] as const) BLOCKED.addSubnet(a, p, 'ipv6');

// the 16 bytes of an IPv6 address (with an optional dotted IPv4 tail)
function v6bytes(a: string): number[] | null {
  let s = a.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    if (!net.isIPv4(tail[1]!)) return null;
    const q = tail[1]!.split('.').map(Number);
    s = s.slice(0, -tail[1]!.length) + `${((q[0]! << 8) | q[1]!).toString(16)}:${((q[2]! << 8) | q[3]!).toString(16)}`;
  }
  const [head, rest] = s.split('::');
  const h = head ? head.split(':') : [];
  const r = rest !== undefined ? (rest ? rest.split(':') : []) : [];
  const groups = rest !== undefined ? [...h, ...Array(8 - h.length - r.length).fill('0'), ...r] : h;
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 255]; });
}

export function isPrivateAddress(a: string): boolean {
  const addr = a.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (net.isIPv4(addr)) return BLOCKED.check(addr, 'ipv4');
  if (!net.isIPv6(addr)) return true; // not an address: never connect
  if (BLOCKED.check(addr, 'ipv6')) return true;
  const b = v6bytes(addr);
  if (!b) return true;
  const v4 = (o: number) => b.slice(o, o + 4).join('.');
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 10) && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) return BLOCKED.check(v4(12), 'ipv4') || zeros(0, 16); // mapped / compatible
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return BLOCKED.check(v4(12), 'ipv4'); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return BLOCKED.check(v4(2), 'ipv4'); // 6to4
  return false;
}

function parseTarget(s: string | undefined): EgressTarget | null {
  const m = /^([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]+\]):(\d{1,5})$/.exec(s ?? '');
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1]!.replace(/^\[|\]$/g, '').toLowerCase(), port } : null;
}

export async function startEgressProxy(a: { socketPath: string; allow: EgressTarget[]; allowPrivate?: boolean; connectTimeoutMs?: number; maxConnections?: number }): Promise<EgressProxy> {
  const allow = new Set(a.allow.map((t) => `${t.host.toLowerCase()}:${t.port}`));
  const log: EgressProxy['log'] = [];
  const record = (e: EgressProxy['log'][number]) => { log.push(e); if (log.length > 1000) log.splice(0, log.length - 1000); };
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    record({ target: String(req.url).slice(0, 200), allowed: false, reason: 'only CONNECT is proxied' });
    res.writeHead(403).end();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.maxConnections = a.maxConnections ?? 64;
  server.on('connect', (req, client: net.Socket, head: Buffer) => {
    const deny = (reason: string, status = '403 Forbidden') => {
      record({ target: String(req.url).slice(0, 200), allowed: false, reason });
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
        record({ target: `${t.host}:${t.port}`, allowed: true });
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) up.write(head); // bytes the client sent along with the CONNECT
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
      // the socket file lives in the run folder, which the sandboxed program can change: remove it
      // only if it is still a socket, and never let a surprise there throw into the host process
      server.close(() => {
        try { if (fs.lstatSync(a.socketPath, { throwIfNoEntry: false })?.isSocket()) fs.unlinkSync(a.socketPath); } catch { /* the run folder is removed with the run */ }
        res();
      });
    }),
  };
}
