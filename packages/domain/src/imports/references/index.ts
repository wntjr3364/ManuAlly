// Importing references from portable formats into a paper (PW-038, spec 05 "Zotero와 이식성").
// - Each entry gets a stable reference id: a known DOI is the owner's existing work (PW-032); an entry
//   without a DOI is found again only by the same source (file format, or one Zotero library), the same
//   source key (none for a key that is only a position) and the same content, so importing the same file
//   twice gives the same ids, and a citekey reused for another work never attaches that work (review
//   MAJOR). A key seen before with other metadata gives a new work and a warning.
// - The library's metadata of an existing work is never overwritten by an import: a differing entry is
//   reported as "kept_library_metadata". New works get an immutable revision with source "import" (or
//   "zotero"), and the import itself is recorded (format, source hash, per-entry outcome).
// - Nothing is invented: an entry without a title, or a DOI the library does not know (a DOI list
//   carries no metadata), is reported and not created.
import { createHash } from 'node:crypto';
import { DomainError, inTransaction, type TxPool } from '../../shared/db.ts';
import { canonicalJson } from '../../revisions/index.ts';
import { lockLibrary, normalizeDoi, linkPendingRelations } from '../../literature/index.ts';
import { IMPORT_FORMATS, parseReferences, type ImportFormat, type ParsedEntry } from './parse.ts';

export { IMPORT_FORMATS, parseBibtex, parseCslJson, parseDoiList, parseReferences, parseRis, type ImportFormat, type ParsedEntry } from './parse.ts';
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ENTRIES = 2000;

export type ImportStatus = 'created' | 'linked_existing' | 'kept_library_metadata' | 'already_in_paper' | 'invalid' | 'unknown_doi';
// library_title: the title of the library's work the paper gets, when that work already existed
export interface ImportResult { key: string; status: ImportStatus; reference_id: string | null; title: string | null; library_title?: string | null; warnings: string[]; reason?: string }
const SCOPE_RE = /^(file:(csl-json|bibtex|ris|doi-list)|zotero:(user|group):[0-9]{1,12})$/;

export async function importReferences(pool: TxPool, a: { paperId: string; ownerId: string; format: unknown; text: unknown; source?: 'import' | 'zotero'; scope?: string }) {
  if (!IMPORT_FORMATS.includes(a.format as ImportFormat)) throw new DomainError('INVALID', `format must be one of ${IMPORT_FORMATS.join(', ')}`, 'format');
  if (typeof a.text !== 'string' || !a.text.trim()) throw new DomainError('INVALID', 'text is required', 'text');
  if (Buffer.byteLength(a.text) > MAX_IMPORT_BYTES) throw new DomainError('INVALID', `the file is larger than ${MAX_IMPORT_BYTES} bytes`, 'text');
  let entries: ParsedEntry[];
  try {
    entries = parseReferences(a.format as ImportFormat, a.text);
  } catch (e) {
    throw new DomainError('INVALID', `the file could not be read as ${String(a.format)}: ${(e as Error).message}`, 'text');
  }
  if (entries.length > MAX_IMPORT_ENTRIES) throw new DomainError('INVALID', `at most ${MAX_IMPORT_ENTRIES} entries per import`, 'text');
  const source = a.source ?? 'import';
  // where keys mean something: one file format, or one Zotero library
  const scope = a.scope ?? `file:${String(a.format)}`;
  if (!SCOPE_RE.test(scope) || (source === 'zotero') !== scope.startsWith('zotero:')) throw new DomainError('INVALID', 'invalid import scope', 'scope');
  const sourceHash = createHash('sha256').update(a.text).digest('hex');
  return inTransaction(pool, async (tx) => {
    await lockLibrary(tx, a.ownerId);
    const importId = (await tx.query<{ id: string }>('INSERT INTO reference_imports (paper_id, owner_id, format, source, source_hash, entry_count, scope) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [a.paperId, a.ownerId, a.format, source, sourceHash, entries.length, scope])).rows[0]!.id;
    const results: ImportResult[] = [];
    const seenKeys = new Set<string>();
    for (const e of entries) {
      const title = e.csl.title ?? null;
      const record = async (r: ImportResult) => {
        results.push(r);
        await tx.query('INSERT INTO reference_import_items (import_id, position, entry_key, status, reference_id, warnings) VALUES ($1, $2, $3, $4, $5, $6)',
          [importId, results.length, r.key.slice(0, 200), r.status, r.reference_id, r.warnings]);
      };
      if (seenKeys.has(e.key)) { await record({ key: e.key, status: 'invalid', reference_id: null, title, warnings: e.warnings, reason: 'duplicate_key_in_file' }); continue; }
      seenKeys.add(e.key);
      const doi = e.csl.DOI ? normalizeDoi(e.csl.DOI) : null;
      if (e.csl.DOI && !doi) e.warnings.push('doi_not_understood');
      // the stored metadata: the entry as read, with the DOI in its one normalized form (or without one)
      const rest: Omit<ParsedEntry['csl'], 'DOI'> & { DOI?: string } = { ...e.csl };
      delete rest.DOI;
      const cslOut = { ...rest, ...(doi ? { DOI: doi } : {}) };
      const hash = createHash('sha256').update(canonicalJson(cslOut)).digest('hex');
      const identityKey = e.ownKey ? e.key : '';
      let ref: string | null;
      let status: ImportStatus;
      if (doi) {
        ref = (await tx.query<{ reference_id: string }>("SELECT reference_id FROM reference_identifiers WHERE owner_id = $1 AND kind = 'doi' AND value = $2", [a.ownerId, doi])).rows[0]?.reference_id ?? null;
      } else {
        // without a DOI: the same source, key and content only — never the key alone
        ref = (await tx.query<{ reference_id: string }>('SELECT reference_id FROM reference_import_identities WHERE owner_id = $1 AND scope = $2 AND entry_key = $3 AND content_hash = $4',
          [a.ownerId, scope, identityKey, hash])).rows[0]?.reference_id ?? null;
        if (!ref && identityKey && (await tx.query('SELECT 1 FROM reference_import_identities WHERE owner_id = $1 AND scope = $2 AND entry_key = $3 LIMIT 1', [a.ownerId, scope, identityKey])).rowCount) {
          e.warnings.push('source_key_seen_with_other_metadata');
        }
      }
      let libraryTitle: string | null | undefined;
      if (ref) {
        const newest = (await tx.query<{ content_hash: string; title: string | null }>("SELECT content_hash, csl_json->>'title' AS title FROM bibliographic_revisions WHERE reference_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [ref])).rows[0];
        libraryTitle = newest?.title ?? null;
        status = !title || newest?.content_hash === hash ? 'linked_existing' : 'kept_library_metadata';
      } else {
        if (doi && !title) { await record({ key: e.key, status: 'unknown_doi', reference_id: null, title, warnings: e.warnings, reason: 'the library does not know this DOI and the entry has no metadata (not looked up, not invented)' }); continue; }
        if (e.error || !title) { await record({ key: e.key, status: 'invalid', reference_id: null, title, warnings: e.warnings, reason: e.error ?? 'no_title' }); continue; }
        ref = (await tx.query<{ id: string }>('INSERT INTO reference_works (owner_id, doi) VALUES ($1, $2) RETURNING id', [a.ownerId, doi])).rows[0]!.id;
        if (doi) {
          await tx.query("INSERT INTO reference_identifiers (owner_id, reference_id, kind, value) VALUES ($1, $2, 'doi', $3)", [a.ownerId, ref, doi]);
          await linkPendingRelations(tx, a.ownerId, doi, ref);
        } else {
          await tx.query('INSERT INTO reference_import_identities (owner_id, scope, entry_key, content_hash, reference_id) VALUES ($1, $2, $3, $4, $5)', [a.ownerId, scope, identityKey, hash, ref]);
        }
        await tx.query('INSERT INTO bibliographic_revisions (reference_id, csl_json, content_hash, source) VALUES ($1, $2, $3, $4)', [ref, JSON.stringify(cslOut), hash, source]);
        status = 'created';
      }
      const added = await tx.query('INSERT INTO project_references (paper_id, reference_id, owner_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [a.paperId, ref, a.ownerId]);
      if (!added.rowCount && status !== 'created') status = 'already_in_paper';
      await record({ key: e.key, status, reference_id: ref, title, ...(libraryTitle !== undefined ? { library_title: libraryTitle } : {}), warnings: e.warnings });
    }
    return { import_id: importId, format: a.format, source, results };
  });
}
