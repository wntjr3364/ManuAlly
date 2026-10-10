// The export check (PW-056, spec 10: "draft export는 경고 포함 가능. submission-ready 표시에는 critical issues
// 해소"): what keeps an export from being a clean one.
// - errors: a citation or cross-reference to nothing stored; citation numbers or author-year citations typed
//   as plain text (no reference behind them — e.g. written by a model); a read-back that differs from what
//   was meant to be written.
// - warnings: math written as LaTeX text; a cited reference without year or authors.
// status: clean (nothing), needs_attention (warnings), draft_with_errors (any error; the file says so).
import type { RefMeta } from '@pw/editor-core';

export type Severity = 'error' | 'warning';
export type IssueKind = 'unresolved_citation' | 'unresolved_figure' | 'citation_like_text' | 'readback_mismatch' | 'math_as_text' | 'incomplete_reference' | 'control_characters';
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
};
const EXAMPLES = 5;

// a citation typed as text: [12], [3, 5–7], (Smith et al., 2019), (Kim & Lee 2020a)
const NUMERIC = /\[\s*\d{1,3}(?:\s*[,;–-]\s*\d{1,3})*\s*\]/g;
const AUTHOR_YEAR = /\(\s*\p{Lu}[\p{L}'’-]+(?:\s+(?:et al\.?|&|and)(?:\s*\p{Lu}[\p{L}'’-]+)?)?,?\s+(?:1[89]|20)\d{2}[a-z]?(?:\s*[,;]\s*[^()]{0,40})?\)/gu;
export function citationLike(text: string): string[] {
  return [...(text.match(NUMERIC) ?? []), ...(text.match(AUTHOR_YEAR) ?? [])];
}

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

export function checkContent(a: { typed: string[]; math: string[]; cited: RefMeta[]; unresolvedCitations: string[]; unresolvedFigures: string[] }, issues: Issues) {
  for (const id of a.unresolvedCitations) issues.add('unresolved_citation', 'error', id);
  for (const id of a.unresolvedFigures) issues.add('unresolved_figure', 'error', id);
  for (const t of a.typed) for (const c of citationLike(t)) issues.add('citation_like_text', 'error', c);
  for (const m of a.math) issues.add('math_as_text', 'warning', m);
  for (const r of a.cited) if (r.year === null || !r.authors.length) issues.add('incomplete_reference', 'warning', r.title);
}
