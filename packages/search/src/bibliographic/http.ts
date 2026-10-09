// Bounded HTTP GET for bibliographic sources (PW-031): a time limit, a size limit, no redirects to
// elsewhere, and failures named by kind. Callers decide which endpoints are allowed.
export type Unavailable = 'auth' | 'rate_limited' | 'endpoint_changed' | 'server_error' | 'schema_changed' | 'timeout' | 'too_large' | 'network';
export class SourceUnavailable extends Error {
  readonly reason: Unavailable;
  readonly httpStatus: number | null;
  readonly retryAfterS: number | null;
  constructor(reason: Unavailable, message: string, httpStatus: number | null = null, retryAfterS: number | null = null) {
    super(message);
    this.reason = reason;
    this.httpStatus = httpStatus;
    this.retryAfterS = retryAfterS;
  }
}

export const USER_AGENT = 'paper-workspace/0.1 (bibliographic search; +local install)';

export async function boundedGet(url: string, opts: { timeoutMs: number; maxBytes: number }): Promise<{ status: number; text: string }> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs), headers: { 'user-agent': USER_AGENT, accept: 'application/json' } });
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new SourceUnavailable('timeout', `no answer within ${opts.timeoutMs} ms`);
    throw new SourceUnavailable('network', 'the source could not be reached');
  }
  const status = res.status;
  if (status === 401 || status === 403) throw new SourceUnavailable('auth', `the source refused the request (${status})`, status);
  if (status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    throw new SourceUnavailable('rate_limited', 'the source asks to slow down', status, Number.isFinite(ra) && ra >= 0 ? Math.floor(ra) : null);
  }
  if (status === 404 || status === 410 || (status >= 300 && status < 400)) throw new SourceUnavailable('endpoint_changed', `the endpoint answered ${status}`, status);
  if (status >= 500) throw new SourceUnavailable('server_error', `the source failed (${status})`, status);
  if (status !== 200) throw new SourceUnavailable('endpoint_changed', `unexpected status ${status}`, status);
  // read with a size limit
  const reader = res.body?.getReader();
  if (!reader) throw new SourceUnavailable('schema_changed', 'empty answer', status);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > opts.maxBytes) { await reader.cancel(); throw new SourceUnavailable('too_large', `the answer exceeds ${opts.maxBytes} bytes`, status); }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof SourceUnavailable) throw e;
    const name = (e as { name?: string }).name;
    throw new SourceUnavailable(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', 'the answer was cut off', status);
  }
  return { status, text: Buffer.concat(chunks).toString('utf8') };
}

export function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new SourceUnavailable('schema_changed', 'the answer is not JSON'); }
}
