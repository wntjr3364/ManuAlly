// PW-034 — source documents: rights and safe upload (spec 05 "원문 취득", 09 "파일과 URL", "외부 전송").
// TST-034A: the file hash, source, licence (or unknown) and the external-send permission are stored
//   together with the immutable original.
// TST-034B: paywall bypass, unlimited crawling, SSRF, malicious files and unapproved sending to an
//   external LLM are blocked.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { checkFetchUrl, externalSendDecision, inspectPdf, isInternalAddress, recordSourceAsset, safeFileName } from '../../../packages/domain/src/asset-policy/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
let dir: string;
let oa: http.Server;
let oaBase: string;
let oaBehave: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_q, res) => { res.writeHead(404); res.end(); };
const resolved: Record<string, string[]> = {};
const H: Record<string, Record<string, string>> = {};
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw034-assets-'));
  oa = http.createServer((q, r) => oaBehave(q, r));
  await new Promise<void>((r) => oa.listen(0, '127.0.0.1', () => r()));
  oaBase = `http://127.0.0.1:${(oa.address() as AddressInfo).port}`;
  app = buildServer({
    pool, allowedOrigins: [ORIGIN],
    assets: {
      dir, maxBytes: 200_000,
      fetch: {
        allowHosts: ['oa.test', 'evil-dns.test'], dailyCap: 6, timeoutMs: 2000,
        // test resolver: names → addresses (production resolves with the system resolver)
        resolve: async (host: string) => resolved[host] ?? [],
        // test-only: plain http to the loopback stand-in for "oa.test" (never in production)
        insecureLoopbackForTests: { host: 'oa.test', base: oaBase },
      },
    },
  });
  await app.ready();
  for (const u of ['alice', 'bob']) {
    ids[u] = (await createOwner(pool, { username: u, password: 'correct horse battery' })).id;
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: u, password: 'correct horse battery' } });
    H[u] = { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken, origin: ORIGIN };
  }
});
afterAll(async () => {
  await app?.close();
  oa?.close();
  await pool?.end();
  await db?.drop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// synthetic PDFs ------------------------------------------------------------------------------
function pdf(extra = '', pages = 1, body?: Buffer): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ');
  const pageObjs = Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n`).join('');
  const head = `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R ${extra} >> endobj\n2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pages} >> endobj\n${pageObjs}`;
  return Buffer.concat([Buffer.from(head, 'latin1'), body ?? Buffer.alloc(0), Buffer.from(`trailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1')]);
}
function objStm(content: string | Buffer): Buffer {
  const data = zlib.deflateSync(typeof content === 'string' ? Buffer.from(content, 'latin1') : content);
  return Buffer.concat([Buffer.from(`90 0 obj << /Type /ObjStm /N 1 /First 5 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
}
const GOOD = pdf('', 2);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const newPaper = async (who: string) => (await app.inject({ method: 'POST', url: '/api/papers', headers: H[who], payload: { working_title: 'src paper', article_type: 'research_article' } })).json().id as string;
const upload = (who: string, paperId: string, bytes: Buffer, q: Record<string, string> = {}, type = 'application/pdf') =>
  app.inject({ method: 'POST', url: `/api/papers/${paperId}/assets?${new URLSearchParams(q)}`, headers: { ...H[who], 'content-type': type }, payload: bytes });
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, headers: H[who], payload: payload as object | undefined });
const blobPath = (h: string) => path.join(dir, 'sha256', h.slice(0, 2), h);
const counts = async (paperId: string) => (await pool.query('SELECT (SELECT count(*)::int FROM asset_revisions WHERE paper_id = $1) AS a, (SELECT count(*)::int FROM asset_sources WHERE paper_id = $1) AS s', [paperId])).rows[0];

describe('TST-034A: hash, source, licence and send permission are stored with the original', () => {
  test('an upload stores the immutable original (content-addressed, read-only) with its hash, source, licence and rights', async () => {
    const p = await newPaper('alice');
    const r = await upload('alice', p, GOOD, { license: 'cc-by', name: 'Kim 2021.pdf' });
    expect(r.statusCode, r.body).toBe(201);
    const a = r.json();
    expect(a).toMatchObject({ sha256: sha(GOOD), byte_size: GOOD.length, media_type: 'application/pdf', original_name: 'Kim 2021.pdf', source: 'user_upload', source_url: null, page_count: 2,
      policy: { license: 'cc-by', keep_right: 'user_supplied', external_send: 'unknown' } });
    // uploading is not consent to send to a third party
    expect(a.policy.external_send).toBe('unknown');
    expect(fs.readFileSync(blobPath(a.sha256)).equals(GOOD)).toBe(true);
    expect(fs.statSync(blobPath(a.sha256)).mode & 0o222).toBe(0);
    // the same bytes again: the same asset
    const again = await upload('alice', p, GOOD, { license: 'unknown' });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(a.id);
    // without a licence: unknown, never guessed
    const other = await upload('alice', p, pdf('', 1));
    expect(other.json().policy).toMatchObject({ license: 'unknown', external_send: 'unknown' });
    await expect(pool.query("UPDATE asset_sources SET source = 'open_access_fetch' WHERE asset_revision_id = $1", [a.id])).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM asset_policy_revisions WHERE asset_revision_id = $1', [a.id])).rejects.toThrow(/immutable/);
    const list = (await call('alice', 'GET', `/api/papers/${p}/assets`)).json();
    expect(list.assets.map((x: { id: string }) => x.id)).toEqual([a.id, other.json().id]);
  });

  test('the owner\'s rights decisions are new policy revisions; earlier ones stay', async () => {
    const p = await newPaper('alice');
    const a = (await upload('alice', p, pdf('/Lang (en)'))).json();
    const r = await call('alice', 'POST', `/api/papers/${p}/assets/${a.id}/policy`, { external_send: 'allowed', license: 'cc-by-nc' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().policy).toMatchObject({ license: 'cc-by-nc', keep_right: 'user_supplied', external_send: 'allowed' });
    expect((await pool.query('SELECT external_send FROM asset_policy_revisions WHERE asset_revision_id = $1 ORDER BY created_at', [a.id])).rows.map((x) => x.external_send)).toEqual(['unknown', 'allowed']);
    expect((await call('alice', 'POST', `/api/papers/${p}/assets/${a.id}/policy`, { external_send: 'maybe' })).statusCode).toBe(422);
    expect((await call('alice', 'POST', `/api/papers/${p}/assets/${a.id}/policy`, { download: true })).statusCode).toBe(422);
    expect((await call('bob', 'POST', `/api/papers/${p}/assets/${a.id}/policy`, { external_send: 'allowed' })).statusCode).toBe(404);
  });

  test('an original may be linked to a reference of the same paper only', async () => {
    const p = await newPaper('alice');
    const ref = (await call('alice', 'POST', `/api/papers/${p}/references`, { title: 'Linked work', authors: [{ family: 'Kim' }] })).json();
    const a = await upload('alice', p, pdf('/Lang (ko)'), { reference_id: ref.id });
    expect(a.json().reference_id).toBe(ref.id);
    const q = await newPaper('alice');
    expect((await upload('alice', q, pdf('/Lang (de)'), { reference_id: ref.id })).statusCode).toBe(404);
    expect((await upload('alice', p, pdf('/Lang (fr)'), { reference_id: 'nope' })).statusCode).toBe(422);
    // the store itself checks too (not only the route)
    await expect(recordSourceAsset(pool, { paperId: q, ownerId: ids.alice!, sha256: 'a'.repeat(64), byteSize: 1, pages: 1, originalName: 'x.pdf', source: 'user_upload', sourceUrl: null, referenceId: ref.id,
      policy: { license: 'unknown', keep_right: 'user_supplied', external_send: 'unknown' } })).rejects.toThrow(/not found/);
  });

  test('download is safe: attachment with a clean name, no sniffing, sandboxed, not cached; the bytes are verified', async () => {
    const p = await newPaper('alice');
    const bytes = pdf('/Lang (it)');
    const a = (await upload('alice', p, bytes, { name: '../../etc/"evil"‮.pdf' })).json();
    expect(a.original_name).toBe(safeFileName('../../etc/"evil"‮.pdf'));
    const r = await call('alice', 'GET', `/api/papers/${p}/assets/${a.id}/content`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment; filename="[^"/\\]+"; filename\*=UTF-8''/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-security-policy'])).toContain('sandbox');
    expect(String(r.headers['cache-control'])).toContain('no-store');
    expect(r.rawPayload.equals(bytes)).toBe(true);
    expect((await call('bob', 'GET', `/api/papers/${p}/assets/${a.id}/content`)).statusCode).toBe(404);
    // a changed file on disk is never served as the original
    const f = blobPath(a.sha256);
    fs.chmodSync(f, 0o644);
    fs.writeFileSync(f, pdf('/Lang (xx)'));
    const bad = await call('alice', 'GET', `/api/papers/${p}/assets/${a.id}/content`);
    expect(bad.statusCode).toBe(500);
    expect(bad.body).toMatch(/integrity/);
    expect(bad.body).not.toContain('%PDF');
  });
});

describe('TST-034B: malicious files, SSRF, crawling, paywalls and unapproved sending are blocked', () => {
  test('active content, encryption, hidden names, compressed hiding places, bombs, non-PDFs and truncation are refused; nothing is stored', async () => {
    const p = await newPaper('alice');
    const cases: [string, Buffer, string][] = [
      ['javascript', pdf('/OpenAction << /S /JavaScript /JS (app.alert(1)) >>'), 'active_content'],
      ['escaped name', pdf('/OpenAction << /S /L#61unch /F (cmd.exe) >>'), 'active_content'],
      ['launch', pdf('/OpenAction << /S /Launch /F (cmd.exe) >>'), 'active_content'],
      ['embedded file', pdf('/Names << /EmbeddedFiles 9 0 R >>'), 'active_content'],
      ['xfa', pdf('/AcroForm << /XFA 9 0 R >>'), 'active_content'],
      ['encrypted', Buffer.from(pdf().toString('latin1').replace('trailer << /Root 1 0 R >>', 'trailer << /Root 1 0 R /Encrypt 9 0 R >>'), 'latin1'), 'encrypted'],
      ['hidden in object stream', pdf('', 1, objStm('<< /S /JavaScript /JS (x) >>')), 'active_content'],
      ['html', Buffer.from('<html><script>alert(1)</script></html>'), 'not_pdf'],
      ['truncated', GOOD.subarray(0, GOOD.length - 10), 'truncated'],
    ];
    for (const [name, bytes, reason] of cases) {
      const r = await upload('alice', p, bytes);
      expect(r.statusCode, name).toBe(422);
      expect(r.json(), name).toMatchObject({ reason });
    }
    expect(inspectPdf(pdf('', 1, objStm(Buffer.alloc(5_000_000, 32))), { maxInflated: 1_000_000 })).toMatchObject({ ok: false, reason: 'decompression_limit' });
    expect(inspectPdf(pdf('', 5), { maxPages: 4 })).toMatchObject({ ok: false, reason: 'too_many_pages' });
    expect(await counts(p)).toEqual({ a: 0, s: 0 });
    // wrong type and oversized bodies are refused before inspection
    expect((await upload('alice', p, GOOD, {}, 'text/html')).statusCode).toBe(415);
    expect((await upload('alice', p, pdf('', 1, Buffer.alloc(250_000, 32)))).statusCode).toBe(413);
    expect((await upload('bob', p, GOOD)).statusCode).toBe(404);
  });

  test('a refused file leaves no blob behind', async () => {
    const p = await newPaper('alice');
    const evil = pdf('/OpenAction << /S /JavaScript /JS (leave-no-trace) >>');
    await upload('alice', p, evil);
    expect(fs.existsSync(blobPath(sha(evil)))).toBe(false);
  });

  test('nothing goes to an external AI without every permission: paper policy, provider, classification and the asset\'s own send right', async () => {
    const p = await newPaper('alice');
    const a = (await upload('alice', p, pdf('/Lang (es)'))).json();
    const d = await externalSendDecision(pool, { paperId: p, assetId: a.id, provider: 'claude_agent' });
    expect(d).toEqual({ allowed: false, reasons: ['provider_not_allowed_for_paper', 'asset_send_unknown'] });
    await pool.query("UPDATE paper_projects SET allowed_providers = '{claude_agent}' WHERE id = $1", [p]);
    expect((await externalSendDecision(pool, { paperId: p, assetId: a.id, provider: 'claude_agent' })).reasons).toEqual(['asset_send_unknown']);
    await call('alice', 'POST', `/api/papers/${p}/assets/${a.id}/policy`, { external_send: 'denied' });
    expect((await externalSendDecision(pool, { paperId: p, assetId: a.id, provider: 'claude_agent' })).reasons).toEqual(['asset_send_denied']);
    await call('alice', 'POST', `/api/papers/${p}/assets/${a.id}/policy`, { external_send: 'allowed' });
    expect(await externalSendDecision(pool, { paperId: p, assetId: a.id, provider: 'claude_agent' })).toEqual({ allowed: true, reasons: [] });
    expect((await externalSendDecision(pool, { paperId: p, assetId: a.id, provider: 'codex' })).allowed).toBe(false);
    await pool.query("UPDATE paper_projects SET data_classification = 'sensitive' WHERE id = $1", [p]);
    expect((await externalSendDecision(pool, { paperId: p, assetId: a.id, provider: 'claude_agent' })).reasons).toEqual(['paper_is_sensitive']);
    await pool.query("UPDATE paper_projects SET data_classification = 'unpublished', external_send_policy = 'block' WHERE id = $1", [p]);
    expect((await externalSendDecision(pool, { paperId: p, assetId: a.id, provider: 'claude_agent' })).reasons).toEqual(['paper_blocks_external_send']);
    // the API shows the same decision
    expect((await call('alice', 'GET', `/api/papers/${p}/assets/${a.id}/send-check?provider=claude_agent`)).json()).toMatchObject({ allowed: false, reasons: ['paper_blocks_external_send'] });
  });

  test('URL policy: https:443 to fixed open-access hosts only; internal addresses in any form are refused', () => {
    for (const bad of ['http://europepmc.org/x.pdf', 'https://user:pw@europepmc.org/x.pdf', 'https://europepmc.org:8443/x.pdf', 'https://127.0.0.1/x.pdf', 'https://[::1]/x.pdf',
      'https://www.sciencedirect.com/science/article/pii/X/pdfft', 'https://sci-hub.example/10.1/x', 'file:///etc/passwd', 'gopher://europepmc.org/', 'not a url']) {
      expect(() => checkFetchUrl(bad), bad).toThrow();
    }
    expect(checkFetchUrl('https://europepmc.org/articles/PMC1/pdf').hostname).toBe('europepmc.org');
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::169.254.169.254', '::127.0.0.1', '224.0.0.1', 'garbage']) {
      expect(isInternalAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '2606:4700:4700::1111', '193.62.193.80']) expect(isInternalAddress(ip), ip).toBe(false);
  });

  test('fetching: an allowed host that resolves to an internal address is refused (DNS rebinding / SSRF); redirects, HTML login pages and bad files are refused; every attempt is logged', async () => {
    const p = await newPaper('alice');
    resolved['evil-dns.test'] = ['93.184.216.34', '169.254.169.254'];
    const fetchIt = (url: string) => call('alice', 'POST', `/api/papers/${p}/assets/fetch`, { url });
    let r = await fetchIt('https://evil-dns.test/paper.pdf');
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ reason: 'internal_address' });
    expect((await fetchIt('https://publisher.example/paywalled.pdf')).json()).toMatchObject({ reason: 'host_not_allowed' });
    oaBehave = (_q, res) => { res.writeHead(302, { location: 'https://publisher.example/login' }); res.end(); };
    expect((await fetchIt('https://oa.test/redirect.pdf')).json()).toMatchObject({ reason: 'redirect' });
    oaBehave = (_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>Please sign in</html>'); };
    expect((await fetchIt('https://oa.test/login.pdf')).json()).toMatchObject({ reason: 'not_pdf' });
    oaBehave = (q, res) => {
      if (q.headers.cookie || q.headers.authorization) { res.writeHead(400); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(pdf('/OpenAction << /S /JavaScript /JS (x) >>'));
    };
    expect((await fetchIt('https://oa.test/evil.pdf')).json()).toMatchObject({ reason: 'rejected_file' });
    const ok = pdf('/Lang (oa)');
    oaBehave = (q, res) => {
      if (q.headers.cookie || q.headers.authorization) { res.writeHead(400); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(ok);
    };
    r = await fetchIt('https://oa.test/open.pdf');
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ sha256: sha(ok), source: 'open_access_fetch', source_url: 'https://oa.test/open.pdf', policy: { license: 'unknown', keep_right: 'unknown', external_send: 'unknown' } });
    const log = (await pool.query('SELECT outcome FROM asset_fetches WHERE paper_id = $1 ORDER BY attempted_at', [p])).rows.map((x) => x.outcome);
    expect(log).toEqual(['internal_address', 'host_not_allowed', 'redirect', 'not_pdf', 'rejected_file', 'stored']);
  });

  test('crawling is capped: after the daily number of attempts per owner, fetches are refused before any request', async () => {
    const p = await newPaper('alice');
    let hits = 0;
    oaBehave = (_q, res) => { hits++; res.writeHead(404); res.end(); };
    const before = hits;
    const rs = [];
    for (let i = 0; i < 3; i++) rs.push((await call('alice', 'POST', `/api/papers/${p}/assets/fetch`, { url: `https://oa.test/${randomUUID()}.pdf` })).json());
    // alice already used her six attempts in the test above
    expect(rs.every((x) => x.reason === 'daily_cap')).toBe(true);
    expect(hits).toBe(before);
    // the cap covers every attempt, whatever the URL
    expect((await call('alice', 'POST', `/api/papers/${p}/assets/fetch`, { url: 'https://publisher.example/x.pdf' })).json()).toMatchObject({ reason: 'daily_cap' });
    // bob's cap is his own
    const q = await newPaper('bob');
    expect((await call('bob', 'POST', `/api/papers/${q}/assets/fetch`, { url: 'https://oa.test/missing.pdf' })).json()).toMatchObject({ reason: 'http_error' });
  });
});
