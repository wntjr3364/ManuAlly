// Parsers for portable reference formats (PW-038, spec 05 "Zotero와 이식성"): CSL-JSON, BibTeX, RIS and
// DOI lists. Each entry becomes the same small CSL shape, with its source key and warnings; what a
// parser cannot read is reported per entry, never guessed (no invented titles, years or authors).
export type ImportFormat = 'csl-json' | 'bibtex' | 'ris' | 'doi-list';
export const IMPORT_FORMATS: readonly ImportFormat[] = ['csl-json', 'bibtex', 'ris', 'doi-list'];

export interface Author { family: string; given?: string }
export interface ParsedEntry {
  key: string; // the source's own key (citekey, RIS ID, CSL id) or a position (#n)
  // false: the key is only a position in the file and identifies nothing
  ownKey: boolean;
  csl: { type: string; title?: string; author: Author[]; issued?: { 'date-parts': number[][] }; 'container-title'?: string; DOI?: string };
  warnings: string[];
  error?: string;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const yearOf = (v: unknown): number | undefined => {
  const m = /\b(1[5-9]\d\d|20\d\d|2100)\b/.exec(String(v ?? ''));
  return m ? Number(m[1]) : undefined;
};
function person(raw: string): Author | null {
  const s = clean(raw);
  if (!s) return null;
  if (s.includes(',')) {
    const [family, ...rest] = s.split(',');
    const given = clean(rest.join(','));
    return given ? { family: clean(family!), given } : { family: clean(family!) };
  }
  const parts = s.split(' ');
  if (parts.length === 1) return { family: s };
  return { family: parts.at(-1)!, given: parts.slice(0, -1).join(' ') };
}

// ---- CSL-JSON -----------------------------------------------------------------------------------
export function parseCslJson(text: string): ParsedEntry[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('not valid JSON'); }
  const items = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items : null;
  if (!items) throw new Error('CSL-JSON must be a list of items');
  return items.map((it, i) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const warnings: string[] = [];
    const author = Array.isArray(o.author) ? (o.author as Record<string, unknown>[]).flatMap((a) => {
      if (typeof a?.family === 'string' && a.family.trim()) return [typeof a.given === 'string' && a.given.trim() ? { family: clean(a.family), given: clean(a.given) } : { family: clean(a.family) }];
      if (typeof a?.literal === 'string' && a.literal.trim()) return [{ family: clean(a.literal) }];
      warnings.push('author_without_name');
      return [];
    }) : [];
    const dp = (o.issued as { 'date-parts'?: unknown[][] } | undefined)?.['date-parts']?.[0]?.[0];
    const year = typeof dp === 'number' ? dp : yearOf(dp);
    const container = Array.isArray(o['container-title']) ? o['container-title'][0] : o['container-title'];
    const title = typeof o.title === 'string' ? clean(o.title) : undefined;
    return {
      ...((typeof o.id === 'string' && o.id.trim()) || typeof o.id === 'number' ? { key: String(o.id).slice(0, 200), ownKey: true } : { key: `#${i + 1}`, ownKey: false }),
      csl: { type: typeof o.type === 'string' ? o.type.slice(0, 50) : 'article', ...(title ? { title } : {}), author, ...(year ? { issued: { 'date-parts': [[year]] } } : {}), ...(typeof container === 'string' && container.trim() ? { 'container-title': clean(container) } : {}), ...(typeof o.DOI === 'string' ? { DOI: o.DOI } : {}) },
      warnings,
      ...(title ? {} : { error: 'no_title' }),
    };
  });
}

// ---- BibTeX -------------------------------------------------------------------------------------
const LATEX: Record<string, string> = { '"a': 'ä', '"o': 'ö', '"u': 'ü', '"A': 'Ä', '"O': 'Ö', '"U': 'Ü', "'e": 'é', "'a": 'á', "'i": 'í', "'o": 'ó', "'u": 'ú', '`e': 'è', '`a': 'à', '^e': 'ê', '~n': 'ñ', 'ss': 'ß', 'c c': 'ç' };
function delatex(v: string, warnings: string[]): string {
  let out = v.replace(/\{\\([`'"^~])\{?([A-Za-z])\}?\}|\\([`'"^~])\{?([A-Za-z])\}?/g, (_m, a1, b1, a2, b2) => LATEX[`${a1 ?? a2}${b1 ?? b2}`] ?? (b1 ?? b2));
  if (/\\[A-Za-z]+/.test(out)) { warnings.push('latex_command_removed'); out = out.replace(/\\[A-Za-z]+\s*/g, ''); }
  return clean(out.replace(/[{}]/g, ''));
}
function readValue(src: string, i: number): { value: string; next: number; macro?: boolean } {
  while (/\s/.test(src[i] ?? '')) i++;
  if (src[i] === '{') {
    let depth = 0;
    const start = i + 1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return { value: src.slice(start, i), next: i + 1 };
    }
    throw new Error('unbalanced braces');
  }
  if (src[i] === '"') {
    const start = i + 1;
    let depth = 0;
    for (i++; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      else if (src[i] === '"' && depth === 0) return { value: src.slice(start, i), next: i + 1 };
    }
    throw new Error('unterminated string');
  }
  const m = /^[^,}\s]+/.exec(src.slice(i));
  if (!m) return { value: '', next: i };
  return { value: m[0], next: i + m[0].length, macro: !/^\d+$/.test(m[0]) };
}
export function parseBibtex(text: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  const re = /@([A-Za-z]+)\s*([{(])/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const type = m[1]!.toLowerCase();
    if (['comment', 'string', 'preamble'].includes(type)) continue;
    let i = m.index + m[0].length;
    const keyM = /^\s*([^,\s]+)\s*,/.exec(text.slice(i));
    const warnings: string[] = [];
    if (!keyM) { out.push({ key: `#${out.length + 1}`, ownKey: false, csl: { type: 'article', author: [] }, warnings, error: 'no_citekey' }); continue; }
    const key = keyM[1]!.slice(0, 200);
    i += keyM[0].length;
    const fields: Record<string, string> = {};
    try {
      for (;;) {
        const fm = /^\s*([A-Za-z][\w-]*)\s*=/.exec(text.slice(i));
        if (!fm) break;
        i += fm[0].length;
        const v = readValue(text, i);
        if (v.macro) warnings.push(`string_macro:${fm[1]!.toLowerCase()}`);
        fields[fm[1]!.toLowerCase()] = v.macro ? '' : v.value;
        i = v.next;
        const sep = /^\s*,?/.exec(text.slice(i))!;
        i += sep[0].length;
      }
    } catch (e) {
      out.push({ key, ownKey: true, csl: { type: 'article', author: [] }, warnings, error: `unreadable: ${(e as Error).message}` });
      continue;
    }
    re.lastIndex = i;
    const title = fields.title ? delatex(fields.title, warnings) : '';
    const author = (fields.author ? delatex(fields.author, warnings) : '').split(/\s+and\s+/i).map(person).filter((a): a is Author => !!a);
    const year = yearOf(fields.year ?? fields.date);
    const container = fields.journal ?? fields.journaltitle ?? fields.booktitle;
    const TYPE: Record<string, string> = { article: 'article-journal', inproceedings: 'paper-conference', book: 'book', incollection: 'chapter', phdthesis: 'thesis', misc: 'article', techreport: 'report' };
    out.push({
      key,
      ownKey: true,
      csl: { type: TYPE[type] ?? 'article', ...(title ? { title } : {}), author, ...(year ? { issued: { 'date-parts': [[year]] } } : {}), ...(container ? { 'container-title': delatex(container, warnings) } : {}), ...(fields.doi ? { DOI: clean(fields.doi) } : {}) },
      warnings: [...new Set(warnings)],
      ...(title ? {} : { error: 'no_title' }),
    });
  }
  return out;
}

// ---- RIS ----------------------------------------------------------------------------------------
export function parseRis(text: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  let cur: Record<string, string[]> | null = null;
  const finish = () => {
    if (!cur) return;
    const f = cur;
    const warnings: string[] = [];
    const title = clean((f.TI ?? f.T1 ?? f.CT ?? [])[0] ?? '');
    const author = [...(f.AU ?? []), ...(f.A1 ?? [])].map(person).filter((a): a is Author => !!a);
    const year = yearOf((f.PY ?? f.Y1 ?? f.DA ?? [])[0]);
    const container = (f.JO ?? f.JF ?? f.T2 ?? f.JA ?? [])[0];
    const TYPE: Record<string, string> = { JOUR: 'article-journal', CONF: 'paper-conference', CPAPER: 'paper-conference', BOOK: 'book', CHAP: 'chapter', THES: 'thesis', RPRT: 'report' };
    out.push({
      ...(clean((f.ID ?? [])[0] ?? '') ? { key: clean(f.ID![0]!).slice(0, 200), ownKey: true } : { key: `#${out.length + 1}`, ownKey: false }),
      csl: { type: TYPE[(f.TY ?? [''])[0]!] ?? 'article', ...(title ? { title } : {}), author, ...(year ? { issued: { 'date-parts': [[year]] } } : {}), ...(container ? { 'container-title': clean(container) } : {}), ...((f.DO ?? [])[0] ? { DOI: clean(f.DO![0]!) } : {}) },
      warnings,
      ...(title ? {} : { error: 'no_title' }),
    });
    cur = null;
  };
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9]) {2}- ?(.*)$/.exec(line);
    if (!m) continue;
    const [, tag, value] = m;
    if (tag === 'TY') { finish(); cur = { TY: [clean(value!)] }; continue; }
    if (tag === 'ER') { finish(); continue; }
    if (!cur) continue;
    (cur[tag!] ??= []).push(value!);
  }
  finish();
  return out;
}

// ---- DOI list -----------------------------------------------------------------------------------
// Only identifiers: the metadata is not looked up here (a known DOI links the library's work; an unknown
// one is reported as needing metadata, never filled in).
export function parseDoiList(text: string): ParsedEntry[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l, i) => ({ key: `#${i + 1}`, ownKey: false, csl: { type: 'article', author: [], DOI: l }, warnings: [] }));
}

export function parseReferences(format: ImportFormat, text: string): ParsedEntry[] {
  switch (format) {
    case 'csl-json': return parseCslJson(text);
    case 'bibtex': return parseBibtex(text);
    case 'ris': return parseRis(text);
    case 'doi-list': return parseDoiList(text);
  }
}
