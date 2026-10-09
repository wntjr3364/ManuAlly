// The owner's reference library from search candidates (PW-032, spec 05 "문헌 선택 실패", 02).
// - Works are merged only by verifiable identifiers: a normalized DOI or a PubMed id, unique per owner.
//   A record carrying both links them; when they already point at two different works, nothing is
//   merged and the conflict is listed for the owner.
// - A similar title (or the same title) never merges: the pair is listed as a possible duplicate.
// - Metadata is versioned: a candidate whose metadata differs from the work's newest revision adds an
//   immutable revision. Citation snapshots pin revisions, so what an earlier snapshot shows never
//   changes.
// - Relations observed at the source (preprint ↔ published, version, correction, retraction, expression
//   of concern) are kept, to the known work or — when that work is not in the library — to its DOI.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@pw/editor-core';
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '../shared/db.ts';

export function normalizeDoi(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, '').toLowerCase();
  return /^10\.\d{4,9}\/\S{1,200}$/.test(v) ? v : null;
}
const normalizePmid = (raw: unknown): string | null => (typeof raw === 'string' && /^[1-9]\d{0,11}$/.test(raw.trim()) ? raw.trim() : null);
// title comparison key: case, punctuation and spacing do not matter
const titleKey = (t: string) => t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

interface CandidateRow {
  id: string; paper_id: string; owner_id: string; source: 'crossref' | 'pubmed'; source_record_id: string; doi: string | null; title: string;
  authors: { family: string; given?: string }[]; year: number | null; container: string | null; work_type: string | null; is_preprint: boolean;
  relations: Record<string, string[]>; update_notice: { type: string; target_doi?: string | null } | null;
}

const CSL_TYPE: Record<string, string> = { 'journal-article': 'article-journal', 'posted-content': 'article', 'proceedings-article': 'paper-conference', 'book-chapter': 'chapter', book: 'book', 'Journal Article': 'article-journal' };
function cslOf(c: CandidateRow): Record<string, unknown> {
  return {
    type: CSL_TYPE[c.work_type ?? ''] ?? 'article',
    title: c.title,
    author: c.authors,
    ...(c.year ? { issued: { 'date-parts': [[c.year]] } } : {}),
    ...(c.container ? { 'container-title': c.container } : {}),
    ...(c.doi ? { DOI: normalizeDoi(c.doi) } : {}),
    ...(c.source === 'pubmed' ? { PMID: c.source_record_id } : {}),
    ...(c.is_preprint ? { genre: 'preprint' } : {}),
  };
}
const hashOf = (csl: unknown) => createHash('sha256').update(canonicalJson(csl)).digest('hex');

// relations a candidate states; update notices about another work point at it by DOI
const NOTICE_TO: Record<string, string> = { retraction: 'retraction_of', correction: 'correction_of', erratum: 'erratum_for', 'expression_of_concern': 'expression_of_concern_for', 'expression-of-concern': 'expression_of_concern_for' };
const FLAG: Record<string, string> = { retracted_publication: 'flagged_retracted', erratum: 'flagged_erratum', expression_of_concern: 'flagged_expression_of_concern' };

export interface IngestResult { reference_id: string; created: boolean; new_version: boolean; conflict: boolean }

export async function ingestCandidate(pool: TxPool, a: { ownerId: string; candidateId: string }): Promise<IngestResult> {
  if (!UUID_RE.test(a.candidateId)) throw new DomainError('NOT_FOUND', 'candidate not found');
  return inTransaction(pool, async (tx) => {
    const c = (await tx.query<CandidateRow>(
      `SELECT c.id, c.paper_id, p.owner_id, c.source, c.source_record_id, c.doi, c.title, c.authors, c.year, c.container, c.work_type, c.is_preprint, c.relations, c.update_notice
       FROM literature_candidates c JOIN paper_projects p ON p.id = c.paper_id WHERE c.id = $1 AND p.owner_id = $2`, [a.candidateId, a.ownerId])).rows[0];
    if (!c) throw new DomainError('NOT_FOUND', 'candidate not found');
    // one ingest at a time per owner: identifiers are claimed consistently
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`library:${a.ownerId}`]);
    const ids: { kind: 'doi' | 'pmid'; value: string }[] = [];
    const doi = normalizeDoi(c.doi);
    if (doi) ids.push({ kind: 'doi', value: doi });
    const pmid = c.source === 'pubmed' ? normalizePmid(c.source_record_id) : null;
    if (pmid) ids.push({ kind: 'pmid', value: pmid });
    const found = new Map<string, string>(); // kind -> reference id
    for (const id of ids) {
      const r = (await tx.query<{ reference_id: string }>('SELECT reference_id FROM reference_identifiers WHERE owner_id = $1 AND kind = $2 AND value = $3', [a.ownerId, id.kind, id.value])).rows[0];
      if (r) found.set(id.kind, r.reference_id);
    }
    const distinct = [...new Set(found.values())];
    let conflict = false;
    let ref: string;
    let created = false;
    if (distinct.length > 1) {
      // the DOI and the PMID name two different works: keep both, ask the owner
      conflict = true;
      ref = found.get('doi')!;
      const [x, y] = distinct.sort();
      await tx.query("INSERT INTO reference_duplicate_questions (owner_id, reference_a, reference_b, reason) VALUES ($1, $2, $3, 'identifier_conflict') ON CONFLICT DO NOTHING", [a.ownerId, x, y]);
    } else if (distinct.length === 1) {
      ref = distinct[0]!;
    } else {
      ref = (await tx.query<{ id: string }>('INSERT INTO reference_works (owner_id, doi) VALUES ($1, $2) RETURNING id', [a.ownerId, doi])).rows[0]!.id;
      created = true;
    }
    // identifiers not yet known are attached to this work (never moved from another work)
    for (const id of ids) if (!found.has(id.kind)) await tx.query('INSERT INTO reference_identifiers (owner_id, reference_id, kind, value) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [a.ownerId, ref, id.kind, id.value]);

    // metadata: a new version only when it differs from the newest one
    const csl = cslOf(c);
    const hash = hashOf(csl);
    const newest = (await tx.query<{ content_hash: string }>('SELECT content_hash FROM bibliographic_revisions WHERE reference_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [ref])).rows[0];
    const newVersion = !newest || newest.content_hash !== hash;
    if (newVersion) {
      await tx.query('INSERT INTO bibliographic_revisions (reference_id, csl_json, content_hash, source, source_candidate_id) VALUES ($1, $2, $3, $4, $5)', [ref, JSON.stringify(csl), hash, c.source, c.id]);
    }

    // relations
    const relate = async (relation: string, toDoi: string | null) => {
      const to = toDoi ? (await tx.query<{ reference_id: string }>("SELECT reference_id FROM reference_identifiers WHERE owner_id = $1 AND kind = 'doi' AND value = $2", [a.ownerId, toDoi])).rows[0]?.reference_id ?? null : null;
      await tx.query(
        `INSERT INTO reference_relations (owner_id, from_reference_id, relation, to_reference_id, to_doi, source, source_candidate_id) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`, [a.ownerId, ref, relation, to, toDoi, c.source, c.id]);
    };
    for (const [k, dois] of Object.entries(c.relations ?? {})) {
      if (!['is_preprint_of', 'has_preprint', 'is_version_of', 'has_version'].includes(k)) continue;
      for (const d of dois) { const n = normalizeDoi(d); if (n) await relate(k, n); }
    }
    if (c.update_notice) {
      const t = String(c.update_notice.type).toLowerCase();
      if (FLAG[t]) await relate(FLAG[t]!, null);
      else await relate(NOTICE_TO[t] ?? 'update_of', normalizeDoi(c.update_notice.target_doi ?? null));
    }
    // works that pointed at this DOI before it was in the library now point at the work too
    if (doi) {
      await tx.query(
        `INSERT INTO reference_relations (owner_id, from_reference_id, relation, to_reference_id, to_doi, source, source_candidate_id)
         SELECT owner_id, from_reference_id, relation, $3, to_doi, source, source_candidate_id FROM reference_relations
         WHERE owner_id = $1 AND to_doi = $2 AND to_reference_id IS NULL ON CONFLICT DO NOTHING`, [a.ownerId, doi, ref]);
    }

    // a similar title among the owner's other works: listed, never merged
    if (created) {
      const key = titleKey(c.title);
      const others = (await tx.query<{ id: string; title: string; year: string | null }>(
        `SELECT DISTINCT ON (w.id) w.id, b.csl_json->>'title' AS title, b.csl_json#>>'{issued,date-parts,0,0}' AS year
         FROM reference_works w JOIN bibliographic_revisions b ON b.reference_id = w.id WHERE w.owner_id = $1 AND w.id <> $2 ORDER BY w.id, b.created_at DESC`, [a.ownerId, ref])).rows;
      for (const o of others) {
        if (titleKey(o.title ?? '') !== key) continue;
        const [x, y] = [ref, o.id].sort();
        await tx.query("INSERT INTO reference_duplicate_questions (owner_id, reference_a, reference_b, reason) VALUES ($1, $2, $3, 'similar_title') ON CONFLICT DO NOTHING", [a.ownerId, x, y]);
      }
    }
    return { reference_id: ref, created, new_version: newVersion, conflict };
  });
}

export async function referenceIdentifiers(db: Queryable, ownerId: string, referenceId: string) {
  return (await db.query<{ kind: string; value: string }>('SELECT kind, value FROM reference_identifiers WHERE owner_id = $1 AND reference_id = $2 ORDER BY kind, value', [ownerId, referenceId])).rows;
}

export async function relationsOf(db: Queryable, ownerId: string, referenceId: string) {
  return (await db.query<{ relation: string; to_reference_id: string | null; to_doi: string | null; source: string; observed_at: string }>(
    // the newest statement per relation and target (a resolved one supersedes its DOI-only form)
    `SELECT DISTINCT ON (relation, coalesce(to_doi, to_reference_id::text, '')) relation, to_reference_id, to_doi, source, observed_at FROM reference_relations
     WHERE owner_id = $1 AND from_reference_id = $2 ORDER BY relation, coalesce(to_doi, to_reference_id::text, ''), (to_reference_id IS NULL), observed_at DESC`, [ownerId, referenceId])).rows;
}

export interface DuplicateQuestion { id: string; reference_a: string; reference_b: string; reason: string; status: string; created_at: string }
export async function possibleDuplicates(db: Queryable, ownerId: string): Promise<DuplicateQuestion[]> {
  return (await db.query<DuplicateQuestion>('SELECT id, reference_a, reference_b, reason, status, created_at FROM reference_duplicate_questions WHERE owner_id = $1 ORDER BY created_at, id', [ownerId])).rows;
}

// The owner's answer. "same" records the judgement only; joining two works into one is a later,
// explicit operation (citations keep their stable ids either way).
export async function resolveDuplicate(db: Queryable, a: { ownerId: string; id: string; decision: 'distinct' | 'same' }): Promise<void> {
  if (!['distinct', 'same'].includes(a.decision)) throw new DomainError('INVALID', 'decision must be distinct or same', 'decision');
  if (!UUID_RE.test(a.id)) throw new DomainError('NOT_FOUND', 'question not found');
  const r = await db.query("UPDATE reference_duplicate_questions SET status = $3, decided_at = clock_timestamp() WHERE id = $1 AND owner_id = $2 AND status = 'open'", [a.id, a.ownerId, a.decision]);
  if (!r.rowCount) throw new DomainError('NOT_FOUND', 'question not found or already decided');
}
