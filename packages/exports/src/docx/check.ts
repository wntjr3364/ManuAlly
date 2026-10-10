// The export check (PW-056, spec 10: "draft export는 경고 포함 가능. submission-ready 표시에는 critical issues
// 해소"): what keeps an export from being a clean one.
// - errors: a citation or cross-reference to nothing stored; citation numbers or author-year citations typed
//   as plain text (no reference behind them — e.g. written by a model); a read-back that differs from what
//   was meant to be written.
// - warnings: math written as LaTeX text; a cited reference without year or authors.
// status: clean (nothing), needs_attention (warnings), draft_with_errors (any error; the file says so).
import type { RefMeta } from '@pw/editor-core';

export type Severity = 'error' | 'warning';
export type IssueKind = 'unresolved_citation' | 'unresolved_figure' | 'citation_like_text' | 'readback_mismatch' | 'math_as_text' | 'incomplete_reference' | 'control_characters'
  | 'superscript_citation_like' | 'italic_inconsistent' | 'retracted_reference' | 'readback_unverified' | 'missing_csl';
export interface Issue { kind: IssueKind; severity: Severity; count: number; examples: string[]; note: string }
export type ExportStatus = 'clean' | 'needs_attention' | 'draft_with_errors';

const NOTE: Record<IssueKind, string> = {
  unresolved_citation: '저장된 문헌이 없는 인용입니다. 파일에는 [?]로 들어갔습니다 — 문헌 탭에서 문헌을 추가하거나 인용을 고치세요',
  unresolved_figure: '없는 그림·표를 가리키는 상호 참조입니다 — 그림·표를 만들거나 참조를 고치세요',
  citation_like_text: '문헌과 연결되지 않은 인용 모양의 글자입니다(예: [12], (Smith et al., 2019)) — 인용 버튼으로 실제 문헌에 연결하세요. 번호를 글자로 쓰면 문헌 목록과 맞는지 아무도 확인하지 못합니다',
  readback_mismatch: '내보낸 파일을 다시 읽은 내용이 원고와 다릅니다 — 이 파일을 쓰지 마세요(버그로 보고)',
  math_as_text: '수식은 LaTeX 글자로 들어갔습니다(Word 수식으로 바꾸지 않음) — 제출 전에 Word에서 수식으로 바꾸세요',
  incomplete_reference: '연도나 저자가 없는 문헌입니다(목록에 n.d./Anon.으로 나옴) — 문헌 정보를 채우세요',
  control_characters: 'Word 파일에 넣을 수 없는 제어 문자를 지웠습니다',
  superscript_citation_like: '단어 뒤의 위첨자 숫자가 인용 번호처럼 보입니다(단위 m² 같은 경우는 무시해도 됩니다) — 인용이면 인용 버튼으로 문헌에 연결하세요',
  italic_inconsistent: '한 곳에서 기울임으로 쓴 이름(종명·유전자명 등)이 다른 곳에서는 기울임이 아닙니다 — 학술지 규칙에 맞게 통일하세요',
  retracted_reference: '철회(retraction)가 알려진 문헌을 인용했습니다 — 의도한 인용인지 확인하세요',
  readback_unverified: '내보낸 파일을 다시 읽어 확인하지 못했습니다(파일이 너무 크거나 읽기 한계를 넘음) — 열어서 직접 확인하세요',
  missing_csl: '저장된 CSL 기록이 없는 인용 문헌이 있어 CSL-JSON에서 빠졌습니다 — 문헌 정보를 다시 저장하세요',
};
const EXAMPLES = 5;

// a citation typed as text (errors): [12], [3, 5–7] (positive whole numbers only: [0, 1] or [0.5, 2] are
// intervals); (Smith et al., 2019), (see Kim 2020), (e.g., Smith 2019), (김 외, 2020) — not a month and year such
// as (March 2020); narrative Smith et al. (2019), Lee and Park (2018)
const NUMERIC = /\[\s*[1-9]\d{0,2}(?:\s*[,;–-]\s*[1-9]\d{0,2})*\s*\]/g;
const NAME = "(?:\\p{Lu}[\\p{L}'’-]*|\\p{Script=Hangul}{1,10})";
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s';
const YEAR = '(?:1[89]|20)\\d{2}[a-z]?';
const CO = `(?:\\s+(?:et al\\.?|&|and|외)(?:\\s*${NAME})?)?`;
const PAREN = new RegExp(`\\(\\s*(?:(?:see|e\\.g\\.,?|cf\\.|i\\.e\\.,?|for example,?)\\s+)?(?!${MONTH})${NAME}${CO},?\\s+${YEAR}(?:\\s*[,;]\\s*[^()]{0,60})?\\)`, 'gu');
const NARRATIVE = new RegExp(`(?<![\\p{L}])(?!${MONTH})${NAME}${CO}\\s+\\(\\s*${YEAR}\\s*\\)`, 'gu');
export function citationLike(text: string): string[] {
  return [...(text.match(NUMERIC) ?? []), ...(text.match(PAREN) ?? []), ...(text.match(NARRATIVE) ?? [])];
}
// superscript numbers right after a word or closing punctuation (a warning: m², cm³ look the same)
const SUP_UNICODE = /(?<=[\p{L}\p{Pe}.,;])[⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:[˒,⁻–-][⁰¹²³⁴⁵⁶⁷⁸⁹]+)*/gu;
const SUP_DIGITS = /^\s*\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\s*$/;
// a name that is italic by convention: a binomial (Genus species, G. species) or a gene-like token (ABC1)
const ITALIC_NAME = /^(?:\p{Lu}\p{Ll}+|\p{Lu}\.)\s\p{Ll}{2,}$|^\p{L}{2,}\d+[\p{L}\d]*$/u;

export class Issues {
  private m = new Map<IssueKind, { severity: Severity; count: number; examples: string[] }>();
  add(kind: IssueKind, severity: Severity, example?: string, n = 1) {
    const e = this.m.get(kind) ?? { severity, count: 0, examples: [] };
    e.count += n;
    if (example && e.examples.length < EXAMPLES && !e.examples.includes(example)) e.examples.push(example.slice(0, 120));
    this.m.set(kind, e);
  }
  list(): Issue[] {
    return [...this.m].map(([kind, v]) => ({ kind, severity: v.severity, count: v.count, examples: v.examples, note: NOTE[kind] }));
  }
  status(): ExportStatus {
    const l = this.list();
    return l.some((i) => i.severity === 'error') ? 'draft_with_errors' : l.length ? 'needs_attention' : 'clean';
  }
}

type Seg = { text: string; marks: string[] } | { atom: true };
export function checkContent(a: { typed: string[]; segments: Seg[][]; math: string[]; cited: RefMeta[]; unresolvedCitations: string[]; unresolvedFigures: string[]; retracted?: ReadonlySet<string> }, issues: Issues) {
  for (const id of a.unresolvedCitations) issues.add('unresolved_citation', 'error', id);
  for (const id of a.unresolvedFigures) issues.add('unresolved_figure', 'error', id);
  for (const t of a.typed) for (const c of citationLike(t)) issues.add('citation_like_text', 'error', c);
  for (const m of a.math) issues.add('math_as_text', 'warning', m);
  for (const r of a.cited) if (r.year === null || !r.authors.length || !r.title.trim()) issues.add('incomplete_reference', 'warning', r.title.trim() || r.id);
  for (const r of a.cited) if (a.retracted?.has(r.id)) issues.add('retracted_reference', 'warning', r.title);
  // superscript numbers after a word
  for (const seq of a.segments) {
    seq.forEach((g, k) => {
      if ('atom' in g) return;
      for (const m of g.text.match(SUP_UNICODE) ?? []) issues.add('superscript_citation_like', 'warning', m);
      if (g.marks.includes('superscript') && SUP_DIGITS.test(g.text)) {
        const prev = seq[k - 1];
        const before = prev && !('atom' in prev) ? prev.text.at(-1) ?? '' : '';
        if (/[\p{L}\p{Pe}.,;]/u.test(before)) issues.add('superscript_citation_like', 'warning', `…${prev && !('atom' in prev) ? prev.text.slice(-12) : ''}^${g.text.trim()}`);
      }
    });
  }
  // a conventional italic name (binomial, gene-like) written plain elsewhere
  const italic = new Set<string>();
  for (const seq of a.segments) for (const g of seq) if (!('atom' in g) && g.marks.includes('italic') && ITALIC_NAME.test(g.text.trim()) && italic.size < 200) italic.add(g.text.trim());
  if (italic.size) {
    const plain = a.segments.flatMap((seq) => seq.filter((g): g is { text: string; marks: string[] } => !('atom' in g) && !g.marks.includes('italic')).map((g) => g.text));
    for (const name of italic) {
      const re = new RegExp(`(?<![\\p{L}\\d])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\d])`, 'u');
      if (plain.some((t) => re.test(t))) issues.add('italic_inconsistent', 'warning', name);
    }
  }
}
