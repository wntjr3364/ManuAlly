// Citation labels, bibliography and figure/table numbers (PW-019, spec 10: "citation node에는
// reference stable ID와 locator. 번호·author-year suffix·bibliography order는 고정된 버전에서 생성.
// AI가 bibliography 문자열을 만들어 넣지 못함").
// The document stores only stable ids (citation.referenceId, figure_ref.targetId); everything shown is
// computed here from the stored reference metadata and the user's figure order, so changing the order
// or the style renumbers every occurrence consistently. Unknown ids are never numbered.
// Built-in deterministic styles; the pinned citeproc/CSL engine for export arrives with PW-056.

export type CitationStyle = 'numeric' | 'author_year';
export const CITATION_STYLES: readonly CitationStyle[] = ['numeric', 'author_year'];
export const STYLE_VERSION = 'pw-builtin-1';

export interface RefMeta {
  id: string;
  authors: { family: string; given?: string }[];
  year: number | null;
  title: string;
  container?: string | null;
  doi?: string | null;
}
export interface FigureMeta { id: string; kind: 'figure' | 'table'; position: number; title: string }
export interface CitationOccurrence { referenceId: string; locator: string | null }

const UNRESOLVED_CITATION = '[?]';
const UNRESOLVED_FIGURE = '[그림/표 없음]';

const authorKey = (r: RefMeta) => {
  const a = r.authors;
  if (!a.length) return 'Anon.';
  if (a.length === 1) return a[0]!.family;
  if (a.length === 2) return `${a[0]!.family} & ${a[1]!.family}`;
  return `${a[0]!.family} et al.`;
};
const yearText = (r: RefMeta) => (r.year === null ? 'n.d.' : String(r.year));
const sortKey = (r: RefMeta) => [r.authors.map((x) => `${x.family}, ${x.given ?? ''}`).join('; ').toLowerCase(), yearText(r), r.title.toLowerCase(), r.id];
const compareKeys = (a: string[], b: string[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
};

// cited references in bibliography order: first appearance (numeric) or alphabetical (author-year)
function ordered(occ: readonly CitationOccurrence[], byId: Map<string, RefMeta>, style: CitationStyle): RefMeta[] {
  const seen: RefMeta[] = [];
  for (const o of occ) {
    const r = byId.get(o.referenceId);
    if (r && !seen.includes(r)) seen.push(r);
  }
  return style === 'numeric' ? seen : [...seen].sort((a, b) => compareKeys(sortKey(a), sortKey(b)));
}

// author-year labels with a/b suffixes where the same base label (author key + year) repeats
function authorYearBases(refsInOrder: RefMeta[]): Map<string, string> {
  const groups = new Map<string, RefMeta[]>();
  for (const r of refsInOrder) {
    const base = `${authorKey(r)} ${yearText(r)}`;
    groups.set(base, [...(groups.get(base) ?? []), r]);
  }
  const out = new Map<string, string>();
  // a/b suffixes; after "n.d." a hyphen keeps it readable (APA: n.d.-a)
  for (const [base, rs] of groups) rs.forEach((r, i) => out.set(r.id, rs.length > 1 ? `${base}${base.endsWith('n.d.') ? '-' : ''}${String.fromCharCode(97 + i)}` : base));
  return out;
}

export function citationLabels(occ: readonly CitationOccurrence[], refs: readonly RefMeta[], style: CitationStyle) {
  const byId = new Map(refs.map((r) => [r.id, r]));
  const order = ordered(occ, byId, style);
  const number = new Map(order.map((r, i) => [r.id, i + 1]));
  const bases = authorYearBases(order);
  const unresolved: string[] = [];
  const labels = occ.map((o) => {
    if (!byId.has(o.referenceId)) {
      if (!unresolved.includes(o.referenceId)) unresolved.push(o.referenceId);
      return UNRESOLVED_CITATION;
    }
    const loc = o.locator ? `, ${o.locator}` : '';
    return style === 'numeric' ? `[${number.get(o.referenceId)}${loc}]` : `(${bases.get(o.referenceId)}${loc})`;
  });
  return { labels, unresolved, styleVersion: STYLE_VERSION };
}

// first character by code point, so names outside the BMP are not cut in half
const initials = (given?: string) => (given ? given.split(/[\s-]+/).filter(Boolean).map((g) => `${[...g][0]!.toUpperCase()}.`).join(' ') : '');
const authorList = (r: RefMeta) => {
  const names = r.authors.map((a) => (a.given ? `${a.family}, ${initials(a.given)}` : a.family));
  if (names.length <= 1) return names[0] ?? 'Anon.';
  return `${names.slice(0, -1).join(', ')}, & ${names.at(-1)}`;
};

export function bibliography(occ: readonly CitationOccurrence[], refs: readonly RefMeta[], style: CitationStyle) {
  const byId = new Map(refs.map((r) => [r.id, r]));
  const order = ordered(occ, byId, style);
  const bases = authorYearBases(order);
  return order.map((r, i) => {
    const year = style === 'author_year' ? (bases.get(r.id)!.match(/(\d{4}|n\.d\.)-?[a-z]?$/)?.[0] ?? yearText(r)) : yearText(r);
    const parts = [`${authorList(r)} (${year}).`, `${r.title.replace(/\.$/, '')}.`];
    if (r.container) parts.push(`${r.container.replace(/\.$/, '')}.`);
    if (r.doi) parts.push(`https://doi.org/${r.doi}`);
    return { id: r.id, label: style === 'numeric' ? `[${i + 1}]` : `(${bases.get(r.id)})`, text: parts.join(' ') };
  });
}

export function figureLabels(targets: readonly string[], figures: readonly FigureMeta[]) {
  const byId = new Map(figures.map((f) => [f.id, f]));
  const number = new Map<string, number>();
  for (const kind of ['figure', 'table'] as const) {
    figures.filter((f) => f.kind === kind).sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)).forEach((f, i) => number.set(f.id, i + 1));
  }
  const unresolved: string[] = [];
  const labels = targets.map((t) => {
    const f = byId.get(t);
    if (!f) {
      if (!unresolved.includes(t)) unresolved.push(t);
      return UNRESOLVED_FIGURE;
    }
    return `${f.kind === 'figure' ? 'Figure' : 'Table'} ${number.get(t)}`;
  });
  return { labels, unresolved, numbers: number };
}

// occurrences in document order from stored document JSON (server and browser alike)
export function referenceOccurrences(json: unknown): { citations: CitationOccurrence[]; figures: string[] } {
  const citations: CitationOccurrence[] = [];
  const figures: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const o = n as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
    if (o.type === 'citation') citations.push({ referenceId: String(o.attrs?.referenceId ?? ''), locator: (o.attrs?.locator as string | null) ?? null });
    if (o.type === 'figure_ref') figures.push(String(o.attrs?.targetId ?? ''));
    o.content?.forEach(walk);
  };
  walk(json);
  return { citations, figures };
}
