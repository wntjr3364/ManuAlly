// Plain text and Markdown import (PW-021, spec 10 "가져오기"). The result is a manuscript in the shared
// editor schema with new block ids, plus a loss report: everything that could not be carried over as
// such is named with its line numbers — nothing is dropped silently. Nothing is ever interpreted as
// markup beyond the subset below; HTML stays literal text.
// Markdown subset: ATX headings (#…######), paragraphs, **bold**/__bold__, *italic*/_italic_,
// H~2~O subscript, x^2^ superscript (a short run of letters/digits; a tilde between digits, as in a
// range 10~20%, stays literal), backslash escapes. Kept as text and reported: links (text kept), lists
// (bullet or number kept), block quotes, code, tables, $math$, HTML, footnotes (marker [1] and the
// definition as its own paragraph). Dropped and reported: images, horizontal rules.
import { randomUUID } from 'node:crypto';
import { validateDocument } from '@pw/editor-core';

export const PARSER_VERSION = 'pw-text-import-1';
export type ImportFormat = 'text' | 'markdown';
export const IMPORT_FORMATS: readonly ImportFormat[] = ['text', 'markdown'];

export type LossKind =
  | 'control_characters' | 'replacement_characters' | 'link' | 'image' | 'list' | 'blockquote' | 'code' | 'table' | 'math' | 'html' | 'footnote' | 'horizontal_rule';
export interface Loss { kind: LossKind; count: number; examples: string[]; note: string }
export interface ImportReport { format: ImportFormat; parser_version: string; blocks: number; characters: number; losses: Loss[] }

const NOTE: Record<LossKind, string> = {
  control_characters: '제어 문자를 지웠습니다',
  replacement_characters: '깨진 문자(�)가 있습니다 — 원본 파일의 인코딩(UTF-8인지)을 확인하세요',
  link: '링크 주소를 빼고 글자만 남겼습니다',
  image: '그림을 넣지 않았습니다(그림은 자료에서 따로 추가)',
  list: '목록을 기호가 붙은 문단으로 바꿨습니다',
  blockquote: '인용 블록을 일반 문단으로 바꿨습니다',
  code: '코드를 일반 글자로 바꿨습니다',
  table: '표를 글자 줄로 남겼습니다(표 편집은 아직 지원하지 않음)',
  math: '수식을 글자 그대로 남겼습니다(수식 노드로 바꾸지 않음)',
  html: 'HTML을 해석하지 않고 글자 그대로 남겼습니다',
  footnote: '각주 번호는 [1]처럼 글자로, 각주 내용은 따로 문단으로 남겼습니다(연결 없음)',
  horizontal_rule: '구분선을 지웠습니다',
};

type Mark = 'bold' | 'italic' | 'subscript' | 'superscript';
type Inline = { type: 'text'; text: string; marks?: { type: Mark }[] };
type Block = { type: 'paragraph' | 'heading'; attrs: { id: string; level?: number }; content: Inline[] };

export class ImportError extends Error {}

class Report {
  readonly #l = new Map<LossKind, Loss>();
  add(kind: LossKind, line: number) {
    const l = this.#l.get(kind) ?? { kind, count: 0, examples: [], note: NOTE[kind] };
    l.count++;
    const ex = `line ${line}`;
    if (l.examples.length < 3 && !l.examples.includes(ex)) l.examples.push(ex);
    this.#l.set(kind, l);
  }
  list() { return [...this.#l.values()]; }
}

// marks: longest delimiters first; a marker without its closing pair stays literal
const INLINE: { re: RegExp; mark: Mark }[] = [
  { re: /\*\*(?=\S)(.+?)(?<=\S)\*\*/u, mark: 'bold' }, // may contain *italic*
  { re: /__(?=\S)(.+?)(?<=\S)__/u, mark: 'bold' },
  { re: /(?<![\p{L}\p{N}*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\p{L}\p{N}*])/u, mark: 'italic' },
  { re: /(?<![\p{L}\p{N}_])_(?=\S)([^_]+?)(?<=\S)_(?![\p{L}\p{N}_])/u, mark: 'italic' },
  // not after a digit: 10~20% or n=3~5 are ranges, not subscripts
  { re: /(?<!\p{N})~([\p{L}\p{N}+\-\u2212]{1,12})~(?!\p{N})/u, mark: 'subscript' },
  { re: /\^([\p{L}\p{N}+\-\u2212]{1,12})\^/u, mark: 'superscript' },
];

// backslash escapes: the escaped character is kept literally (hidden from the rules while parsing)
const ESCAPABLE = '\\`*_{}[]()#+-.!~^|>$<';
const hide = (t: string) => (/[\uE000-\uE0FF]/.test(t) ? t : t.replace(/\\(.)/g, (m, c: string) => (ESCAPABLE.includes(c) ? String.fromCharCode(0xe000 + ESCAPABLE.indexOf(c)) : m)));
const unhide = (t: string) => t.replace(/[\uE000-\uE0FF]/g, (c) => ESCAPABLE[c.charCodeAt(0) - 0xe000] ?? c);

function inlineMarkdown(text: string, line: number, rep: Report): Inline[] {
  return marksOf(hide(text), line, rep).map((x) => ({ ...x, text: unhide(x.text) }));
}

function marksOf(text: string, line: number, rep: Report): Inline[] {
  let t = text;
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, () => { rep.add('image', line); return ''; });
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, (_m, label: string) => { rep.add('link', line); return label; });
  t = t.replace(/\[\^([^\]]+)\]/g, (_m, n: string) => { rep.add('footnote', line); return `[${n}]`; });
  t = t.replace(/`([^`]+)`/g, (_m, code: string) => { rep.add('code', line); return code; });
  if (/\$[^$\s][^$]*\$/.test(t)) rep.add('math', line);
  if (/<\/?[A-Za-z][^>]*>/.test(t)) rep.add('html', line);
  return marks(t, []);
}

function marks(t: string, active: Mark[]): Inline[] {
  let best: { i: number; m: RegExpExecArray; mark: Mark } | null = null;
  for (const { re, mark } of INLINE) {
    const m = re.exec(t);
    if (m && (!best || m.index < best.i)) best = { i: m.index, m, mark };
  }
  const run = (s: string): Inline[] => (s ? [active.length ? { type: 'text', text: s, marks: [...active].sort().map((type) => ({ type })) } : { type: 'text', text: s }] : []);
  if (!best) return run(t);
  const next = best.mark === 'subscript' ? active.filter((x) => x !== 'superscript') : best.mark === 'superscript' ? active.filter((x) => x !== 'subscript') : active;
  return [
    ...run(t.slice(0, best.i)),
    ...marks(best.m[1]!, next.includes(best.mark) ? next : [...next, best.mark]),
    ...marks(t.slice(best.i + best.m[0].length), active),
  ];
}

// adjacent text runs with the same marks are merged (the schema would merge them anyway)
function merge(xs: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const x of xs) {
    const last = out.at(-1);
    if (last && JSON.stringify(last.marks ?? []) === JSON.stringify(x.marks ?? [])) last.text += x.text;
    else out.push({ ...x });
  }
  return out;
}

export function parseImport(source: string, format: ImportFormat): { doc: { type: 'doc'; content: Block[] }; report: ImportReport } {
  if (!IMPORT_FORMATS.includes(format)) throw new ImportError(`format must be one of ${IMPORT_FORMATS.join(', ')}`);
  const rep = new Report();
  const lines = (source.charCodeAt(0) === 0xfeff ? source.slice(1) : source).replace(/\r\n?/g, '\n').split('\n').map((l, i) => {
    // control characters other than tab are removed (tab becomes a space)
    let clean = '';
    for (const ch of l) {
      if (ch === '\t') clean += ' ';
      else if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) rep.add('control_characters', i + 1);
      else clean += ch;
    }
    return clean;
  });
  const blocks: Block[] = [];
  const block = (type: Block['type'], content: Inline[], level?: number) => {
    const c = merge(content).filter((x) => x.text !== '');
    if (!c.length && type === 'paragraph') return;
    blocks.push({ type, attrs: level ? { id: randomUUID(), level } : { id: randomUUID() }, content: c });
  };

  if (format === 'text') {
    let para: string[] = [];
    const flush = () => { if (para.length) block('paragraph', [{ type: 'text', text: para.join(' ') }]); para = []; };
    for (const l of lines) {
      if (!l.trim()) flush();
      else para.push(l.trim());
    }
    flush();
  } else {
    let para: { text: string; line: number }[] = [];
    let fence = false;
    const flush = () => {
      if (para.length) block('paragraph', para.flatMap((p, i) => inlineMarkdown(i ? ` ${p.text}` : p.text, p.line, rep)));
      para = [];
    };
    lines.forEach((raw, idx) => {
      const n = idx + 1;
      const l = raw.trim();
      if (/^(```|~~~)/.test(l)) { flush(); if (!fence) rep.add('code', n); fence = !fence; return; }
      if (fence) { if (l) block('paragraph', [{ type: 'text', text: raw.trimEnd() }]); return; }
      if (!l) { flush(); return; }
      const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
      if (h) { flush(); block('heading', inlineMarkdown(h[2]!, n, rep), h[1]!.length); return; }
      if (/^([-*_])(\s*\1){2,}$/.test(l)) { flush(); rep.add('horizontal_rule', n); return; }
      const fn = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(l);
      if (fn) { flush(); rep.add('footnote', n); block('paragraph', inlineMarkdown(`[${fn[1]}] ${fn[2]}`, n, rep)); return; }
      if (/^\|.*\|$/.test(l)) {
        flush();
        rep.add('table', n);
        if (!/^\|[\s:|-]+\|$/.test(l)) block('paragraph', [{ type: 'text', text: l }]);
        return;
      }
      const li = /^([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(l); // a year such as "2020. The …" is not a list
      if (li) { flush(); rep.add('list', n); block('paragraph', inlineMarkdown(`${/\d/.test(li[1]!) ? li[1]! : '•'} ${li[2]}`, n, rep)); return; }
      const q = /^>\s?(.*)$/.exec(l);
      if (q) { rep.add('blockquote', n); if (q[1]) para.push({ text: q[1], line: n }); return; }
      para.push({ text: l, line: n });
    });
    flush();
  }
  if (!blocks.length) throw new ImportError('the file is empty (no text to import)');
  if (source.includes('\uFFFD')) rep.add('replacement_characters', source.slice(0, source.indexOf('\uFFFD')).split('\n').length);
  const doc = { type: 'doc' as const, content: blocks };
  const checked = validateDocument(doc, 1);
  if (!checked.ok) throw new ImportError(`the import could not be converted to a valid manuscript: ${JSON.stringify(checked.errors).slice(0, 300)}`);
  const characters = blocks.reduce((n, b) => n + b.content.reduce((m, c) => m + c.text.length, 0), 0);
  return { doc, report: { format, parser_version: PARSER_VERSION, blocks: blocks.length, characters, losses: rep.list() } };
}
