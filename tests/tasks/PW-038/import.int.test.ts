// PW-038 — reference portability and read-only Zotero (spec 05 "Zotero와 이식성").
// TST-038A: supported formats import into stable reference ids with source metadata, and can be cited.
// TST-038B: an external Zotero library is never modified, and no two-way sync is claimed or performed.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { MAX_IMPORT_BYTES, importReferences, parseBibtex, parseCslJson, parseRis } from '../../../packages/domain/src/imports/references/index.ts';
import { readZoteroItems } from '../../../packages/search/src/zotero/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
let zot: http.Server;
let zotItems: unknown[] = [];
let zotStatus = 200;
const zotSeen: { method: string; url: string; key: string | undefined }[] = [];
const H: Record<string, Record<string, string>> = {};
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  zot = http.createServer((req, res) => {
    zotSeen.push({ method: req.method!, url: req.url!, key: req.headers['zotero-api-key'] as string | undefined });
    if (zotStatus !== 200) { res.writeHead(zotStatus); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'total-results': String(zotItems.length) });
    res.end(JSON.stringify(zotItems));
  });
  await new Promise<void>((r) => zot.listen(0, '127.0.0.1', () => r()));
  app = buildServer({ pool, allowedOrigins: [ORIGIN], zotero: { baseUrl: `http://127.0.0.1:${(zot.address() as AddressInfo).port}`, allowLoopbackForTests: true } });
  await app.ready();
  for (const u of ['alice', 'bob']) {
    await createOwner(pool, { username: u, password: 'correct horse battery' });
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: u, password: 'correct horse battery' } });
    H[u] = { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken, origin: ORIGIN };
  }
});
afterAll(async () => {
  await app?.close();
  zot?.close();
  await pool?.end();
  await db?.drop();
});

const call = async (who: string, method: 'GET' | 'POST', url: string, payload?: unknown, code?: number) => {
  const r = await app.inject({ method, url, headers: H[who], payload: payload as object | undefined });
  if (code) expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(code);
  return r;
};
const newPaper = async (who = 'alice') => (await call(who, 'POST', '/api/papers', { working_title: 'import paper', article_type: 'research_article' }, 201)).json().id as string;

const BIB = String.raw`
@string{pj = "Plant Journal"}
@article{kim2021abc,
  title = {Drought induces {ABC1} in roots},
  author = {Kim, Ji and Lee, Su},
  journal = {Plant J},
  year = 2021,
  doi = {10.5555/BIB.1}
}
@inproceedings{m{\"u}ller2020,
  title = "M{\"u}ller's {\'e}tude of roots",
  author = {Hans M{\"u}ller},
  booktitle = {Proc. Roots},
  year = {2020}
}
@misc{notitle, author = {Nobody}, year = 2019}
@article{macro2022, title = {Uses a macro}, journal = pj, year = 2022}
`;
const RIS = `TY  - JOUR
ID  - ris1
TI  - Root hydraulics under drought
AU  - Park, Min
AU  - Choi, Ha
PY  - 2018/05/01
JO  - Root Biology
DO  - https://doi.org/10.5555/RIS.1
ER  - 
TY  - CHAP
TI  - A chapter without id
AU  - Jung, Ho
PY  - 2015
ER  - 
`;
const CSL = JSON.stringify([
  { id: 'csl-a', type: 'article-journal', title: 'Stomata close in drought', author: [{ family: 'Han', given: 'Ye' }], issued: { 'date-parts': [[2019]] }, 'container-title': 'Leaf Science', DOI: '10.5555/CSL.1' },
  { id: 'csl-b', type: 'book', title: 'Plant water relations', author: [{ literal: 'The Water Group' }], issued: { 'date-parts': [['2017']] } },
]);

describe('TST-038A: supported formats import into stable reference ids with source metadata, and can be cited', () => {
  test('parsers read BibTeX (braces, quotes, accents, macros), RIS and CSL-JSON without inventing fields', () => {
    const b = parseBibtex(BIB);
    expect(b.map((e: { key: string }) => e.key)).toEqual(['kim2021abc', 'm{\\"u}ller2020', 'notitle', 'macro2022']);
    expect(b[0]).toMatchObject({ csl: { type: 'article-journal', title: 'Drought induces ABC1 in roots', author: [{ family: 'Kim', given: 'Ji' }, { family: 'Lee', given: 'Su' }], issued: { 'date-parts': [[2021]] }, 'container-title': 'Plant J', DOI: '10.5555/BIB.1' } });
    expect(b[1]).toMatchObject({ csl: { type: 'paper-conference', title: "Müller's étude of roots", author: [{ family: 'Müller', given: 'Hans' }] } });
    expect(b[2]).toMatchObject({ error: 'no_title' });
    expect(b[3]!.warnings).toContain('string_macro:journal');
    expect(b[3]!.csl['container-title']).toBeUndefined();
    const r = parseRis(RIS);
    expect(r[0]).toMatchObject({ key: 'ris1', csl: { type: 'article-journal', title: 'Root hydraulics under drought', author: [{ family: 'Park', given: 'Min' }, { family: 'Choi', given: 'Ha' }], issued: { 'date-parts': [[2018]] }, 'container-title': 'Root Biology' } });
    expect(r[1]).toMatchObject({ key: '#2', csl: { type: 'chapter', issued: { 'date-parts': [[2015]] } } });
    const c = parseCslJson(CSL);
    expect(c[1]).toMatchObject({ key: 'csl-b', csl: { author: [{ family: 'The Water Group' }], issued: { 'date-parts': [[2017]] } } });
    expect(() => parseCslJson('{"not": "a list"}')).toThrow(/list/);
  });

  test('an import creates works with stable ids, records its source, and importing again gives the same ids', async () => {
    const p = await newPaper();
    const r1 = (await call('alice', 'POST', `/api/papers/${p}/references/import`, { format: 'bibtex', text: BIB }, 201)).json();
    expect(r1.results.map((x: { key: string; status: string }) => [x.key, x.status])).toEqual([['kim2021abc', 'created'], ['m{\\"u}ller2020', 'created'], ['notitle', 'invalid'], ['macro2022', 'created']]);
    const [kim, mul, , mac] = r1.results;
    const rev = (await pool.query('SELECT source, csl_json FROM bibliographic_revisions WHERE reference_id = $1', [kim.reference_id])).rows;
    expect(rev).toEqual([{ source: 'import', csl_json: expect.objectContaining({ DOI: '10.5555/bib.1', title: 'Drought induces ABC1 in roots' }) }]);
    expect((await pool.query('SELECT format, source, entry_count FROM reference_imports WHERE id = $1', [r1.import_id])).rows[0]).toEqual({ format: 'bibtex', source: 'import', entry_count: 4 });
    expect((await pool.query('SELECT count(*)::int AS n FROM reference_import_items WHERE import_id = $1', [r1.import_id])).rows[0].n).toBe(4);
    // again (another paper of the same owner): the same works, by DOI and by citekey
    const q = await newPaper();
    const r2 = (await call('alice', 'POST', `/api/papers/${q}/references/import`, { format: 'bibtex', text: BIB }, 201)).json();
    expect(r2.results.map((x: { reference_id: string | null; status: string }) => [x.reference_id, x.status])).toEqual([[kim.reference_id, 'linked_existing'], [mul.reference_id, 'linked_existing'], [null, 'invalid'], [mac.reference_id, 'linked_existing']]);
    // and in the same paper: already there
    const r3 = (await call('alice', 'POST', `/api/papers/${p}/references/import`, { format: 'bibtex', text: BIB }, 201)).json();
    expect(r3.results[0]).toMatchObject({ reference_id: kim.reference_id, status: 'already_in_paper' });
    // another owner gets their own works
    const b = await newPaper('bob');
    const rb = (await call('bob', 'POST', `/api/papers/${b}/references/import`, { format: 'bibtex', text: BIB }, 201)).json();
    expect(rb.results[0].reference_id).not.toBe(kim.reference_id);
  });

  test('imported references are cited by their stable ids and appear in the bibliography', async () => {
    const p = await newPaper();
    const r = (await call('alice', 'POST', `/api/papers/${p}/references/import`, { format: 'ris', text: RIS }, 201)).json();
    expect(r.results.map((x: { status: string }) => x.status)).toEqual(['created', 'created']);
    const doc = (await call('alice', 'POST', `/api/papers/${p}/documents`, { kind: 'manuscript' }, 201)).json().document;
    await call('alice', 'POST', `/api/papers/${p}/documents/${doc.id}/revisions`, { expected_head_revision_id: doc.head_revision_id, schema_version: 1, reason: 'manual',
      content_json: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text: 'Roots ' }, { type: 'citation', attrs: { referenceId: r.results[0].reference_id, locator: null } }] }] } }, 201);
    const rendered = (await call('alice', 'GET', `/api/papers/${p}/documents/${doc.id}/references-render`, undefined, 200)).json();
    expect(JSON.stringify(rendered.bibliography)).toContain('Root hydraulics under drought');
    expect(JSON.stringify(rendered.bibliography)).toContain('https://doi.org/10.5555/ris.1');
  });

  test('a DOI the library knows keeps the library\'s metadata; a DOI list never invents metadata', async () => {
    const p = await newPaper();
    await call('alice', 'POST', `/api/papers/${p}/references/import`, { format: 'csl-json', text: CSL }, 201);
    const changed = JSON.stringify([{ id: 'x', type: 'article-journal', title: 'Stomata close in drought (typo version)', author: [{ family: 'Han' }], DOI: '10.5555/CSL.1' }]);
    const r = (await call('alice', 'POST', `/api/papers/${p}/references/import`, { format: 'csl-json', text: changed }, 201)).json();
    expect(r.results[0]).toMatchObject({ status: 'already_in_paper' });
    const q = await newPaper();
    const r2 = (await call('alice', 'POST', `/api/papers/${q}/references/import`, { format: 'csl-json', text: changed }, 201)).json();
    expect(r2.results[0]).toMatchObject({ status: 'kept_library_metadata' });
    const revs = (await pool.query("SELECT csl_json->>'title' AS t FROM bibliographic_revisions WHERE reference_id = $1", [r2.results[0].reference_id])).rows;
    expect(revs).toEqual([{ t: 'Stomata close in drought' }]);
    const d = (await call('alice', 'POST', `/api/papers/${q}/references/import`, { format: 'doi-list', text: 'https://doi.org/10.5555/csl.1\n10.5555/never.seen\nnot a doi' }, 201)).json();
    expect(d.results.map((x: { status: string }) => x.status)).toEqual(['already_in_paper', 'unknown_doi', 'invalid']);
    expect((await pool.query("SELECT count(*)::int AS n FROM reference_identifiers WHERE value = '10.5555/never.seen'")).rows[0].n).toBe(0);
  });

  test('bad input is refused as a whole or per entry, never partly guessed', async () => {
    const p = await newPaper();
    expect((await call('alice', 'POST', `/api/papers/${p}/references/import`, { format: 'endnote', text: 'x' })).statusCode).toBe(422);
    expect((await call('alice', 'POST', `/api/papers/${p}/references/import`, { format: 'csl-json', text: '{oops' })).json()).toMatchObject({ error: 'invalid' });
    const dup = (await call('alice', 'POST', `/api/papers/${p}/references/import`, { format: 'bibtex', text: '@article{a, title={One}}\n@article{a, title={Two}}' }, 201)).json();
    expect(dup.results.map((x: { status: string }) => x.status)).toEqual(['created', 'invalid']);
    expect((await call('bob', 'POST', `/api/papers/${p}/references/import`, { format: 'bibtex', text: BIB })).statusCode).toBe(404);
    await expect(pool.query("UPDATE reference_import_items SET status = 'created'")).rejects.toThrow(/immutable/);
  });
});

describe('TST-038B: Zotero is read only; no two-way sync is claimed or performed', () => {
  test('capabilities say read-only and no sync', async () => {
    const p = await newPaper();
    expect((await call('alice', 'GET', `/api/papers/${p}/references/zotero`, undefined, 200)).json().capabilities).toMatchObject({ read: true, write: false, sync: 'none' });
  });

  test('a Zotero import only reads (GET), records "zotero" as the source, and re-reading changed items never overwrites the library or writes back', async () => {
    const p = await newPaper();
    zotItems = [{ id: 'ZOT1', type: 'article-journal', title: 'Zotero item one', author: [{ family: 'Seo', given: 'Jin' }], issued: { 'date-parts': [[2020]] }, DOI: '10.5555/ZOT.1' },
      { id: 'ZOT2', type: 'book', title: 'Zotero book', author: [{ family: 'Yoon' }] }];
    zotSeen.length = 0;
    const r = (await call('alice', 'POST', `/api/papers/${p}/references/zotero/import`, { library_type: 'user', library_id: '12345', api_key: 'abcDEF1234567890' }, 201)).json();
    expect(r.results.map((x: { status: string }) => x.status)).toEqual(['created', 'created']);
    expect(r).toMatchObject({ source: 'zotero', zotero_total: 2, capabilities: { write: false, sync: 'none' } });
    expect((await pool.query('SELECT source FROM bibliographic_revisions WHERE reference_id = $1', [r.results[0].reference_id])).rows).toEqual([{ source: 'zotero' }]);
    expect(zotSeen).toEqual([{ method: 'GET', url: '/users/12345/items?format=csljson&limit=50&start=0', key: 'abcDEF1234567890' }]);
    // the key is not stored anywhere
    const dump = JSON.stringify((await pool.query('SELECT * FROM reference_imports')).rows) + JSON.stringify((await pool.query('SELECT * FROM reference_import_items')).rows);
    expect(dump).not.toContain('abcDEF1234567890');
    // the item changes in Zotero: re-reading it keeps the library's metadata and only reads again
    zotItems = [{ ...(zotItems[0] as object), title: 'Zotero item one (edited in Zotero)' }];
    const q = await newPaper();
    const r2 = (await call('alice', 'POST', `/api/papers/${q}/references/zotero/import`, { library_type: 'user', library_id: '12345' }, 201)).json();
    expect(r2.results[0]).toMatchObject({ reference_id: r.results[0].reference_id, status: 'kept_library_metadata' });
    expect(zotSeen.every((s) => s.method === 'GET')).toBe(true);
    expect(zotSeen.at(-1)!.key).toBeUndefined();
  });

  test('a private library or a bad library id fails clearly; nothing is imported', async () => {
    const p = await newPaper();
    zotStatus = 403;
    expect((await call('alice', 'POST', `/api/papers/${p}/references/zotero/import`, { library_type: 'user', library_id: '999' })).json()).toMatchObject({ reason: 'auth' });
    zotStatus = 200;
    expect((await call('alice', 'POST', `/api/papers/${p}/references/zotero/import`, { library_type: 'user', library_id: '../../etc' })).statusCode).toBe(422);
    expect((await call('alice', 'POST', `/api/papers/${p}/references/zotero/import`, { library_type: 'everyone', library_id: '1' })).statusCode).toBe(422);
    expect((await pool.query('SELECT count(*)::int AS n FROM project_references WHERE paper_id = $1', [p])).rows[0].n).toBe(0);
  });
});

describe('limits (mutation follow-up)', () => {
  test('a very long source key (RIS ID, BibTeX citekey, CSL id) is kept to 200 characters and still gives a stable id', async () => {
    const p = await newPaper();
    const long = 'k'.repeat(300);
    const ris = `TY  - JOUR\nID  - ${long}\nTI  - Long key work\nER  - \n`;
    const a1 = (await call('alice', 'POST', `/api/papers/${p}/references/import`, { format: 'ris', text: ris }, 201)).json();
    const a2 = (await call('alice', 'POST', `/api/papers/${p}/references/import`, { format: 'ris', text: ris }, 201)).json();
    expect(a1.results[0]).toMatchObject({ status: 'created', key: 'k'.repeat(200) });
    expect(a2.results[0]).toMatchObject({ status: 'already_in_paper', reference_id: a1.results[0].reference_id });
    for (const [format, text] of [['bibtex', `@article{${long}, title={Long citekey}}`], ['csl-json', JSON.stringify([{ id: long, title: 'Long CSL id' }])]] as const) {
      expect((await call('alice', 'POST', `/api/papers/${p}/references/import`, { format, text }, 201)).json().results[0].status).toBe('created');
    }
  });
  test('a text larger than the import limit is refused before it is read', async () => {
    const p = await newPaper();
    const owner = (await pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [p])).rows[0].owner_id as string;
    await expect(importReferences(pool, { paperId: p, ownerId: owner, format: 'doi-list', text: '10.5555/x\n'.repeat(Math.ceil(MAX_IMPORT_BYTES / 10) + 1) })).rejects.toThrow(/larger than/);
    expect((await pool.query('SELECT count(*)::int AS n FROM reference_imports WHERE paper_id = $1', [p])).rows[0].n).toBe(0);
  });
  test('Zotero is reached over https only; a plain-http or loopback address without the test switch is refused without a request', async () => {
    const before = zotSeen.length;
    const port = (zot.address() as AddressInfo).port;
    await expect(readZoteroItems({ libraryType: 'user', libraryId: '12345', baseUrl: `http://127.0.0.1:${port}` })).rejects.toMatchObject({ reason: 'bad_request' });
    await expect(readZoteroItems({ libraryType: 'user', libraryId: '12345', baseUrl: 'http://api.zotero.org' })).rejects.toMatchObject({ reason: 'bad_request' });
    expect(zotSeen.length).toBe(before);
  });
});

// review (PW-038)
describe('review: a work without a DOI is reused only for the same source, key and content', () => {
  const refsOf = async (p: string) => (await pool.query("SELECT b.csl_json->>'title' AS t FROM project_references r JOIN LATERAL (SELECT csl_json FROM bibliographic_revisions WHERE reference_id = r.reference_id ORDER BY created_at DESC, id DESC LIMIT 1) b ON true WHERE r.paper_id = $1 ORDER BY 1", [p])).rows.map((x) => x.t);
  test('MAJOR: two RIS files without IDs (both "#1") never share a work', async () => {
    const p1 = await newPaper();
    const p2 = await newPaper();
    const a = (await call('alice', 'POST', `/api/papers/${p1}/references/import`, { format: 'ris', text: 'TY  - JOUR\nTI  - Alpha paper about roots\nER  - \n' }, 201)).json();
    const b = (await call('alice', 'POST', `/api/papers/${p2}/references/import`, { format: 'ris', text: 'TY  - JOUR\nTI  - Beta paper about leaves\nER  - \n' }, 201)).json();
    expect(a.results[0].status).toBe('created');
    expect(b.results[0]).toMatchObject({ status: 'created' });
    expect(b.results[0].reference_id).not.toBe(a.results[0].reference_id);
    expect(await refsOf(p2)).toEqual(['Beta paper about leaves']);
    // the very same entry again: the same work (same source, same content)
    const a2 = (await call('alice', 'POST', `/api/papers/${p2}/references/import`, { format: 'ris', text: 'TY  - JOUR\nTI  - Alpha paper about roots\nER  - \n' }, 201)).json();
    expect(a2.results[0]).toMatchObject({ status: 'linked_existing', reference_id: a.results[0].reference_id });
    // a position is not a key: the same entry second in another file is still the same work
    const a3 = (await call('alice', 'POST', `/api/papers/${p1}/references/import`, { format: 'ris', text: 'TY  - JOUR\nTI  - Something first\nER  - \nTY  - JOUR\nTI  - Alpha paper about roots\nER  - \n' }, 201)).json();
    expect(a3.results[1]).toMatchObject({ status: 'already_in_paper', reference_id: a.results[0].reference_id });
  });
  test('MAJOR: a citekey reused for another work gives a new work and says so; the first stays stable', async () => {
    const p1 = await newPaper();
    const p2 = await newPaper();
    const g = (await call('alice', 'POST', `/api/papers/${p1}/references/import`, { format: 'bibtex', text: '@article{smith2020, title={Gamma drought study}}' }, 201)).json();
    const d = (await call('alice', 'POST', `/api/papers/${p2}/references/import`, { format: 'bibtex', text: '@article{smith2020, title={Delta unrelated chemistry}}' }, 201)).json();
    expect(d.results[0]).toMatchObject({ status: 'created' });
    expect(d.results[0].warnings).toContain('source_key_seen_with_other_metadata');
    expect(d.results[0].reference_id).not.toBe(g.results[0].reference_id);
    expect(await refsOf(p2)).toEqual(['Delta unrelated chemistry']);
    const g2 = (await call('alice', 'POST', `/api/papers/${p2}/references/import`, { format: 'bibtex', text: '@article{smith2020, title={Gamma drought study}}' }, 201)).json();
    expect(g2.results[0]).toMatchObject({ status: 'linked_existing', reference_id: g.results[0].reference_id });
    // and Delta again links Delta, not Gamma
    const d2 = (await call('alice', 'POST', `/api/papers/${p1}/references/import`, { format: 'bibtex', text: '@article{smith2020, title={Delta unrelated chemistry}}' }, 201)).json();
    expect(d2.results[0]).toMatchObject({ status: 'linked_existing', reference_id: d.results[0].reference_id });
  });
  test('nit: Zotero items and hand-made CSL-JSON do not share keys; one Zotero library does not share with another', async () => {
    const p = await newPaper();
    const f = (await call('alice', 'POST', `/api/papers/${p}/references/import`, { format: 'csl-json', text: JSON.stringify([{ id: 'SAMEKEY', title: 'Hand made entry' }]) }, 201)).json();
    zotItems = [{ id: 'SAMEKEY', title: 'Hand made entry' }];
    const z1 = (await call('alice', 'POST', `/api/papers/${p}/references/zotero/import`, { library_type: 'user', library_id: '12345' }, 201)).json();
    const z2 = (await call('alice', 'POST', `/api/papers/${p}/references/zotero/import`, { library_type: 'group', library_id: '777' }, 201)).json();
    const z1again = (await call('alice', 'POST', `/api/papers/${p}/references/zotero/import`, { library_type: 'user', library_id: '12345' }, 201)).json();
    const ids = [f, z1, z2].map((r) => r.results[0].reference_id);
    expect(new Set(ids).size).toBe(3);
    expect(z1again.results[0]).toMatchObject({ status: 'already_in_paper', reference_id: z1.results[0].reference_id });
  });
  test('nit: the result shows the library\'s title next to the file\'s when the paper gets the library\'s work', async () => {
    const p = await newPaper();
    await call('alice', 'POST', `/api/papers/${p}/references/import`, { format: 'csl-json', text: JSON.stringify([{ id: 'k', title: 'The library title', DOI: '10.5555/libtitle' }]) }, 201);
    const q = await newPaper();
    const r = (await call('alice', 'POST', `/api/papers/${q}/references/import`, { format: 'csl-json', text: JSON.stringify([{ id: 'k', title: 'A mistyped DOI entry', DOI: '10.5555/libtitle' }]) }, 201)).json();
    expect(r.results[0]).toMatchObject({ status: 'kept_library_metadata', title: 'A mistyped DOI entry', library_title: 'The library title' });
  });
});
