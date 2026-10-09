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
  u.searchParams.set('select', 'DOI,title,author,issued,container-title,type,subtype,relation,update-to');
  if (a.contact) u.searchParams.set('mailto', a.contact);
  return u.toString();
}

export function parseCrossref(body: unknown): Parsed {
  if (!obj(body) || body.status !== 'ok' || !obj(body.message)) throw bad('no message');
  const m = body.message;
  if (!Array.isArray(m.items)) throw bad('no items');
  const items: Candidate[] = m.items.map((it: unknown, i: number) => {
    if (!obj(it) || typeof it.DOI !== 'string' || !DOI.test(it.DOI)) throw bad(`item ${i} has no DOI`);
    const title = strList(it.title, 'title')[0];
    if (!title) throw bad(`item ${i} has no title`);
    if (it.author !== undefined && !Array.isArray(it.author)) throw bad(`item ${i} authors`);
    const authors = ((it.author as unknown[] | undefined) ?? []).flatMap((a) => (obj(a) && typeof a.family === 'string' ? [{ family: a.family, ...(typeof a.given === 'string' ? { given: a.given } : {}) }] : obj(a) && typeof a.name === 'string' ? [{ family: a.name }] : []));
    const parts = obj(it.issued) && Array.isArray(it.issued['date-parts']) ? (it.issued['date-parts'] as unknown[])[0] : undefined;
    const year = Array.isArray(parts) && Number.isInteger(parts[0]) ? (parts[0] as number) : null;
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
    if (it['update-to'] !== undefined) {
      if (!Array.isArray(it['update-to'])) throw bad(`item ${i} update-to`);
      const u = (it['update-to'] as unknown[]).find((x) => obj(x) && typeof x.type === 'string') as Record<string, unknown> | undefined;
      if (u) update = { type: String(u.type), target_doi: typeof u.DOI === 'string' ? u.DOI.toLowerCase() : null };
    }
    const type = typeof it.type === 'string' ? it.type : null;
    return {
      source: 'crossref', source_record_id: it.DOI.toLowerCase(), doi: it.DOI.toLowerCase(), title, authors, year,
      container: strList(it['container-title'], 'container-title')[0] ?? null, work_type: type,
      is_preprint: type === 'posted-content' && it.subtype === 'preprint', relations, update_notice: update,
    };
  });
  return { apiVersion: typeof body['message-version'] === 'string' ? body['message-version'] : null, total: Number.isInteger(m['total-results']) ? (m['total-results'] as number) : null, items };
}
