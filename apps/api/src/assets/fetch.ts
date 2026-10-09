// Fetching an open-access original (PW-034, spec 09 "외부 fetch"): the URL has already passed the
// policy (https:443, fixed open-access host). Here every resolved address is checked and the
// connection is pinned to a checked address (no DNS rebinding); no redirect is followed; no cookie or
// credential is sent; the answer must be a PDF within the size limit.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { FetchRefused, isInternalAddress } from '@pw/domain/asset-policy/index.ts';

export interface FetchConfig {
  allowHosts?: string[];
  dailyCap?: number;
  timeoutMs?: number;
  maxBytes?: number;
  // name resolution (default: the system resolver); every address returned is checked
  resolve?: (host: string) => Promise<string[]>;
  // test-only: plain http to a loopback stand-in for one host name; never set in production
  insecureLoopbackForTests?: { host: string; base: string };
}
const USER_AGENT = 'PaperWorkspace/0.1 (source fetch; one document at a time)';
const systemResolve = async (host: string) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export async function fetchSourcePdf(cfg: FetchConfig, url: URL, maxBytes: number): Promise<Buffer> {
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const test = cfg.insecureLoopbackForTests && url.hostname === cfg.insecureLoopbackForTests.host ? cfg.insecureLoopbackForTests : null;
  let target: URL;
  let pinned: string | null = null;
  if (test) {
    target = new URL(url.pathname + url.search, test.base);
  } else {
    let addrs: string[];
    try {
      addrs = await (cfg.resolve ?? systemResolve)(url.hostname);
    } catch {
      throw new FetchRefused('network', 'the host name could not be resolved');
    }
    if (!addrs.length) throw new FetchRefused('network', 'the host name has no address');
    if (addrs.some((a) => isInternalAddress(a))) throw new FetchRefused('internal_address', 'the host resolves to an internal address');
    target = url;
    pinned = addrs[0]!;
  }
  return new Promise<Buffer>((resolve, reject) => {
    const lib = target.protocol === 'https:' ? https : http;
    const family = pinned ? net.isIP(pinned) : 0;
    const req = lib.request(target, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'application/pdf' },
      ...(pinned ? {
        servername: url.hostname,
        lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => (opts?.all ? cb(null, [{ address: pinned, family }]) : cb(null, pinned, family))) as unknown as typeof dns.lookup,
      } : {}),
    }, (res) => {
      const status = res.statusCode ?? 0;
      const fail = (e: FetchRefused) => { res.destroy(); reject(e); };
      if (status >= 300 && status < 400) return fail(new FetchRefused('redirect', 'the source redirects elsewhere (not followed)'));
      if (status !== 200) return fail(new FetchRefused('http_error', `the source answered ${status}`));
      if (!/^application\/pdf\b/i.test(String(res.headers['content-type'] ?? ''))) return fail(new FetchRefused('not_pdf', 'the source did not answer with a PDF (a login or landing page?)'));
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) return fail(new FetchRefused('too_large', `the document exceeds ${maxBytes} bytes`));
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', (e) => reject(e instanceof FetchRefused ? e : new FetchRefused('network', 'the answer was cut off')));
      res.on('aborted', () => reject(new FetchRefused('timeout', `no complete answer within ${timeoutMs} ms`)));
    });
    // an overall deadline (a slow drip does not keep the request alive) and an idle timeout
    const deadline = setTimeout(() => req.destroy(new FetchRefused('timeout', `no complete answer within ${timeoutMs} ms`)), timeoutMs);
    req.on('close', () => clearTimeout(deadline));
    req.setTimeout(timeoutMs, () => req.destroy(new FetchRefused('timeout', `no answer within ${timeoutMs} ms`)));
    req.on('error', (e) => reject(e instanceof FetchRefused ? e : new FetchRefused('network', 'the source could not be reached')));
    req.end();
  });
}
