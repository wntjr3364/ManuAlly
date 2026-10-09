// References, figures and the citation style of a paper (PW-019). A reference is created only from
// structured fields entered by the owner (title, authors, year, container, DOI) — never from free
// bibliography text and never by an AI job; its CSL-JSON revision is immutable. Labels, numbers and
// the bibliography are computed from these records (editor-core references).
import { createHash } from 'node:crypto';
import { CITATION_STYLES, bibliography, canonicalJson, citationLabels, figureLabels, referenceOccurrences, type CitationStyle, type FigureMeta, type RefMeta } from '@pw/editor-core';
import { DomainError, UUID_RE, inTransaction, storable, type Queryable, type TxPool } from '../shared/db.ts';
import { lockLibrary, normalizeDoi, workForDoi } from '../literature/index.ts';

const text = (v: unknown, field: string, max: number, required = true): string | null => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new DomainError('INVALID', `${field} is required`, field);
    return null;
  }
  if (typeof v !== 'string' || !v.trim() || v.length > max || !storable(v)) throw new DomainError('INVALID', `${field} must be text up to ${max} characters`, field);
  return v.trim();
};
const DOI_RE = /^10\.\d{4,9}\/\S{1,200}$/;
const REFERENCE_FIELDS = ['title', 'authors', 'year', 'container', 'doi'];

export interface Reference extends RefMeta { added_at: string }

export async function createReference(pool: TxPool, a: { paperId: string; ownerId: string; body: unknown }): Promise<Reference> {
  const b = (a.body ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !REFERENCE_FIELDS.includes(k));
  if (unknown.length) throw new DomainError('INVALID', `unknown fields: ${unknown.join(', ')} (a reference is entered as structured fields, not as bibliography text)`, unknown[0]);
  const title = text(b.title, 'title', 1000)!;
  if (!Array.isArray(b.authors) || b.authors.length > 200) throw new DomainError('INVALID', 'authors must be a list of { family, given? }', 'authors');
  const authors = b.authors.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    if (Object.keys(o).some((k) => k !== 'family' && k !== 'given')) throw new DomainError('INVALID', `authors[${i}] has unknown fields`, 'authors');
    const family = text(o.family, `authors[${i}].family`, 200)!;
    const given = text(o.given, `authors[${i}].given`, 200, false);
    return given ? { family, given } : { family };
  });
  if (b.year !== undefined && b.year !== null && !(Number.isInteger(b.year) && (b.year as number) >= 1500 && (b.year as number) <= 2100)) throw new DomainError('INVALID', 'year must be a whole year or null', 'year');
  const container = text(b.container, 'container', 500, false);
  const entered = text(b.doi, 'doi', 220, false);
  if (entered && !DOI_RE.test(entered)) throw new DomainError('INVALID', 'doi must look like 10.1234/xyz (without https://doi.org/)', 'doi');
  // DOIs are case-insensitive: one form, the library's (PW-032)
  const doi = entered ? normalizeDoi(entered) : null;
  if (entered && !doi) throw new DomainError('INVALID', 'doi must look like 10.1234/xyz (without https://doi.org/)', 'doi');
  const csl = { type: 'article-journal', title, author: authors, ...(b.year ? { issued: { 'date-parts': [[b.year]] } } : {}), ...(container ? { 'container-title': container } : {}), ...(doi ? { DOI: doi } : {}) };
  return inTransaction(pool, async (tx) => {
    // a DOI names one work in the owner's library (PW-032): a manual entry of a known DOI is that work,
    // and its metadata becomes a new version only if the work never had it
    let ref: { id: string };
    const hash = createHash('sha256').update(canonicalJson(csl)).digest('hex');
    if (doi) {
      await lockLibrary(tx, a.ownerId);
      ref = { id: (await workForDoi(tx, a.ownerId, doi)).reference_id };
      if ((await tx.query('SELECT 1 FROM project_references WHERE paper_id = $1 AND reference_id = $2', [a.paperId, ref.id])).rowCount) {
        throw new DomainError('CONFLICT', 'this work (same DOI) is already in the paper\'s references');
      }
    } else {
      ref = (await tx.query<{ id: string }>('INSERT INTO reference_works (owner_id, doi) VALUES ($1, NULL) RETURNING id', [a.ownerId])).rows[0]!;
    }
    if (!(await tx.query('SELECT 1 FROM bibliographic_revisions WHERE reference_id = $1 AND content_hash = $2', [ref.id, hash])).rowCount) {
      await tx.query("INSERT INTO bibliographic_revisions (reference_id, csl_json, content_hash, source) VALUES ($1, $2, $3, 'manual')", [ref.id, JSON.stringify(csl), hash]);
    }
    const pr = (await tx.query<{ added_at: string }>('INSERT INTO project_references (paper_id, reference_id, owner_id) VALUES ($1, $2, $3) RETURNING added_at', [a.paperId, ref.id, a.ownerId])).rows[0]!;
    return { id: ref.id, title, authors, year: (b.year as number | undefined) ?? null, container, doi, added_at: pr.added_at };
  });
}

// references of the paper (not removed), from their newest bibliographic revision
export async function listReferences(db: Queryable, paperId: string): Promise<Reference[]> {
  const { rows } = await db.query<{ id: string; csl_json: Record<string, unknown>; added_at: string }>(
    `SELECT DISTINCT ON (pr.reference_id) pr.reference_id AS id, b.csl_json, pr.added_at
     FROM project_references pr JOIN bibliographic_revisions b ON b.reference_id = pr.reference_id
     WHERE pr.paper_id = $1 AND pr.removed_at IS NULL ORDER BY pr.reference_id, b.created_at DESC, b.id DESC`, [paperId]);
  return rows.map((r) => {
    const c = r.csl_json;
    const issued = (c.issued as { 'date-parts'?: number[][] } | undefined)?.['date-parts']?.[0]?.[0];
    return { id: r.id, title: String(c.title ?? ''), authors: (c.author as RefMeta['authors'] | undefined) ?? [], year: typeof issued === 'number' ? issued : null, container: (c['container-title'] as string | undefined) ?? null, doi: (c.DOI as string | undefined) ?? null, added_at: r.added_at };
  }).sort((x, y) => (x.added_at < y.added_at ? -1 : x.added_at > y.added_at ? 1 : x.id < y.id ? -1 : 1));
}

export interface Figure extends FigureMeta { created_at: string }
const FIG = 'id, kind, title, position, created_at';

export async function listFigures(db: Queryable, paperId: string): Promise<Figure[]> {
  return (await db.query<Figure>(`SELECT ${FIG} FROM figure_objects WHERE paper_id = $1 AND archived_at IS NULL ORDER BY kind, position`, [paperId])).rows;
}

export async function createFigure(pool: TxPool, a: { paperId: string; ownerId: string; kind: unknown; title: unknown }): Promise<Figure> {
  if (a.kind !== 'figure' && a.kind !== 'table') throw new DomainError('INVALID', 'kind must be figure or table', 'kind');
  const title = text(a.title, 'title', 500)!;
  return inTransaction(pool, async (tx) => {
    await tx.query('SELECT 1 FROM paper_projects WHERE id = $1 FOR UPDATE', [a.paperId]);
    const { rows } = await tx.query<Figure>(
      `INSERT INTO figure_objects (paper_id, kind, title, position, created_by)
       SELECT $1, $2, $3, coalesce(max(position), 0) + 1, $4 FROM figure_objects WHERE paper_id = $1 AND kind = $2 AND archived_at IS NULL
       RETURNING ${FIG}`, [a.paperId, a.kind, title, a.ownerId]);
    return rows[0]!;
  });
}

// sets the order of one kind: ids must be exactly the live figures of that kind
export async function reorderFigures(pool: TxPool, a: { paperId: string; kind: unknown; ids: unknown }): Promise<Figure[]> {
  if (a.kind !== 'figure' && a.kind !== 'table') throw new DomainError('INVALID', 'kind must be figure or table', 'kind');
  if (!Array.isArray(a.ids) || a.ids.some((x) => typeof x !== 'string' || !UUID_RE.test(x)) || new Set(a.ids).size !== a.ids.length) throw new DomainError('INVALID', 'ids must be a list of distinct figure ids', 'ids');
  const ids = a.ids as string[];
  return inTransaction(pool, async (tx) => {
    await tx.query('SELECT 1 FROM paper_projects WHERE id = $1 FOR UPDATE', [a.paperId]);
    const live = (await tx.query<{ id: string }>('SELECT id FROM figure_objects WHERE paper_id = $1 AND kind = $2 AND archived_at IS NULL', [a.paperId, a.kind])).rows.map((r) => r.id);
    if (live.length !== ids.length || live.some((id) => !ids.includes(id))) throw new DomainError('CONFLICT', 'the list must contain exactly the current figures of this kind; reload and try again', 'ids');
    // move out of the way first (positions are unique), then set the new order
    await tx.query('UPDATE figure_objects SET position = position + 100000 WHERE paper_id = $1 AND kind = $2 AND archived_at IS NULL', [a.paperId, a.kind]);
    for (const [i, id] of ids.entries()) await tx.query('UPDATE figure_objects SET position = $3 WHERE paper_id = $1 AND id = $2', [a.paperId, id, i + 1]);
    return (await tx.query<Figure>(`SELECT ${FIG} FROM figure_objects WHERE paper_id = $1 AND archived_at IS NULL ORDER BY kind, position`, [a.paperId])).rows;
  });
}

export async function getCitationStyle(db: Queryable, paperId: string): Promise<CitationStyle> {
  return (await db.query<{ citation_style: CitationStyle }>('SELECT citation_style FROM paper_projects WHERE id = $1', [paperId])).rows[0]!.citation_style;
}

export async function setCitationStyle(db: Queryable, paperId: string, style: unknown): Promise<CitationStyle> {
  if (!CITATION_STYLES.includes(style as CitationStyle)) throw new DomainError('INVALID', `style must be one of ${CITATION_STYLES.join(', ')}`, 'style');
  await db.query('UPDATE paper_projects SET citation_style = $2, updated_at = now() WHERE id = $1', [paperId, style]);
  return style as CitationStyle;
}

// What the stored head of a document shows for its citations and cross-references: labels in
// document order, the bibliography (from stored metadata only) and the ids that resolve to nothing.
export async function renderReferences(db: Queryable, paperId: string, documentId: string) {
  if (!UUID_RE.test(documentId)) return null;
  const head = (await db.query<{ id: string; content_json: unknown }>(
    'SELECT r.id, r.content_json FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.paper_id = $1 AND d.id = $2', [paperId, documentId])).rows[0];
  if (!head) return null;
  const style = await getCitationStyle(db, paperId);
  const refs = await listReferences(db, paperId);
  const figs = await listFigures(db, paperId);
  const occ = referenceOccurrences(head.content_json);
  const c = citationLabels(occ.citations, refs, style);
  const f = figureLabels(occ.figures, figs);
  return {
    revision_id: head.id, style, style_version: c.styleVersion,
    citations: c.labels, unresolved_citations: c.unresolved,
    bibliography: bibliography(occ.citations, refs, style),
    figures: f.labels, unresolved_figures: f.unresolved,
  };
}
