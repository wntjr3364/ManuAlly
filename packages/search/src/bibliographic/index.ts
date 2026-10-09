// Bibliographic search (PW-031, spec 05 "검색과 원문"): Crossref and PubMed (NCBI E-utilities).
// - Only the fixed public endpoints over HTTPS (tests may point at loopback explicitly). Every request
//   is bounded (time, size), carries an identifying user agent and contact, and keeps a minimum
//   interval per source.
// - Every search is logged with its exact query, parameters, endpoint, the source's API version, the
//   observation time and a hash of the answer; candidates are stored with their metadata and point at
//   that search. An identical search within the cache time is answered from the log.
// - A refused key, a rate limit, a moved endpoint, a server error, a timeout, an oversized or changed
//   answer → "source_unavailable" with the reason. Nothing is fabricated, nothing partial is stored.
import { createHash } from 'node:crypto';
import { SourceUnavailable, boundedGet, parseJson, type Unavailable } from './http.ts';
import { crossrefUrl, parseCrossref } from './crossref.ts';
import { esearchUrl, esummaryUrl, parseEsearch, parseEsummary } from './pubmed.ts';
import type { Candidate, Parsed } from './types.ts';

export type { Candidate, Author } from './types.ts';
export { SourceUnavailable, type Unavailable } from './http.ts';
export const SOURCES = ['crossref', 'pubmed'] as const;
export type Source = (typeof SOURCES)[number];
export const DEFAULT_ENDPOINTS: Record<Source, string> = {
  crossref: 'https://api.crossref.org/works',
  pubmed: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
};
export const MAX_LIMIT = 20;

export interface SearchConfig {
  endpoints?: Partial<Record<Source, string>>;
  // tests only: the stand-in server on 127.0.0.1 may replace an endpoint
  allowLoopbackForTests?: boolean;
  contact?: string | null; // e-mail for the sources' polite use (Crossref mailto, NCBI email)
  apiKey?: string | null; // NCBI api_key (optional)
  minIntervalMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  cacheTtlMs?: number;
}

interface Q { query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }> }
interface Pool extends Q { connect(): Promise<Q & { release(): void }> }

export type SearchResult =
  | { status: 'ok'; search_id: string; source: Source; query: string; endpoint: string; observed_at: string; from_cache: boolean; total_results: number | null; candidates: (Candidate & { rank: number })[] }
  | { status: 'source_unavailable'; search_id: string; source: Source; query: string; endpoint: string; observed_at: string; reason: Unavailable; retry_after_s: number | null };

class Refused extends Error {}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function endpointFor(source: Source, c: SearchConfig): string {
  const e = c.endpoints?.[source] ?? DEFAULT_ENDPOINTS[source];
  let u: URL;
  try { u = new URL(e); } catch { throw new Refused(`refused: the ${source} endpoint is not a URL`); }
  const loopback = c.allowLoopbackForTests === true && u.protocol === 'http:' && u.hostname === '127.0.0.1';
  if (!loopback && u.protocol !== 'https:') throw new Refused(`refused: the ${source} endpoint must use https`);
  if (!loopback && e !== DEFAULT_ENDPOINTS[source]) throw new Refused(`refused: the ${source} endpoint is fixed (${DEFAULT_ENDPOINTS[source]})`);
  return e;
}

// one request at a time per source, at least minIntervalMs apart (per process)
const lastAt = new Map<Source, number>();
const queue = new Map<Source, Promise<unknown>>();
function paced<T>(source: Source, minIntervalMs: number, fn: () => Promise<T>): Promise<T> {
  const run = (queue.get(source) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const wait = (lastAt.get(source) ?? 0) + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt.set(source, Date.now());
    return fn();
  });
  queue.set(source, run);
  return run;
}

async function fetchParsed(source: Source, endpoint: string, a: { query: string; limit: number }, c: Required<Pick<SearchConfig, 'timeoutMs' | 'maxBytes' | 'minIntervalMs'>> & SearchConfig): Promise<{ parsed: Parsed; hash: string }> {
  const get = (url: string) => paced(source, c.minIntervalMs, () => boundedGet(url, { timeoutMs: c.timeoutMs, maxBytes: c.maxBytes }));
  if (source === 'crossref') {
    const r = await get(crossrefUrl(endpoint, { ...a, contact: c.contact ?? null }));
    return { parsed: parseCrossref(parseJson(r.text)), hash: sha256(r.text) };
  }
  const s = await get(esearchUrl(endpoint, { ...a, contact: c.contact ?? null, apiKey: c.apiKey ?? null }));
  const found = parseEsearch(parseJson(s.text));
  if (!found.ids.length) return { parsed: { apiVersion: found.version, total: found.total, items: [] }, hash: sha256(s.text) };
  const m = await get(esummaryUrl(endpoint, found.ids, { contact: c.contact ?? null, apiKey: c.apiKey ?? null }));
  const parsed = parseEsummary(parseJson(m.text), found.ids);
  return { parsed: { ...parsed, total: found.total }, hash: sha256(s.text + '\n' + m.text) };
}

export async function searchBibliographic(pool: Pool, a: { paperId: string; createdBy: string; source: Source; query: string; limit: number; config?: SearchConfig }): Promise<SearchResult> {
  if (!SOURCES.includes(a.source)) throw new Refused('refused: unknown source');
  const query = typeof a.query === 'string' ? a.query.trim() : '';
  if (!query || query.length > 1000) throw new Refused('refused: the query must be 1–1000 characters');
  if (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > MAX_LIMIT) throw new Refused(`refused: the limit must be 1–${MAX_LIMIT}`);
  const c = { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024, minIntervalMs: a.source === 'pubmed' ? (a.config?.apiKey ? 110 : 350) : 200, cacheTtlMs: 24 * 3600e3, ...a.config };
  const endpoint = endpointFor(a.source, c);
  const params = { limit: a.limit };
  const cacheKey = sha256(JSON.stringify({ source: a.source, endpoint, query, params }));

  // cache: the latest successful identical search of this paper within the cache time
  const hit = (await pool.query<{ id: string; observed_at: string; total_results: number | null }>(
    `SELECT id, observed_at, total_results FROM literature_searches WHERE paper_id = $1 AND cache_key = $2 AND status = 'ok'
       AND observed_at > clock_timestamp() - make_interval(secs => $3::double precision / 1000) ORDER BY observed_at DESC LIMIT 1`, [a.paperId, cacheKey, c.cacheTtlMs])).rows[0];
  if (hit) {
    const cands = (await pool.query<Candidate & { rank: number }>(
      'SELECT source, source_record_id, doi, title, authors, year, container, work_type, is_preprint, relations, update_notice, rank FROM literature_candidates WHERE search_id = $1 ORDER BY rank', [hit.id])).rows;
    return { status: 'ok', search_id: hit.id, source: a.source, query, endpoint, observed_at: new Date(hit.observed_at).toISOString(), from_cache: true, total_results: hit.total_results, candidates: cands };
  }

  let parsed: Parsed | null = null;
  let hash: string | null = null;
  let failure: SourceUnavailable | null = null;
  try {
    ({ parsed, hash } = await fetchParsed(a.source, endpoint, { query, limit: a.limit }, c));
  } catch (e) {
    if (!(e instanceof SourceUnavailable)) throw e;
    failure = e;
  }
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const s = (await tx.query<{ id: string; observed_at: string }>(
      `INSERT INTO literature_searches (paper_id, created_by, source, query, params, cache_key, endpoint, api_version, status, unavailable_reason, http_status, retry_after_s, response_sha256, total_results)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id, observed_at`,
      [a.paperId, a.createdBy, a.source, query, JSON.stringify(params), cacheKey, endpoint, parsed?.apiVersion ?? null, failure ? 'source_unavailable' : 'ok',
        failure?.reason ?? null, failure?.httpStatus ?? null, failure?.retryAfterS ?? null, hash, parsed?.total ?? null])).rows[0]!;
    const items = (parsed?.items ?? []).map((it, i) => ({ ...it, rank: i + 1 }));
    for (const it of items) {
      await tx.query(
        `INSERT INTO literature_candidates (search_id, paper_id, source, rank, source_record_id, doi, title, authors, year, container, work_type, is_preprint, relations, update_notice)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [s.id, a.paperId, it.source, it.rank, it.source_record_id, it.doi, it.title.slice(0, 2000), JSON.stringify(it.authors), it.year, it.container?.slice(0, 1000) ?? null, it.work_type,
          it.is_preprint, JSON.stringify(it.relations), it.update_notice ? JSON.stringify(it.update_notice) : null]);
    }
    await tx.query('COMMIT');
    const base = { search_id: s.id, source: a.source, query, endpoint, observed_at: new Date(s.observed_at).toISOString() };
    if (failure) return { status: 'source_unavailable', ...base, reason: failure.reason, retry_after_s: failure.retryAfterS };
    return { status: 'ok', ...base, from_cache: false, total_results: parsed!.total, candidates: items };
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}
