// Crossref REST API /works (spec 05, S13). Only the fields used are read; anything not in the
// expected shape makes the whole answer "schema_changed" (never a partial or guessed record).
import { SourceUnavailable } from './http.ts';
import type { Candidate, Parsed } from './types.ts';

const bad = (m: string) => new SourceUnavailable('schema_changed', `Crossref: ${m}`);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const DOI = /^10\.\d{4,9}\/\S+$/;
const strList = (v: unknown, what: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad(`${what} is not a list of text`);
  return v as string[];
};

export function crossrefUrl(endpoint: string, a: { query: string; limit: number; contact: string | null }): string {
  const u = new URL(endpoint);
  u.searchParams.set('query.bibliographic', a.query);
  u.searchParams.set('rows', String(a.limit));
  u.searchParams.set('select', 'DOI,title,author,issued,container-title,type,subtype,relation,update-to,updated-by');
  if (a.contact) u.searchParams.set('mailto', a.contact);
  return u.toString();
}

export function parseCrossref(body: unknown): Parsed {
  if (!obj(body) || body.status !== 'ok' || !obj(body.message)) throw bad('no message');
  const m = body.message;
  if (!Array.isArray(m.items)) throw bad('no items');
  const items: Candidate[] = m.items.map((it: unknown, i: number) => {
    if (!obj(it) || typeof it.DOI !== 'string' || !DOI.test(it.DOI) || it.DOI.length > 300) throw bad(`item ${i} has no DOI`);
    const title = strList(it.title, 'title')[0];
    if (!title) throw bad(`item ${i} has no title`);
    if (it.author !== undefined && !Array.isArray(it.author)) throw bad(`item ${i} authors`);
    // every author entry must be readable: a list with unreadable entries would look complete
    const authors = ((it.author as unknown[] | undefined) ?? []).map((a, j) => {
      if (obj(a) && typeof a.family === 'string' && a.family.trim()) return { family: a.family.slice(0, 200), ...(typeof a.given === 'string' && a.given.trim() ? { given: a.given.slice(0, 200) } : {}) };
      if (obj(a) && typeof a.name === 'string' && a.name.trim()) return { family: a.name.slice(0, 200) }; // a group author
      if (obj(a) && typeof a.given === 'string' && a.given.trim() && a.family === undefined) return { family: a.given.slice(0, 200) }; // a single name
      throw bad(`item ${i} author ${j} is unreadable`);
    });
    const parts = obj(it.issued) && Array.isArray(it.issued['date-parts']) ? (it.issued['date-parts'] as unknown[])[0] : undefined;
    // a year outside 1000–3000 is not a publication year: unknown, not invented
    const year = Array.isArray(parts) && Number.isInteger(parts[0]) && (parts[0] as number) >= 1000 && (parts[0] as number) <= 3000 ? (parts[0] as number) : null;
    const relations: Record<string, string[]> = {};
    if (it.relation !== undefined) {
      if (!obj(it.relation)) throw bad(`item ${i} relation`);
      for (const k of ['is-preprint-of', 'has-preprint', 'is-version-of', 'has-version']) {
        const v = it.relation[k];
        if (v === undefined) continue;
        if (!Array.isArray(v)) throw bad(`item ${i} relation ${k}`);
        const ids = v.flatMap((x) => (obj(x) && x['id-type'] === 'doi' && typeof x.id === 'string' ? [x.id.toLowerCase()] : []));
        if (ids.length) relations[k.replaceAll('-', '_')] = ids;
      }
    }
    let update: Candidate['update_notice'] = null;
    // this record IS a notice about another work (update-to) …
    if (it['update-to'] !== undefined) {
      if (!Array.isArray(it['update-to'])) throw bad(`item ${i} update-to`);
      const u = (it['update-to'] as unknown[]).find((x) => obj(x) && typeof x.type === 'string') as Record<string, unknown> | undefined;
      if (u) update = { type: String(u.type), target_doi: typeof u.DOI === 'string' ? u.DOI.toLowerCase() : null };
    }
    // … or this work was updated by a notice (updated-by): a retracted original shows as retracted
    if (!update && it['updated-by'] !== undefined) {
      if (!Array.isArray(it['updated-by'])) throw bad(`item ${i} updated-by`);
      const kinds = (it['updated-by'] as unknown[]).filter((x): x is Record<string, unknown> => obj(x) && typeof x.type === 'string');
      // the most serious status wins; any other kind (withdrawal, removal, partial_retraction, …) still
      // marks the work as updated rather than being dropped
      const rank = (t: string) => (t === 'retraction' ? 0 : t === 'expression_of_concern' || t === 'expression-of-concern' ? 1 : t === 'correction' || t === 'erratum' ? 2 : 3);
      const pick = [...kinds].sort((x, y) => rank(String(x.type)) - rank(String(y.type)))[0];
      const FLAG = ['retracted_publication', 'has_expression_of_concern', 'has_correction', 'has_update'];
      if (pick) update = { type: FLAG[rank(String(pick.type))]!, notice_doi: typeof pick.DOI === 'string' ? pick.DOI.toLowerCase() : null, ...(rank(String(pick.type)) === 3 ? { notice_type: String(pick.type).slice(0, 50) } : {}) };
    }
    // an implausible type is dropped (unknown), not stored
    const type = typeof it.type === 'string' && it.type.length <= 100 ? it.type : null;
    return {
      source: 'crossref', source_record_id: it.DOI.toLowerCase(), doi: it.DOI.toLowerCase(), title, authors, year,
      container: strList(it['container-title'], 'container-title')[0] ?? null, work_type: type,
      is_preprint: type === 'posted-content' && it.subtype === 'preprint', relations, update_notice: update,
    };
  });
  return { apiVersion: typeof body['message-version'] === 'string' ? body['message-version'] : null, total: Number.isInteger(m['total-results']) ? (m['total-results'] as number) : null, items };
}
