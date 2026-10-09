// PubMed via NCBI E-utilities: esearch (ids) then esummary (records), JSON. Only the fields used are
// read; an esummary that does not describe every requested id is "schema_changed", not a shorter list.
import { SourceUnavailable } from './http.ts';
import type { Candidate, Parsed } from './types.ts';

const bad = (m: string) => new SourceUnavailable('schema_changed', `PubMed: ${m}`);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const DOI = /^10\.\d{4,9}\/\S+$/;

function params(u: URL, a: { contact: string | null; apiKey: string | null }) {
  u.searchParams.set('retmode', 'json');
  u.searchParams.set('tool', 'paper-workspace');
  if (a.contact) u.searchParams.set('email', a.contact);
  if (a.apiKey) u.searchParams.set('api_key', a.apiKey);
}
export function esearchUrl(endpoint: string, a: { query: string; limit: number; contact: string | null; apiKey: string | null }): string {
  const u = new URL(`${endpoint.replace(/\/$/, '')}/esearch.fcgi`);
  u.searchParams.set('db', 'pubmed');
  u.searchParams.set('term', a.query);
  u.searchParams.set('retmax', String(a.limit));
  params(u, a);
  return u.toString();
}
export function esummaryUrl(endpoint: string, ids: string[], a: { contact: string | null; apiKey: string | null }): string {
  const u = new URL(`${endpoint.replace(/\/$/, '')}/esummary.fcgi`);
  u.searchParams.set('db', 'pubmed');
  u.searchParams.set('id', ids.join(','));
  params(u, a);
  return u.toString();
}

export function parseEsearch(body: unknown): { ids: string[]; total: number | null; version: string | null } {
  if (!obj(body) || !obj(body.esearchresult)) throw bad('no esearchresult');
  const r = body.esearchresult;
  if (!Array.isArray(r.idlist) || r.idlist.some((x) => typeof x !== 'string' || !/^\d{1,12}$/.test(x))) throw bad('idlist');
  const total = typeof r.count === 'string' && /^\d+$/.test(r.count) ? Number(r.count) : null;
  return { ids: r.idlist as string[], total, version: obj(body.header) && typeof body.header.version === 'string' ? body.header.version : null };
}

export function parseEsummary(body: unknown, ids: string[]): Parsed {
  if (!obj(body) || !obj(body.result)) throw bad('no result');
  const res = body.result;
  const items: Candidate[] = ids.map((id) => {
    const r = res[id];
    if (!obj(r) || r.uid !== id) throw bad(`record ${id} is missing`);
    if (typeof r.title !== 'string' || !r.title.trim()) throw bad(`record ${id} has no title`);
    if (!Array.isArray(r.authors)) throw bad(`record ${id} authors`);
    const authors = r.authors.flatMap((a) => {
      if (!obj(a) || typeof a.name !== 'string') return [];
      const m = /^(.*\S)\s+([A-Z]{1,4})$/.exec(a.name.trim());
      return [m ? { family: m[1]!, given: m[2]! } : { family: a.name.trim() }];
    });
    const year = typeof r.pubdate === 'string' && /^(\d{4})/.test(r.pubdate) ? Number(r.pubdate.slice(0, 4)) : null;
    const ids2 = Array.isArray(r.articleids) ? r.articleids : [];
    const doiRaw = ids2.find((x) => obj(x) && x.idtype === 'doi' && typeof x.value === 'string') as Record<string, string> | undefined;
    const doi = doiRaw && DOI.test(doiRaw.value!) ? doiRaw.value!.toLowerCase() : null;
    const pubtype = Array.isArray(r.pubtype) ? r.pubtype.filter((x): x is string => typeof x === 'string') : [];
    const notice = pubtype.includes('Retracted Publication') ? 'retracted_publication' : pubtype.includes('Retraction of Publication') ? 'retraction' : pubtype.includes('Published Erratum') ? 'erratum' : pubtype.includes('Expression of Concern') ? 'expression_of_concern' : null;
    return {
      source: 'pubmed', source_record_id: id, doi, title: r.title.trim(), authors, year,
      container: typeof r.fulljournalname === 'string' ? r.fulljournalname : null, work_type: pubtype[0] ?? null,
      is_preprint: pubtype.includes('Preprint'), relations: {}, update_notice: notice ? { type: notice } : null,
    };
  });
  return { apiVersion: obj(body.header) && typeof body.header.version === 'string' ? body.header.version : null, total: null, items };
}
