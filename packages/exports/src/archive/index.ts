// The reproducible source archive (PW-057, spec 10 "v1 export 3"). buildArchive(): a named snapshot's data →
// a ZIP with manifest.json first, then every file in path order: the snapshot's documents (editor JSON with
// its schema version), the story and outline it pins, its reference revisions as CSL-JSON and BibTeX, the
// figures with their captions as of the snapshot, the selected writing profile and the AI-assistance audit,
// the originals the purpose allows, and outputs/manuscript.docx rendered from those very files. The manifest
// names each file's SHA-256, size and role, the versions of everything that made it, and every original left
// out (hash and reason) or missing from the store. A missing or damaged blob makes the archive 'incomplete';
// it is never shown as complete.
// verifyArchive(): needs nothing but the archive. Every listed file must be there with its hash and size, no
// other file may be, the references must be the snapshot's revisions, and the DOCX is rendered again from the
// archive's own manuscript, references and figures and must come out byte for byte the same. A share bundle
// may hold only originals with a shareable licence. (The references are checked against the manifest's list:
// consistency inside the archive, not proof against the database.)
// A share bundle (purpose 'share', for co-authors, a journal or a repository) carries only originals whose
// licence allows passing them on; the owner's private copy carries them all.
import { createHash } from 'node:crypto';
import type { CitationStyle, RefMeta } from '@pw/editor-core';
import { openZip, type Zip } from '@pw/domain/imports/docx/zip.ts';
import { writeZip } from '../docx/zip.ts';
import { renderDocx, RENDERER_VERSION, type FigureIn } from '../docx/index.ts';

export const ARCHIVE_FORMAT = 'pw-source-archive-1';
// limits for reading an archive back (originals can be large; still bounded)
export const ARCHIVE_ZIP_LIMITS = { entries: 5000, totalUnpacked: 2 * 1024 * 1024 * 1024, part: 1024 * 1024 * 1024 };
export const SHAREABLE_LICENCES = ['own-work', 'cc0', 'public-domain', 'cc-by', 'cc-by-sa'] as const;
export const shareable = (licence: string) => (SHAREABLE_LICENCES as readonly string[]).includes(licence);

export type ArchivePurpose = 'share' | 'private';
export interface ArchiveAsset {
  asset_revision_id: string; kind: string; sha256: string; byte_size: number; media_type: string; original_name: string | null;
  license: string; keep_right: string; source_url?: string | null;
  bytes: Buffer | null; // null: not read (left out) or not readable from the store
  store_error?: 'missing' | 'damaged';
}
export interface ArchiveReference { reference_id: string; bibliographic_revision_id: string; csl: Record<string, unknown> }
export interface ArchiveDocument { document_id: string; kind: string; revision_id: string; schema_version: number; content: unknown }
export interface ArchiveInput {
  purpose: ArchivePurpose; createdAt: string;
  paper: { id: string; title: string };
  snapshot: { id: string; label: string; created_at: string; story_revision_id: string | null; outline_revision_id: string | null; citation_style: string; style_version: string };
  documents: ArchiveDocument[];
  story: unknown; outline: unknown;
  references: ArchiveReference[];
  figures: FigureIn[];
  assets: ArchiveAsset[];
  retracted?: readonly string[];
  profile: unknown; aiAudit: unknown;
}
export interface ManifestFile { path: string; sha256: string; bytes: number; role: string; asset_revision_id?: string; license?: string; original_name?: string | null }
export interface LeftOut { asset_revision_id: string; kind: string; sha256: string; byte_size: number; original_name: string | null; license: string; reason: string }
export interface Manifest {
  format: typeof ARCHIVE_FORMAT; purpose: ArchivePurpose; created_at: string; status: 'complete' | 'incomplete'; problems: string[];
  paper: { id: string; title: string }; snapshot: ArchiveInput['snapshot'];
  versions: { archive: string; docx_renderer: string; citation_style: string };
  references: { reference_id: string; bibliographic_revision_id: string }[];
  render: { document_id: string; revision_id: string; style: string; retracted: string[] } | null;
  files: ManifestFile[]; excluded: LeftOut[]; missing: LeftOut[];
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const json = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`, 'utf8');
const byKey = <T>(k: (x: T) => string) => (a: T, b: T) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0);

// the reference as the renderer sees it, from its stored CSL-JSON (as the references module reads it)
export function refMeta(id: string, c: Record<string, unknown>): RefMeta {
  const issued = (c.issued as { 'date-parts'?: unknown[][] } | undefined)?.['date-parts']?.[0]?.[0];
  const authors = Array.isArray(c.author) ? (c.author as RefMeta['authors']) : [];
  return { id, title: String(c.title ?? ''), authors, year: typeof issued === 'number' ? issued : null, container: typeof c['container-title'] === 'string' ? c['container-title'] : null, doi: typeof c.DOI === 'string' ? c.DOI : null };
}

// BibTeX for the references (a plain export for LaTeX users; the CSL-JSON is the record)
const BIB_TYPE: Record<string, string> = { 'article-journal': 'article', article: 'article', book: 'book', chapter: 'incollection', 'paper-conference': 'inproceedings', thesis: 'phdthesis', report: 'techreport' };
// eslint-disable-next-line no-control-regex -- control characters are removed on purpose
const tex = (s: string) => s.replace(/[\\{}]/g, (c) => (c === '\\' ? '\\textbackslash{}' : `\\${c}`)).replace(/[&%$#_]/g, (c) => `\\${c}`).replace(/[\u0000-\u001f]/g, ' ');
// eslint-disable-next-line no-control-regex -- control characters are removed on purpose
const verbatim = (s: string) => s.replace(/[{}\\\u0000-\u001f]/g, '');
export function bibtex(refs: readonly ArchiveReference[]): string {
  const used = new Map<string, number>();
  return refs.map((r) => {
    const c = r.csl;
    const m = refMeta(r.reference_id, c);
    const base = `${(m.authors[0]?.family ?? 'anon').normalize('NFKD').replace(/[^A-Za-z0-9]/g, '') || 'ref'}${m.year ?? 'nd'}`;
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    const key = n ? `${base}${String.fromCharCode(96 + n)}` : base;
    const fields: [string, string][] = [];
    if (m.authors.length) fields.push(['author', m.authors.map((a) => tex(a.given ? `${a.family}, ${a.given}` : a.family)).join(' and ')]);
    if (m.title) fields.push(['title', tex(m.title)]);
    if (m.container) fields.push([c.type === 'article-journal' || c.type === 'article' ? 'journal' : 'booktitle', tex(m.container)]);
    if (m.year !== null) fields.push(['year', String(m.year)]);
    for (const [csl, bib] of [['volume', 'volume'], ['issue', 'number'], ['page', 'pages'], ['publisher', 'publisher']] as const) if (typeof c[csl] === 'string' || typeof c[csl] === 'number') fields.push([bib, tex(String(c[csl]))]);
    if (m.doi) fields.push(['doi', verbatim(m.doi)]);
    if (typeof c.URL === 'string') fields.push(['url', verbatim(c.URL)]);
    fields.push(['note', `pw:${r.reference_id} rev ${r.bibliographic_revision_id}`]);
    return `@${BIB_TYPE[String(c.type)] ?? 'misc'}{${key},\n${fields.map(([k, v]) => `  ${k} = {${v}}`).join(',\n')}\n}\n`;
  }).join('\n');
}

function render(doc: unknown, refs: readonly ArchiveReference[], figures: readonly FigureIn[], style: string, retracted: readonly string[]) {
  return renderDocx({ doc, refs: refs.map((r) => refMeta(r.reference_id, r.csl)), figures, style: style as CitationStyle, retracted: new Set(retracted) });
}

export function buildArchive(a: ArchiveInput): { bytes: Buffer; manifest: Manifest } {
  const files = new Map<string, { bytes: Buffer; role: string; extra?: Partial<ManifestFile> }>();
  const problems: string[] = [];
  const references = [...a.references].sort(byKey<ArchiveReference>((r) => r.reference_id));
  const documents = [...a.documents].sort(byKey<ArchiveDocument>((d) => d.document_id));
  for (const d of documents) files.set(`documents/${d.document_id}.json`, { bytes: json(d), role: 'document' });
  files.set('story.json', { bytes: json(a.story), role: 'story' });
  files.set('outline.json', { bytes: json(a.outline), role: 'outline' });
  files.set('references.csl.json', { bytes: json(references.map((r) => ({ ...r.csl, id: r.reference_id, 'pw:bibliographic_revision_id': r.bibliographic_revision_id }))), role: 'references' });
  files.set('references.bib', { bytes: Buffer.from(bibtex(references), 'utf8'), role: 'references_bibtex' });
  files.set('figures.json', { bytes: json(a.figures), role: 'figures' });
  files.set('profile.json', { bytes: json(a.profile ?? null), role: 'writing_profile' });
  files.set('ai-assistance.json', { bytes: json(a.aiAudit ?? []), role: 'ai_assistance_audit' });

  const excluded: LeftOut[] = [];
  const missing: LeftOut[] = [];
  const leftOut = (x: ArchiveAsset, reason: string): LeftOut => ({ asset_revision_id: x.asset_revision_id, kind: x.kind, sha256: x.sha256, byte_size: x.byte_size, original_name: x.original_name, license: x.license, reason });
  // the same bytes recorded twice with licences that disagree: a share bundle leaves them out altogether
  const notShareable = new Set(a.assets.filter((x) => !shareable(x.license)).map((x) => x.sha256));
  for (const x of [...a.assets].sort(byKey<ArchiveAsset>((x) => x.asset_revision_id))) {
    if (a.purpose === 'share' && !shareable(x.license)) { excluded.push(leftOut(x, x.license === 'unknown' ? 'licence_unknown' : 'licence_does_not_allow_sharing')); continue; }
    if (a.purpose === 'share' && notShareable.has(x.sha256)) { excluded.push(leftOut(x, 'licence_conflict')); continue; }
    const path = `assets/${x.sha256}`;
    if (files.has(path)) continue; // the same bytes as another asset revision: stored once
    if (!x.bytes) { missing.push(leftOut(x, x.store_error === 'damaged' ? 'damaged_in_store' : 'missing_in_store')); continue; }
    if (x.bytes.length !== x.byte_size || sha(x.bytes) !== x.sha256) { missing.push(leftOut(x, 'hash_mismatch')); continue; }
    files.set(path, { bytes: x.bytes, role: 'asset', extra: { asset_revision_id: x.asset_revision_id, license: x.license, original_name: x.original_name } });
  }
  for (const m of missing) problems.push(`original ${m.sha256} (${m.original_name ?? m.asset_revision_id}) is ${m.reason === 'missing_in_store' ? 'missing from the store' : 'damaged in the store'}`);

  const manuscript = documents.find((d) => d.kind === 'manuscript') ?? null;
  const retracted = [...(a.retracted ?? [])].sort();
  if (manuscript) {
    const out = render(manuscript.content, references, a.figures, a.snapshot.citation_style, retracted);
    files.set('outputs/manuscript.docx', { bytes: out.bytes, role: 'output_docx' });
    files.set('outputs/manuscript.docx.report.json', { bytes: json(out.report), role: 'output_report' });
  }

  const listed: ManifestFile[] = [...files.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([path, f]) => ({ path, sha256: sha(f.bytes), bytes: f.bytes.length, role: f.role, ...f.extra }));
  const manifest: Manifest = {
    format: ARCHIVE_FORMAT, purpose: a.purpose, created_at: a.createdAt, status: missing.length ? 'incomplete' : 'complete', problems,
    paper: a.paper, snapshot: a.snapshot,
    versions: { archive: ARCHIVE_FORMAT, docx_renderer: RENDERER_VERSION, citation_style: a.snapshot.style_version },
    references: references.map((r) => ({ reference_id: r.reference_id, bibliographic_revision_id: r.bibliographic_revision_id })),
    render: manuscript ? { document_id: manuscript.document_id, revision_id: manuscript.revision_id, style: a.snapshot.citation_style, retracted } : null,
    files: listed, excluded, missing,
  };
  const bytes = writeZip([['manifest.json', json(manifest)], ...listed.map((f): [string, Buffer] => [f.path, files.get(f.path)!.bytes])]);
  return { bytes, manifest };
}

export interface Verification { ok: boolean; status: 'complete' | 'incomplete' | 'invalid'; problems: string[]; reproduced: boolean | null; manifest: Manifest | null }

// the number of entries the central directory declares (a name used twice would hide one of them)
function declaredEntries(buf: Buffer): number {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === 0x06054b50) return buf.readUInt16LE(i + 10);
  return -1;
}
const safePath = (p: string) => /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p) && !p.split('/').some((s) => s === '.' || s === '..');

export function verifyArchive(bytes: Buffer): Verification {
  const problems: string[] = [];
  const fail = (manifest: Manifest | null = null): Verification => ({ ok: false, status: manifest?.status === 'incomplete' ? 'incomplete' : 'invalid', problems, reproduced: null, manifest });
  let zip: Zip;
  try {
    zip = openZip(bytes, ARCHIVE_ZIP_LIMITS);
  } catch (e) {
    problems.push(`not a readable archive: ${e instanceof Error ? e.message : String(e)}`);
    return fail();
  }
  if (declaredEntries(bytes) !== zip.names.length) problems.push('the archive lists a file name more than once');
  let manifest: Manifest;
  try {
    const raw = zip.read('manifest.json');
    if (!raw) { problems.push('manifest.json is missing'); return fail(); }
    manifest = JSON.parse(raw.toString('utf8')) as Manifest;
    if (manifest?.format !== ARCHIVE_FORMAT || !Array.isArray(manifest.files) || !Array.isArray(manifest.excluded) || !Array.isArray(manifest.missing) || !Array.isArray(manifest.references)) throw new Error(`not a ${ARCHIVE_FORMAT} manifest`);
  } catch (e) {
    problems.push(`manifest.json: ${e instanceof Error ? e.message : String(e)}`);
    return fail();
  }
  // every listed file, with its hash and size
  const read = new Map<string, Buffer>();
  for (const f of manifest.files) {
    if (typeof f?.path !== 'string' || !safePath(f.path) || f.path === 'manifest.json') { problems.push(`an unsafe or reserved path in the manifest: ${JSON.stringify(f?.path)}`); continue; }
    let b: Buffer | null;
    try { b = zip.read(f.path); } catch (e) { problems.push(`${f.path}: ${e instanceof Error ? e.message : String(e)}`); continue; }
    if (!b) { problems.push(`${f.path} is listed but not in the archive`); continue; }
    if (b.length !== f.bytes || sha(b) !== f.sha256) { problems.push(`${f.path} does not match its recorded hash or size`); continue; }
    read.set(f.path, b);
  }
  // nothing else
  const listed = new Set(manifest.files.map((f) => f?.path));
  for (const n of zip.names) if (n !== 'manifest.json' && !listed.has(n)) problems.push(`${n} is in the archive but not in the manifest`);
  // what the manifest says was left out is not in it
  for (const x of manifest.excluded) if (zip.names.includes(`assets/${x?.sha256}`)) problems.push(`assets/${x?.sha256} is listed as left out but is in the archive`);
  // what each document is: an archive holding a manuscript or an output must say how the output was made
  // (review M1: a manifest without `render` must not skip the re-render)
  const kinds = new Map<string, string>();
  for (const [p, b] of read) {
    if (!p.startsWith('documents/')) continue;
    try { kinds.set(p, String((JSON.parse(b.toString('utf8')) as ArchiveDocument).kind)); } catch { problems.push(`${p} is not a valid document file`); }
  }
  const hasOutput = manifest.files.some((f) => typeof f?.path === 'string' && f.path.startsWith('outputs/'));
  const hasManuscript = [...kinds.values()].includes('manuscript');
  if (!manifest.render && (hasOutput || hasManuscript)) problems.push('the manifest does not say how its output was made (render is missing) although the archive holds a manuscript or an output');
  if (manifest.render && kinds.get(`documents/${manifest.render.document_id}.json`) !== 'manuscript') problems.push('the rendered document is not a manuscript listed in the archive');
  // a share bundle carries only originals whose licence allows passing them on (review m1), each stored
  // under its own hash
  for (const f of manifest.files) {
    if (typeof f?.path !== 'string' || !f.path.startsWith('assets/')) continue;
    if (f.role !== 'asset' || f.path !== `assets/${f.sha256}`) problems.push(`${f.path} is not stored under its own hash as an original`);
    if (manifest.purpose !== 'private' && !shareable(String(f.license))) problems.push(`${f.path} (licence ${f.license ?? 'none'}) is in a ${manifest.purpose} archive but its licence does not allow sharing`);
  }
  if (manifest.purpose !== 'share' && manifest.purpose !== 'private') problems.push(`unknown purpose ${JSON.stringify(manifest.purpose)}`);
  // the references agree with the manifest's list of reference revisions (consistency inside the archive;
  // which revisions a snapshot pinned is known only to the database that made it)
  const csl = read.get('references.csl.json');
  let refs: ArchiveReference[] = [];
  if (csl) {
    try {
      const items = JSON.parse(csl.toString('utf8')) as Record<string, unknown>[];
      refs = items.map((c) => {
        const { id, 'pw:bibliographic_revision_id': rev, ...rest } = c;
        return { reference_id: String(id), bibliographic_revision_id: String(rev), csl: rest };
      });
      const want = JSON.stringify(manifest.references.map((r) => [r.reference_id, r.bibliographic_revision_id]));
      if (JSON.stringify(refs.map((r) => [r.reference_id, r.bibliographic_revision_id])) !== want) problems.push('references.csl.json does not match the reference revisions the manifest lists');
    } catch { problems.push('references.csl.json is not valid CSL-JSON'); }
  }
  // the output, rendered again from the archive's own files
  let reproduced: boolean | null = null;
  if (manifest.render) {
    const docFile = read.get(`documents/${manifest.render.document_id}.json`);
    const figs = read.get('figures.json');
    const docx = read.get('outputs/manuscript.docx');
    const report = read.get('outputs/manuscript.docx.report.json');
    if (docFile && figs && docx && report && csl) {
      try {
        const d = JSON.parse(docFile.toString('utf8')) as ArchiveDocument;
        if (d.revision_id !== manifest.render.revision_id) throw new Error('the rendered document is not the snapshot\'s revision');
        const out = render(d.content, refs, JSON.parse(figs.toString('utf8')) as FigureIn[], manifest.render.style, manifest.render.retracted ?? []);
        reproduced = sha(out.bytes) === sha(docx) && json(out.report).equals(report);
        if (!reproduced) problems.push('outputs/manuscript.docx is not what the archive\'s manuscript, references and figures render to');
      } catch (e) {
        reproduced = false;
        problems.push(`the output could not be rendered again: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else problems.push('the files needed to render the output again are missing');
  }
  if (manifest.status !== 'complete' || manifest.missing.length) problems.push(...(manifest.missing.length ? manifest.missing.map((m) => `original ${m?.sha256} was missing when the archive was made (${m?.reason})`) : ['the archive was made incomplete']));
  const ok = problems.length === 0;
  return { ok, status: manifest.status === 'incomplete' || manifest.missing.length ? 'incomplete' : ok ? 'complete' : 'invalid', problems, reproduced, manifest };
}
