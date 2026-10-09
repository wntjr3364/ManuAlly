// Source documents (PDF originals) and what may be done with them (PW-034, spec 05 "원문 취득", 09
// "파일과 URL", "외부 전송").
// - A PDF is accepted only after a byte-level inspection: PDF signature and end marker, size, page
//   count, no encryption, no active content (JavaScript, launch actions, embedded files, rich media,
//   XFA forms, form submission). Compressed object streams are inflated (with an output limit) so that
//   dictionaries hidden in them are inspected too.
// - The original is immutable and content-addressed (sha256). Its source, licence, the right to keep it
//   and the right to send it to an external AI are stored with it; unknown means unknown and is never
//   treated as allowed: an original whose keep right is unknown (e.g. fetched) is not served or parsed
//   until the owner says on what basis it is kept.
// - The right to keep/download and the right to send to an external provider are separate fields. A
//   new decision adds a policy revision; earlier ones stay.
// - URL fetches are limited to fixed open-access hosts over https:443, with every resolved address
//   checked (no localhost, private, link-local, metadata or other internal addresses), no redirects,
//   no credentials, and a per-owner daily cap: no paywall bypass and no crawling.
import net from 'node:net';
import zlib from 'node:zlib';
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '../shared/db.ts';

export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_PDF_PAGES = 2000;
export const MAX_INFLATED_BYTES = 200 * 1024 * 1024;
export const INSPECTOR_VERSION = 'pw-pdf-inspect-1';

export type PdfVerdict = { ok: true; pages: number; warnings: string[] } | { ok: false; reason: PdfRejection; detail: string };
export type PdfRejection = 'empty' | 'too_large' | 'not_pdf' | 'truncated' | 'encrypted' | 'active_content' | 'too_many_pages' | 'decompression_limit' | 'malformed';

// PDF names may hide letters as #xx escapes (/J#61vaScript); undo them before looking
const unescapeNames = (s: string) => s.replace(/#([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
// actions and attachments that run, open or carry other content (link URIs are allowed: papers are full
// of DOI links, and viewers ask before following one)
const ACTIVE = /\/(JavaScript|JS|Launch|EmbeddedFiles?|EF|FileAttachment|RichMedia|XFA|SubmitForm|ImportData|GoToE|GoToR|Rendition|Sound|Movie)\b/;
const MAX_DICT = 1024 * 1024;

export function inspectPdf(buf: Buffer, limits: { maxBytes?: number; maxPages?: number; maxInflated?: number } = {}): PdfVerdict {
  const maxBytes = limits.maxBytes ?? MAX_PDF_BYTES;
  if (!buf.length) return { ok: false, reason: 'empty', detail: 'the file is empty' };
  if (buf.length > maxBytes) return { ok: false, reason: 'too_large', detail: `the file exceeds ${maxBytes} bytes` };
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return { ok: false, reason: 'not_pdf', detail: 'the file does not start with a PDF signature' };
  if (!buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1').includes('%%EOF')) return { ok: false, reason: 'truncated', detail: 'the PDF end marker is missing' };
  const raw = buf.toString('latin1');
  const texts = [unescapeNames(raw)];
  // inflate object streams (dictionaries can live there) within an output budget
  let inflated = 0;
  const maxInflated = limits.maxInflated ?? MAX_INFLATED_BYTES;
  // every stream: its dictionary is the text from the object's "obj" keyword to "stream" (no length
  // guess that padding could defeat; an implausibly long dictionary is refused)
  let objStms = 0;
  const re = /(?<!end)stream(?:\r\n|\n|\r)/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const objAt = raw.lastIndexOf('obj', m.index);
    if (objAt < 0) continue;
    if (m.index - objAt > MAX_DICT) return { ok: false, reason: 'malformed', detail: 'a stream dictionary is implausibly long' };
    const dict = unescapeNames(raw.slice(objAt, m.index));
    // an object stream by its type, or by the entries a reader uses to find objects in it (/N, /First):
    // viewers may resolve compressed objects without looking at /Type
    if (!/\/Type\s*\/ObjStm\b/.test(dict) && !(/\/N\s+\d/.test(dict) && /\/First\s+\d/.test(dict))) continue;
    objStms++;
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) return { ok: false, reason: 'malformed', detail: 'an object stream has no end' };
    if (!/\/FlateDecode\b/.test(dict) || /\/DecodeParms/.test(dict)) return { ok: false, reason: 'malformed', detail: 'an object stream uses an encoding this inspector does not read' };
    let out: Buffer;
    try {
      out = zlib.inflateSync(buf.subarray(start, end), { maxOutputLength: Math.max(1, maxInflated - inflated) });
    } catch (e) {
      if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') return { ok: false, reason: 'decompression_limit', detail: `object streams inflate beyond ${maxInflated} bytes` };
      return { ok: false, reason: 'malformed', detail: 'an object stream cannot be inflated' };
    }
    inflated += out.length; // (zlib stops at the remaining budget: maxOutputLength above)
    texts.push(unescapeNames(out.toString('latin1')));
  }
  // an object stream the walk above did not inflate is a place nothing was inspected: refuse
  if ((texts[0]!.match(/\/Type\s*\/ObjStm\b/g) ?? []).length > objStms) return { ok: false, reason: 'malformed', detail: 'an object stream could not be located for inspection' };
  const all = texts.join('\n');
  if (/\/Encrypt\b/.test(all)) return { ok: false, reason: 'encrypted', detail: 'encrypted PDFs are not accepted (they cannot be inspected or parsed)' };
  const active = ACTIVE.exec(all);
  if (active) return { ok: false, reason: 'active_content', detail: `the PDF carries active content (/${active[1]})` };
  const pages = (all.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  const maxPages = limits.maxPages ?? MAX_PDF_PAGES;
  if (pages > maxPages) return { ok: false, reason: 'too_many_pages', detail: `the PDF has more than ${maxPages} pages` };
  return { ok: true, pages, warnings: pages === 0 ? ['page_count_unknown'] : [] };
}

// A name safe to show and to offer as a download name: no path, no control characters, bounded.
export function safeFileName(raw: unknown): string {
  const base = typeof raw === 'string' ? raw.split(/[\\/]/).pop()! : '';
  // eslint-disable-next-line no-control-regex
  let n = base.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f"<>:|?*\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/^[.\s]+/, '').trim().slice(0, 150);
  if (!n) n = 'document';
  if (!/\.pdf$/i.test(n)) n += '.pdf';
  return n;
}
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  // RFC 5987 attr-char: encodeURIComponent leaves ' ( ) * as they are, which the grammar does not allow
  const ext = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${ext}`;
}

// ---- rights -------------------------------------------------------------------------------
export const LICENSES = ['unknown', 'cc-by', 'cc-by-sa', 'cc-by-nc', 'cc-by-nc-sa', 'cc-by-nd', 'cc-by-nc-nd', 'cc0', 'public-domain', 'publisher-tdm', 'all-rights-reserved', 'own-work'] as const;
export const KEEP_RIGHTS = ['unknown', 'user_supplied', 'open_license'] as const;
export const SEND = ['unknown', 'allowed', 'denied'] as const;
export type License = (typeof LICENSES)[number];
export type SendRight = (typeof SEND)[number];

export interface AssetPolicy { license: License; keep_right: (typeof KEEP_RIGHTS)[number]; external_send: SendRight; decided_by: string; created_at: string }
export interface SourceAsset {
  id: string; paper_id: string; sha256: string; byte_size: number; media_type: string; original_name: string | null; created_at: string;
  source: string; source_url: string | null; reference_id: string | null; page_count: number | null; inspected_with: string; policy: AssetPolicy;
}

const oneOf = <T extends string>(v: unknown, list: readonly T[], field: string, dflt?: T): T => {
  if ((v === undefined || v === null || v === '') && dflt !== undefined) return dflt;
  if (!list.includes(v as T)) throw new DomainError('INVALID', `${field} must be one of ${list.join(', ')}`, field);
  return v as T;
};
export function policyInput(b: { license?: unknown; keep_right?: unknown; external_send?: unknown }, dflt: { keep_right: AssetPolicy['keep_right'] }) {
  return {
    license: oneOf(b.license, LICENSES, 'license', 'unknown'),
    keep_right: oneOf(b.keep_right, KEEP_RIGHTS, 'keep_right', dflt.keep_right),
    // uploading a file is not consent to send it to a third party: unknown unless the owner says so
    external_send: oneOf(b.external_send, SEND, 'external_send', 'unknown'),
  };
}

const ASSET_COLUMNS = `a.id, a.paper_id, a.sha256, a.byte_size::float8 AS byte_size, a.media_type, a.original_name, a.created_at, s.source, s.source_url, s.reference_id, s.page_count, s.inspected_with,
  json_build_object('license', p.license, 'keep_right', p.keep_right, 'external_send', p.external_send, 'decided_by', p.decided_by, 'created_at', p.created_at) AS policy`;
const ASSET_FROM = `FROM asset_revisions a JOIN asset_sources s ON s.asset_revision_id = a.id
  JOIN LATERAL (SELECT * FROM asset_policy_revisions q WHERE q.asset_revision_id = a.id ORDER BY q.created_at DESC, q.id DESC LIMIT 1) p ON true`;

// source PDFs only (figure files are figure/table versions, PW-036)
export async function listSourceAssets(db: Queryable, paperId: string): Promise<SourceAsset[]> {
  return (await db.query<SourceAsset>(`SELECT ${ASSET_COLUMNS} ${ASSET_FROM} WHERE a.paper_id = $1 AND s.kind = 'source_pdf' ORDER BY a.created_at, a.id`, [paperId])).rows;
}
export async function getSourceAsset(db: Queryable, paperId: string, id: string): Promise<SourceAsset | null> {
  if (!UUID_RE.test(id)) return null;
  return (await db.query<SourceAsset>(`SELECT ${ASSET_COLUMNS} ${ASSET_FROM} WHERE a.paper_id = $1 AND a.id = $2 AND s.kind = 'source_pdf'`, [paperId, id])).rows[0] ?? null;
}

// Stores the record of an inspected original whose bytes are already in the content-addressed store.
// The same bytes in the same paper are the same asset (idempotent).
export async function recordSourceAsset(pool: TxPool, a: {
  paperId: string; ownerId: string; sha256: string; byteSize: number; pages: number; originalName: string; source: 'user_upload' | 'open_access_fetch';
  sourceUrl: string | null; referenceId: unknown; policy: { license: License; keep_right: AssetPolicy['keep_right']; external_send: SendRight };
}): Promise<{ asset: SourceAsset; created: boolean }> {
  if (!/^[0-9a-f]{64}$/.test(a.sha256)) throw new DomainError('INVALID', 'bad content hash');
  const referenceId = a.referenceId === undefined || a.referenceId === null || a.referenceId === '' ? null : String(a.referenceId);
  if (referenceId !== null && !UUID_RE.test(referenceId)) throw new DomainError('INVALID', 'reference_id must be a reference id', 'reference_id');
  return inTransaction(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`asset:${a.paperId}:${a.sha256}`]);
    const existing = (await tx.query<{ id: string }>("SELECT a.id FROM asset_revisions a JOIN asset_sources s ON s.asset_revision_id = a.id WHERE a.paper_id = $1 AND a.sha256 = $2 AND s.kind = 'source_pdf'", [a.paperId, a.sha256])).rows[0];
    if (existing) return { asset: (await getSourceAsset(tx, a.paperId, existing.id))!, created: false };
    if (referenceId && !(await tx.query('SELECT 1 FROM project_references WHERE paper_id = $1 AND reference_id = $2 AND removed_at IS NULL', [a.paperId, referenceId])).rowCount) {
      throw new DomainError('NOT_FOUND', 'reference not found in this paper', 'reference_id');
    }
    const id = (await tx.query<{ id: string }>(
      "INSERT INTO asset_revisions (paper_id, asset_key, sha256, byte_size, media_type, original_name, created_by) VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6) RETURNING id",
      [a.paperId, `source-pdf:${a.sha256}`, a.sha256, a.byteSize, a.originalName, a.ownerId])).rows[0]!.id;
    await tx.query(
      "INSERT INTO asset_sources (asset_revision_id, paper_id, owner_id, kind, source, source_url, reference_id, page_count, inspected_with) VALUES ($1, $2, $3, 'source_pdf', $4, $5, $6, $7, $8)",
      [id, a.paperId, a.ownerId, a.source, a.sourceUrl, referenceId, a.pages || null, INSPECTOR_VERSION]);
    await tx.query('INSERT INTO asset_policy_revisions (asset_revision_id, paper_id, license, keep_right, external_send, decided_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, a.paperId, a.policy.license, a.policy.keep_right, a.policy.external_send, a.ownerId]);
    return { asset: (await getSourceAsset(tx, a.paperId, id))!, created: true };
  });
}

// The owner's decision about licence / keeping / sending: a new policy revision (earlier ones stay).
export async function decideAssetPolicy(pool: TxPool, a: { paperId: string; ownerId: string; assetId: string; body: unknown }): Promise<SourceAsset> {
  const cur = await getSourceAsset(pool, a.paperId, a.assetId);
  if (!cur) throw new DomainError('NOT_FOUND', 'asset not found');
  const b = (a.body ?? {}) as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !['license', 'keep_right', 'external_send'].includes(k));
  if (extra.length) throw new DomainError('INVALID', `unknown fields: ${extra.join(', ').slice(0, 100)}`, extra[0]);
  const p = {
    license: oneOf(b.license, LICENSES, 'license', cur.policy.license),
    keep_right: oneOf(b.keep_right, KEEP_RIGHTS, 'keep_right', cur.policy.keep_right),
    external_send: oneOf(b.external_send, SEND, 'external_send', cur.policy.external_send),
  };
  await pool.query('INSERT INTO asset_policy_revisions (asset_revision_id, paper_id, license, keep_right, external_send, decided_by) VALUES ($1, $2, $3, $4, $5, $6)',
    [a.assetId, a.paperId, p.license, p.keep_right, p.external_send, a.ownerId]);
  return (await getSourceAsset(pool, a.paperId, a.assetId))!;
}

// May this original go to this external provider? Every condition must hold; unknown is "no".
export async function externalSendDecision(db: Queryable, a: { paperId: string; assetId: string; provider: string }): Promise<{ allowed: boolean; reasons: string[] }> {
  const paper = (await db.query<{ external_send_policy: string; data_classification: string; allowed_providers: string[] }>(
    'SELECT external_send_policy, data_classification, allowed_providers FROM paper_projects WHERE id = $1', [a.paperId])).rows[0];
  const asset = await getSourceAsset(db, a.paperId, a.assetId);
  const reasons: string[] = [];
  if (!paper || !asset) return { allowed: false, reasons: ['not_found'] };
  if (paper.external_send_policy !== 'allow_selected') reasons.push('paper_blocks_external_send');
  if (paper.data_classification === 'sensitive') reasons.push('paper_is_sensitive');
  if (!paper.allowed_providers.includes(a.provider)) reasons.push('provider_not_allowed_for_paper');
  if (asset.policy.external_send !== 'allowed') reasons.push(asset.policy.external_send === 'denied' ? 'asset_send_denied' : 'asset_send_unknown');
  if (asset.policy.keep_right === 'unknown') reasons.push('asset_keep_right_unknown');
  return { allowed: reasons.length === 0, reasons };
}

// ---- URL fetch policy ----------------------------------------------------------------------
// fixed open-access hosts (full text the publisher or repository serves openly); nothing else
export const OPEN_ACCESS_HOSTS = ['europepmc.org', 'www.ebi.ac.uk', 'www.ncbi.nlm.nih.gov', 'pmc.ncbi.nlm.nih.gov', 'arxiv.org', 'export.arxiv.org'] as const;
export const FETCH_DAILY_CAP = 30;

export type FetchRefusal = 'bad_url' | 'host_not_allowed' | 'internal_address' | 'daily_cap' | 'redirect' | 'not_pdf' | 'http_error' | 'too_large' | 'timeout' | 'network';
export class FetchRefused extends Error {
  readonly reason: FetchRefusal;
  constructor(reason: FetchRefusal, message: string) {
    super(message);
    this.reason = reason;
  }
}

export function checkFetchUrl(raw: unknown, allowHosts: readonly string[] = OPEN_ACCESS_HOSTS): URL {
  if (typeof raw !== 'string' || raw.length > 2000) throw new FetchRefused('bad_url', 'a URL is required');
  let u: URL;
  try { u = new URL(raw); } catch { throw new FetchRefused('bad_url', 'not a URL'); }
  if (u.protocol !== 'https:') throw new FetchRefused('bad_url', 'only https URLs are fetched');
  if (u.username || u.password) throw new FetchRefused('bad_url', 'URLs with credentials are not fetched');
  if (u.port && u.port !== '443') throw new FetchRefused('bad_url', 'only the standard https port is used');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) throw new FetchRefused('host_not_allowed', 'IP addresses are not fetched');
  if (!allowHosts.includes(host)) throw new FetchRefused('host_not_allowed', `only open-access sources are fetched (${allowHosts.join(', ')})`);
  return u;
}

const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64], ['2001::', 32], ['2002::', 16], ['::ffff:0:0:0', 96], ['64:ff9b:1::', 48]] as const) blocked.addSubnet(a, p, 'ipv6');
// is this address one a general URL fetch must never reach? (IPv4 embedded in IPv6 is unwrapped)
export function isInternalAddress(addr: string): boolean {
  const ip = addr.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v = net.isIP(ip);
  if (v === 4) return blocked.check(ip, 'ipv4');
  if (v !== 6) return true;
  const lower = ip.toLowerCase();
  const embedded = /^(?:::ffff:|::ffff:0:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (embedded) return blocked.check(embedded, 'ipv4');
  const hex = /^(?:::ffff:|::ffff:0:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
    return blocked.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), 'ipv4');
  }
  return blocked.check(ip, 'ipv6');
}

// Per-owner daily cap on fetches. An attempt is reserved (and counted) under a per-owner lock before
// any request leaves the server, so concurrent requests cannot all pass the check.
export async function reserveFetchAttempt(pool: TxPool, a: { paperId: string; ownerId: string; url: string; host: string | null; cap?: number }): Promise<void> {
  const cap = a.cap ?? FETCH_DAILY_CAP;
  const refused = await inTransaction(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`fetch-cap:${a.ownerId}`]);
    const n = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM asset_fetches WHERE owner_id = $1 AND outcome = 'attempted' AND attempted_at > clock_timestamp() - interval '24 hours'", [a.ownerId])).rows[0]!.n;
    if (n < cap) {
      await logFetch(tx, { ...a, outcome: 'attempted', assetId: null });
      return false;
    }
    // refusals are recorded, but only the first few per day (a client cannot grow the log without limit)
    const logged = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM asset_fetches WHERE owner_id = $1 AND outcome = 'daily_cap' AND attempted_at > clock_timestamp() - interval '24 hours'", [a.ownerId])).rows[0]!.n;
    if (logged < 10) await logFetch(tx, { ...a, outcome: 'daily_cap', assetId: null });
    return true;
  });
  if (refused) throw new FetchRefused('daily_cap', `at most ${cap} source fetches per day`);
}
export async function logFetch(db: Queryable, a: { paperId: string; ownerId: string; url: string; host: string | null; outcome: string; assetId: string | null }) {
  await db.query('INSERT INTO asset_fetches (paper_id, owner_id, url, host, outcome, asset_revision_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [a.paperId, a.ownerId, a.url.slice(0, 2000), a.host, a.outcome, a.assetId]);
}
