// Zotero, read-only (PW-038, spec 05 "Zotero와 이식성"): items of a Zotero library are read as CSL-JSON
// through the Zotero Web API and then imported like a CSL-JSON file (source "zotero"). Nothing is ever
// written to Zotero — this client can only send GET — and there is no synchronisation in either
// direction; the capabilities say so, so no screen can claim otherwise.
export const ZOTERO_CAPABILITIES = Object.freeze({
  read: true,
  write: false,
  sync: 'none' as const,
  note: '읽기 전용 가져오기만 합니다. Zotero를 바꾸지 않고, 양방향 동기화는 없습니다. 다시 가져오면 같은 항목은 같은 참고문헌으로 이어집니다.',
});

export class ZoteroUnavailable extends Error {
  readonly reason: 'bad_request' | 'auth' | 'rate_limited' | 'endpoint_changed' | 'server_error' | 'schema_changed' | 'timeout' | 'too_large' | 'network';
  constructor(reason: ZoteroUnavailable['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface ZoteroConfig {
  libraryType: 'user' | 'group';
  libraryId: string;
  // a read-only key the owner gives for this request; it is not stored
  apiKey?: string;
  baseUrl?: string; // tests only (a loopback stand-in); production: https://api.zotero.org
  allowLoopbackForTests?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

export async function readZoteroItems(cfg: ZoteroConfig, opts: { start?: number; limit?: number } = {}): Promise<{ items: unknown[]; total: number | null }> {
  if (!['user', 'group'].includes(cfg.libraryType) || !/^\d{1,12}$/.test(String(cfg.libraryId))) throw new ZoteroUnavailable('bad_request', 'library type must be user or group, and the library id a number');
  if (cfg.apiKey !== undefined && !/^[A-Za-z0-9]{8,64}$/.test(cfg.apiKey)) throw new ZoteroUnavailable('bad_request', 'the API key has an unexpected form');
  const u = new URL(`${cfg.baseUrl ?? 'https://api.zotero.org'}/${cfg.libraryType}s/${cfg.libraryId}/items`);
  if (u.protocol !== 'https:' && !(cfg.allowLoopbackForTests && u.hostname === '127.0.0.1')) throw new ZoteroUnavailable('bad_request', 'Zotero is reached over https only');
  u.searchParams.set('format', 'csljson');
  u.searchParams.set('limit', String(Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 100)));
  u.searchParams.set('start', String(Math.max(Math.floor(opts.start ?? 0), 0)));
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  const maxBytes = cfg.maxBytes ?? 5 * 1024 * 1024;
  let res: Response;
  try {
    res = await fetch(u, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', 'Zotero-API-Version': '3', ...(cfg.apiKey ? { 'Zotero-API-Key': cfg.apiKey } : {}) },
    });
  } catch (e) {
    const name = (e as { name?: string }).name;
    throw new ZoteroUnavailable(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', 'Zotero could not be reached');
  }
  if (res.status === 401 || res.status === 403) throw new ZoteroUnavailable('auth', `Zotero refused the request (${res.status}); the library may be private or the key wrong`);
  if (res.status === 429) throw new ZoteroUnavailable('rate_limited', 'Zotero asks to slow down');
  if (res.status >= 500) throw new ZoteroUnavailable('server_error', `Zotero failed (${res.status})`);
  if (res.status !== 200) throw new ZoteroUnavailable('endpoint_changed', `unexpected status ${res.status}`);
  const reader = res.body?.getReader();
  if (!reader) throw new ZoteroUnavailable('schema_changed', 'empty answer');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new ZoteroUnavailable('too_large', `the answer exceeds ${maxBytes} bytes`); }
    chunks.push(value);
  }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ZoteroUnavailable('schema_changed', 'the answer is not JSON'); }
  const items = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items : null;
  if (!items) throw new ZoteroUnavailable('schema_changed', 'the answer is not a list of CSL items');
  const total = Number(res.headers.get('total-results'));
  return { items, total: res.headers.get('total-results') !== null && Number.isFinite(total) ? total : null };
}
