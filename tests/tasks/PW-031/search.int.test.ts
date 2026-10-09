// PW-031 — bibliographic search adapters (Crossref, PubMed E-utilities) against a local stand-in server
// with synthetic records (no real network).
// TST-031A: the real query, source, endpoint, observation time and metadata are linked to every
//   candidate; requests are bounded and cached.
// TST-031B: a changed key, limit, endpoint or response shape gives "source unavailable" — never
//   fabricated or partial results.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { createPaper } from '../../../packages/domain/src/papers/index.ts';
import { searchBibliographic, type SearchConfig } from '../../../packages/search/src/bibliographic/index.ts';

const FIX = path.resolve('tests/tasks/PW-031/fixtures');
const fixture = (n: string) => fs.readFileSync(path.join(FIX, n), 'utf8');
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let ownerId: string;
let server: http.Server;
let base: string;
// what the stand-in answers next, per path prefix; and every request it saw
let behave: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void> = {};
const seen: { path: string; at: number; query: URLSearchParams; ua: string | undefined }[] = [];
const json = (body: string, status = 200, headers: Record<string, string> = {}) => (_q: http.IncomingMessage, res: http.ServerResponse) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(body); };
const normal = () => ({
  '/works': json(fixture('crossref-works.json')),
  '/entrez/eutils/esearch.fcgi': json(fixture('pubmed-esearch.json')),
  '/entrez/eutils/esummary.fcgi': json(fixture('pubmed-esummary.json')),
});

beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 6 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  ownerId = (await createOwner(pool, { username: 'alice', password: 'correct horse battery' })).id;
  server = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    seen.push({ path: u.pathname, at: Date.now(), query: u.searchParams, ua: req.headers['user-agent'] });
    const h = behave[u.pathname];
    if (h) h(req, res);
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server?.close();
  await pool?.end();
  await db?.drop();
});

const paper = async () => (await createPaper(pool, ownerId, { working_title: 'p', article_type: 'research_article' })).id as string;
// test-only endpoints: the stand-in server on loopback (production uses the fixed public endpoints)
const cfg = (over: Partial<SearchConfig> = {}): SearchConfig => ({
  endpoints: { crossref: `${base}/works`, pubmed: `${base}/entrez/eutils` }, allowLoopbackForTests: true,
  contact: 'test@example.invalid', minIntervalMs: 0, timeoutMs: 2000, maxBytes: 1 << 20, cacheTtlMs: 60_000, ...over,
});
const search = async (over: Record<string, unknown> = {}, c: Partial<SearchConfig> = {}) =>
  searchBibliographic(pool, { paperId: await paper(), createdBy: ownerId, source: 'crossref', query: 'ABC1 drought roots', limit: 10, config: cfg(c), ...over });

describe('TST-031A: real query, source, time and metadata travel with each candidate', () => {
  test('a Crossref search is logged with its query, endpoint and observation time; candidates keep their metadata and relations', async () => {
    behave = normal();
    const before = seen.length;
    const r = await search();
    expect(r).toMatchObject({ status: 'ok', source: 'crossref', query: 'ABC1 drought roots', from_cache: false });
    if (r.status !== 'ok') throw new Error('unexpected');
    const req = seen.slice(before)[0]!;
    expect(req.query.get('query.bibliographic')).toBe('ABC1 drought roots');
    expect(req.query.get('rows')).toBe('10');
    expect(req.query.get('mailto')).toBe('test@example.invalid');
    expect(req.ua).toMatch(/paper-workspace/);
    const log = (await pool.query('SELECT source, query, endpoint, params, status, api_version, response_sha256, observed_at FROM literature_searches WHERE id = $1', [r.search_id])).rows[0];
    expect(log).toMatchObject({ source: 'crossref', query: 'ABC1 drought roots', endpoint: `${base}/works`, status: 'ok', api_version: '1.0.0' });
    expect(log.response_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.candidates).toHaveLength(3);
    expect(r.candidates[0]).toMatchObject({ rank: 1, doi: '10.5555/synthetic.0001', title: 'Drought induces ABC1 in synthetic roots', year: 2021, container: 'Synthetic Plant Journal', work_type: 'journal-article', authors: [{ family: 'Kim', given: 'Jiwon' }, { family: 'Lee', given: 'Sora' }], relations: { has_preprint: ['10.5555/synthetic.pre1'] } });
    expect(r.candidates[1]).toMatchObject({ doi: '10.5555/synthetic.pre1', work_type: 'posted-content', is_preprint: true, relations: { is_preprint_of: ['10.5555/synthetic.0001'] } });
    expect(r.candidates[2]).toMatchObject({ update_notice: { type: 'retraction', target_doi: '10.5555/synthetic.0099' } });
    // every stored candidate points at its search (query, source, time) and cannot be changed
    const rows = (await pool.query('SELECT c.doi, s.query, s.observed_at FROM literature_candidates c JOIN literature_searches s ON s.id = c.search_id WHERE c.search_id = $1 ORDER BY c.rank', [r.search_id])).rows;
    expect(rows.map((x) => x.doi)).toEqual(['10.5555/synthetic.0001', '10.5555/synthetic.pre1', '10.5555/synthetic.retraction']);
    await expect(pool.query("UPDATE literature_candidates SET title = 'x' WHERE search_id = $1", [r.search_id])).rejects.toThrow(/immutable/);
  });

  test('a PubMed search (esearch then esummary) gives PMIDs, DOIs when present, and retraction flags', async () => {
    behave = normal();
    const r = await search({ source: 'pubmed', query: 'ABC1[tiab] AND drought' });
    if (r.status !== 'ok') throw new Error(JSON.stringify(r));
    expect(r.candidates.map((c) => [c.source_record_id, c.doi])).toEqual([['90000001', '10.5555/synthetic.0001'], ['90000002', null]]);
    expect(r.candidates[0]).toMatchObject({ title: 'Drought induces ABC1 in synthetic roots.', year: 2021, authors: [{ family: 'Kim', given: 'J' }, { family: 'Lee', given: 'S' }], container: 'Synthetic Plant Journal' });
    expect(r.candidates[1]).toMatchObject({ update_notice: { type: 'retracted_publication' } });
    const esearch = seen.filter((x) => x.path.endsWith('esearch.fcgi')).at(-1)!;
    expect(esearch.query.get('term')).toBe('ABC1[tiab] AND drought');
    expect(esearch.query.get('retmode')).toBe('json');
    expect(esearch.query.get('tool')).toBe('paper-workspace');
  });

  test('the same search within the cache time is answered from the log without a request; the limit is bounded', async () => {
    behave = normal();
    const p = await paper();
    const one = await searchBibliographic(pool, { paperId: p, createdBy: ownerId, source: 'crossref', query: 'cache me', limit: 5, config: cfg() });
    const n = seen.length;
    const two = await searchBibliographic(pool, { paperId: p, createdBy: ownerId, source: 'crossref', query: 'cache me', limit: 5, config: cfg() });
    expect(seen.length).toBe(n);
    expect(two).toMatchObject({ status: 'ok', from_cache: true, search_id: one.status === 'ok' ? one.search_id : 'x' });
    await expect(searchBibliographic(pool, { paperId: p, createdBy: ownerId, source: 'crossref', query: 'too many', limit: 500, config: cfg() })).rejects.toThrow(/limit/);
    await expect(searchBibliographic(pool, { paperId: p, createdBy: ownerId, source: 'crossref', query: '   ', limit: 5, config: cfg() })).rejects.toThrow(/query/);
  });

  test('requests to one source keep a minimum interval', async () => {
    behave = normal();
    const p = await paper();
    const n = seen.length;
    await searchBibliographic(pool, { paperId: p, createdBy: ownerId, source: 'crossref', query: 'interval one', limit: 3, config: cfg({ minIntervalMs: 300 }) });
    await searchBibliographic(pool, { paperId: p, createdBy: ownerId, source: 'crossref', query: 'interval two', limit: 3, config: cfg({ minIntervalMs: 300 }) });
    const [a, b] = seen.slice(n);
    expect(b!.at - a!.at).toBeGreaterThanOrEqual(280);
  });
});

describe('TST-031B: changed key, limit, endpoint or shape → source unavailable, nothing invented', () => {
  test.each([
    ['auth', json('{"message":"bad key"}', 401)],
    ['auth', json('{"message":"forbidden"}', 403)],
    ['rate_limited', json('{"message":"slow down"}', 429, { 'retry-after': '120' })],
    ['endpoint_changed', json('not here', 404)],
    ['server_error', json('oops', 503)],
    ['schema_changed', json('{"status":"ok","message":{"total-results":1,"objects":[]}}')],
    ['schema_changed', json('{"status":"ok","message":{"items":[{"title":"not a list","DOI":5}]}}')],
    ['schema_changed', json('this is not json')],
    ['schema_changed', json('{"status":"ok","message":{"items":[{"title":["A work without its DOI"]}]}}')],
  ])('%s → unavailable, no candidates stored', async (reason, handler) => {
    behave = { '/works': handler };
    const r = await search({ query: `fail ${Math.random()}` });
    expect(r).toMatchObject({ status: 'source_unavailable', reason });
    expect('candidates' in r).toBe(false);
    const log = (await pool.query('SELECT status, unavailable_reason, (SELECT count(*)::int FROM literature_candidates c WHERE c.search_id = s.id) AS n FROM literature_searches s WHERE id = $1', [r.search_id])).rows[0];
    expect(log).toMatchObject({ status: 'source_unavailable', unavailable_reason: reason, n: 0 });
    if (reason === 'rate_limited') expect(r).toMatchObject({ retry_after_s: 120 });
  });

  test('a slow or oversized answer is unavailable (timeout, too_large); a failed search is not served from the cache', async () => {
    behave = { '/works': (_q, res) => { setTimeout(() => { res.writeHead(200); res.end(fixture('crossref-works.json')); }, 1500); } };
    expect(await search({ query: 'slow' }, { timeoutMs: 300 })).toMatchObject({ status: 'source_unavailable', reason: 'timeout' });
    behave = { '/works': json(JSON.stringify({ status: 'ok', message: { items: [], pad: 'x'.repeat(5000) } })) };
    expect(await search({ query: 'big' }, { maxBytes: 1000 })).toMatchObject({ status: 'source_unavailable', reason: 'too_large' });
    const p = await paper();
    behave = { '/works': json('oops', 503) };
    expect((await searchBibliographic(pool, { paperId: p, createdBy: ownerId, source: 'crossref', query: 'retry later', limit: 3, config: cfg() })).status).toBe('source_unavailable');
    behave = normal();
    expect(await searchBibliographic(pool, { paperId: p, createdBy: ownerId, source: 'crossref', query: 'retry later', limit: 3, config: cfg() })).toMatchObject({ status: 'ok', from_cache: false });
  });

  test('a PubMed esummary that drops a requested id is unavailable, not a shorter list', async () => {
    const partial = JSON.parse(fixture('pubmed-esummary.json'));
    delete partial.result['90000002'];
    behave = { ...normal(), '/entrez/eutils/esummary.fcgi': json(JSON.stringify(partial)) };
    expect(await search({ source: 'pubmed', query: `partial ${Math.random()}` })).toMatchObject({ status: 'source_unavailable', reason: 'schema_changed' });
  });

  test('endpoints are fixed: another host (or loopback outside tests) is refused before any request', async () => {
    const n = seen.length;
    await expect(search({}, { endpoints: { crossref: 'https://evil.example/works' } })).rejects.toThrow(/endpoint/);
    await expect(search({}, { allowLoopbackForTests: false })).rejects.toThrow(/endpoint/);
    await expect(search({}, { endpoints: { crossref: 'http://api.crossref.org/works' }, allowLoopbackForTests: false })).rejects.toThrow(/must use https/);
    expect(seen.length).toBe(n);
  });
});
