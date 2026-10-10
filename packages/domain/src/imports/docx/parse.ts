// DOCX → the shared editor document, with a loss report (PW-055, spec 10 "가져오기"). Nothing that cannot be
// carried over as such is dropped silently: each kind is counted, with examples and a note.
// - Kept: paragraphs; headings by style (the style's own name in styles.xml, so Korean Word's numbered style
//   ids work: "heading 1".."heading 6", "Title"); bold, italic, subscript, superscript; tables (cell text).
// - Kept as text and reported: citation and bibliography fields (Zotero, Mendeley, EndNote, CSL — the
//   shown text stays, the link to the library does not), other fields, equations (their characters),
//   links (text only), footnotes and endnotes (a [n] marker, the note as a paragraph at the end).
// - Dropped and reported: comments (the anchored text stays; the comment is listed), images and other
//   drawings, merged or nested table cells' layout, list numbers and bullets, tracked formatting changes.
// - Tracked insertions and deletions are never resolved silently: with any present, the owner must choose
//   to take the text with the changes accepted or rejected; the choice is reported.
// The result is not a round trip: exporting it again does not give back the original file (report.round_trip
// is always 'not_supported'); the original bytes are kept by the caller.
import { randomUUID } from 'node:crypto';
import { validateDocument } from '@pw/editor-core';
import { openZip, ZipError, type ZipFailure } from './zip.ts';
import { child, descendants, elements, parseXml, textOf, XmlError, type XEl, type XNode } from './xml.ts';

export const DOCX_PARSER_VERSION = 'pw-docx-import-1';
export type TrackedChoice = 'accept' | 'reject';
export type DocxLossKind = 'tracked_change' | 'tracked_formatting' | 'list' | 'comment' | 'citation_field' | 'bibliography_field' | 'field' | 'equation' | 'table_layout' | 'image' | 'footnote' | 'link' | 'textbox';
export interface DocxLoss { kind: DocxLossKind; count: number; examples: string[]; note: string }
export interface DocxReport {
  format: 'docx'; parser_version: string; blocks: number; characters: number; losses: DocxLoss[];
  tracked_changes: { insertions: number; deletions: number; choice: TrackedChoice | null };
  round_trip: 'not_supported';
}
export type DocxFailure = ZipFailure | 'NOT_DOCX' | 'LEGACY_DOC' | 'TRACKED_CHANGES_CHOICE' | 'NO_TRACKED_CHANGES';
export class DocxError extends Error {
  readonly reason: DocxFailure;
  readonly details: Record<string, unknown>;
  constructor(message: string, reason: DocxFailure, details: Record<string, unknown> = {}) {
    super(message);
    this.reason = reason;
    this.details = details;
  }
}

const NOTE: Record<DocxLossKind, (choice: TrackedChoice | null) => string> = {
  tracked_change: (c) => (c === 'reject' ? '변경 내용 추적: 변경을 거부한 글(변경 전 원문)을 가져왔습니다. 변경 기록 자체는 옮기지 않았습니다' : '변경 내용 추적: 변경을 수락한 글을 가져왔습니다. 변경 기록 자체는 옮기지 않았습니다'),
  tracked_formatting: () => '서식 변경 추적은 옮기지 않았습니다(현재 서식만 남음)',
  list: () => '목록의 번호·글머리 기호는 옮기지 않았습니다(항목은 일반 문단으로 남음)',
  comment: () => '댓글(메모)은 옮기지 않았습니다 — 댓글이 달린 글자는 남아 있습니다(괄호 안: "댓글이 달린 글자" — 댓글 내용)',
  citation_field: () => '인용 필드(Zotero·Mendeley·EndNote)는 보이는 글자만 남겼습니다 — 문헌 관리기와의 연결은 끊겼습니다. 문헌 탭에서 다시 연결하세요',
  bibliography_field: () => '참고문헌 목록 필드는 글자로만 남겼습니다(자동 갱신되지 않음)',
  field: () => 'Word 필드(상호 참조·쪽 번호 등)는 보이는 글자만 남겼습니다',
  equation: () => '수식은 글자만 남겼습니다(수식 구조·LaTeX로 바꾸지 않음)',
  table_layout: () => '표의 병합 셀·중첩 표 배치는 옮기지 않았습니다(셀 글자는 남음)',
  image: () => '그림·도형은 넣지 않았습니다(그림은 자료에서 따로 추가)',
  footnote: () => '각주·미주는 [1]처럼 글자 표시와 원고 끝의 문단으로 남겼습니다(연결 없음)',
  link: () => '링크 주소를 빼고 글자만 남겼습니다',
  textbox: () => '글상자 안의 글은 글자만 따로 문단으로 남겼습니다',
};

type Mark = 'bold' | 'italic' | 'subscript' | 'superscript';
type Inline = { type: 'text'; text: string; marks?: { type: Mark }[] };
type Block =
  | { type: 'paragraph' | 'heading'; attrs: { id: string; level?: number }; content: Inline[] }
  | { type: 'table'; attrs: { id: string }; content: { type: 'table_row'; content: { type: 'table_cell'; content: Inline[] }[] }[] };

const CITATION = /ZOTERO_ITEM|CSL_CITATION|MENDELEY CITATION|ADDIN EN\.CITE|ADDIN PAPERS2_CITATIONS|ADDIN CITAVI/i;
const BIBLIOGRAPHY = /ZOTERO_BIBL|CSL_BIBLIOGRAPHY|MENDELEY BIBLIOGRAPHY|ADDIN EN\.REFLIST/i;
const MAX_EXAMPLES = 5;
const short = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}…` : s);
const on = (el: XEl | undefined) => !!el && !['0', 'false', 'off'].includes(el.attrs['w:val'] ?? '');

class Report {
  private m = new Map<DocxLossKind, { count: number; examples: string[] }>();
  add(kind: DocxLossKind, example?: string) {
    const e = this.m.get(kind) ?? { count: 0, examples: [] };
    e.count++;
    const ex = example?.replace(/\s+/g, ' ').trim();
    if (ex && e.examples.length < MAX_EXAMPLES && !e.examples.includes(short(ex))) e.examples.push(short(ex));
    this.m.set(kind, e);
  }
  losses(choice: TrackedChoice | null): DocxLoss[] {
    return [...this.m].map(([kind, v]) => ({ kind, count: v.count, examples: v.examples, note: NOTE[kind](choice) }));
  }
}

function sniff(bytes: Buffer) {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xd0cf11e0 && bytes.readUInt32BE(4) === 0xa1b11ae1) {
    throw new DocxError('this is an old Word file (.doc); open it in Word or LibreOffice and save it as .docx', 'LEGACY_DOC');
  }
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new DocxError('this is not a .docx file', 'NOT_DOCX');
}

function part(zip: ReturnType<typeof openZip>, name: string): XEl | null {
  const b = zip.read(name);
  if (!b) return null;
  try {
    return parseXml(b.toString('utf8'));
  } catch (e) {
    if (e instanceof XmlError) throw new DocxError(`${name} is not readable XML: ${e.message}`, 'CORRUPT');
    throw e;
  }
}

export function parseDocx(bytes: Buffer, o: { trackedChanges?: TrackedChoice }): { doc: { type: 'doc'; content: Block[] }; report: DocxReport } {
  sniff(bytes);
  let zip;
  try {
    zip = openZip(bytes);
  } catch (e) {
    if (e instanceof ZipError) throw new DocxError(e.message, e.reason === 'NOT_ZIP' ? 'NOT_DOCX' : e.reason);
    throw e;
  }
  if (!zip.names.includes('[Content_Types].xml') || !zip.names.includes('word/document.xml')) throw new DocxError('this ZIP file is not a Word document (.docx)', 'NOT_DOCX');
  let document: XEl | null;
  let styles: XEl | null;
  let comments: XEl | null;
  let footnotes: XEl | null;
  let endnotes: XEl | null;
  try {
    document = part(zip, 'word/document.xml');
    styles = part(zip, 'word/styles.xml');
    comments = part(zip, 'word/comments.xml');
    footnotes = part(zip, 'word/footnotes.xml');
    endnotes = part(zip, 'word/endnotes.xml');
  } catch (e) {
    if (e instanceof ZipError) throw new DocxError(e.message, e.reason === 'NOT_ZIP' ? 'NOT_DOCX' : e.reason);
    throw e;
  }
  const body = document && child(document, 'w:body');
  if (!body) throw new DocxError('the document has no body', 'CORRUPT');

  // tracked insertions and deletions of text (not of paragraph marks, which sit in w:rPr)
  const changes = (names: string[]) => names.reduce((n, name) => n + descendants(body, name).filter((e) => elements(e).length > 0).length, 0);
  const insertions = changes(['w:ins', 'w:moveTo']);
  const deletions = changes(['w:del', 'w:moveFrom']);
  const choice = o.trackedChanges ?? null;
  if (insertions + deletions > 0 && !choice) {
    throw new DocxError('the document has tracked changes that are not resolved; choose to import the text with the changes accepted or rejected', 'TRACKED_CHANGES_CHOICE', { insertions, deletions });
  }
  if (insertions + deletions === 0 && choice) throw new DocxError('the document has no tracked changes to accept or reject', 'NO_TRACKED_CHANGES');

  const styleName = new Map<string, string>();
  for (const s of styles ? elements(styles, 'w:style') : []) {
    const id = s.attrs['w:styleId'];
    const name = child(s, 'w:name')?.attrs['w:val'];
    if (id && name) styleName.set(id, name);
  }
  const headingLevel = (styleId: string | undefined): number | null => {
    if (!styleId) return null;
    const name = (styleName.get(styleId) ?? styleId).toLowerCase().replace(/\s+/g, ' ').trim();
    if (name === 'title') return 1;
    const m = /^heading ?([1-6])$/.exec(name);
    return m ? Number(m[1]) : null;
  };
  const commentText = new Map<string, string>();
  for (const c of comments ? elements(comments, 'w:comment') : []) commentText.set(c.attrs['w:id'] ?? '', textOf(c));
  const noteText = new Map<string, string>();
  for (const [kind, root] of [['footnote', footnotes], ['endnote', endnotes]] as const) {
    for (const n of root ? elements(root, `w:${kind}`) : []) {
      if (n.attrs['w:type'] && n.attrs['w:type'] !== 'normal') continue; // separators
      noteText.set(`${kind}:${n.attrs['w:id']}`, elements(n, 'w:p').map((x) => textOf(x)).join(' ').trim());
    }
  }

  const report = new Report();
  const blocks: Block[] = [];
  const notes: string[] = [];
  const anchors = new Map<string, string>(); // comment id → anchored text so far
  const open = new Set<string>();
  let characters = 0;

  // one paragraph's (or cell's) inline content
  function inlines(p: XEl): Inline[] {
    const out: Inline[] = [];
    const fields: { instr: string; phase: 'instr' | 'result'; result: string }[] = [];
    const emit = (text: string, marks: Mark[]) => {
      if (!text) return;
      if (fields.some((f) => f.phase === 'instr')) return; // field instructions are not text
      for (const f of fields) f.result += text;
      for (const id of open) anchors.set(id, (anchors.get(id) ?? '') + text);
      characters += text.length;
      const last = out.at(-1);
      const key = marks.slice().sort().join(',');
      if (last && (last.marks ?? []).map((m) => m.type).sort().join(',') === key) last.text += text;
      else out.push(marks.length ? { type: 'text', text, marks: marks.map((type) => ({ type })) } : { type: 'text', text });
    };
    const endField = () => {
      const f = fields.pop();
      if (!f) return;
      if (CITATION.test(f.instr)) report.add('citation_field', f.result);
      else if (BIBLIOGRAPHY.test(f.instr)) report.add('bibliography_field', f.result);
      else if (f.instr.trim()) report.add('field', `${f.instr.trim().split(/\s+/)[0]}: ${f.result}`);
    };
    const run = (r: XEl) => {
      const rPr = child(r, 'w:rPr');
      const marks: Mark[] = [];
      if (rPr) {
        if (on(child(rPr, 'w:b'))) marks.push('bold');
        if (on(child(rPr, 'w:i'))) marks.push('italic');
        const va = child(rPr, 'w:vertAlign')?.attrs['w:val'];
        if (va === 'subscript') marks.push('subscript');
        else if (va === 'superscript') marks.push('superscript');
        if (child(rPr, 'w:rPrChange')) report.add('tracked_formatting');
      }
      for (const c of r.children) {
        if (typeof c === 'string') continue;
        switch (c.name) {
          case 'w:t': case 'w:delText': emit(c.children.filter((x): x is string => typeof x === 'string').join(''), marks); break;
          case 'w:tab': case 'w:br': case 'w:cr': emit(' ', marks); break;
          case 'w:noBreakHyphen': emit('-', marks); break;
          case 'w:fldChar': {
            const t = c.attrs['w:fldCharType'];
            if (t === 'begin') fields.push({ instr: '', phase: 'instr', result: '' });
            else if (t === 'separate' && fields.length) fields.at(-1)!.phase = 'result';
            else if (t === 'end') endField();
            break;
          }
          case 'w:instrText': if (fields.length) fields.at(-1)!.instr += textOf({ name: 'x', attrs: {}, children: [c] }, ['w:instrText']); break;
          case 'w:drawing': case 'w:pict': case 'w:object': {
            const name = descendants(c, 'wp:docPr')[0]?.attrs.name;
            report.add('image', name);
            for (const tb of descendants(c, 'w:txbxContent')) { report.add('textbox', textOf(tb)); notes.push(textOf(tb)); }
            break;
          }
          case 'w:footnoteReference': case 'w:endnoteReference': {
            const kind = c.name === 'w:footnoteReference' ? 'footnote' : 'endnote';
            const n = notes.length + 1;
            const t = noteText.get(`${kind}:${c.attrs['w:id']}`) ?? '';
            notes.push(`[${n}] ${t}`.trim());
            report.add('footnote', t);
            emit(`[${n}]`, []);
            break;
          }
          default: break;
        }
      }
    };
    const walk = (e: XEl) => {
      for (const c of e.children) {
        if (typeof c === 'string') continue;
        switch (c.name) {
          case 'w:r': run(c); break;
          case 'w:ins': case 'w:moveTo': if (choice !== 'reject') walk(c); break;
          case 'w:del': case 'w:moveFrom': if (choice === 'reject') walk(c); break;
          case 'w:hyperlink': {
            const before = characters;
            walk(c);
            if (characters > before) report.add('link', textOf(c, ['w:t']));
            break;
          }
          case 'w:fldSimple': {
            fields.push({ instr: c.attrs['w:instr'] ?? '', phase: 'result', result: '' });
            walk(c);
            endField();
            break;
          }
          case 'w:smartTag': case 'w:customXml': case 'w:sdt': case 'w:sdtContent': walk(c); break;
          case 'm:oMath': case 'm:oMathPara': {
            const t = textOf(c, ['m:t']);
            report.add('equation', t);
            emit(t, []);
            break;
          }
          case 'w:commentRangeStart': open.add(c.attrs['w:id'] ?? ''); break;
          case 'w:commentRangeEnd': open.delete(c.attrs['w:id'] ?? ''); break;
          default: break;
        }
      }
    };
    walk(p);
    while (fields.length) endField(); // an unterminated field: its text stays, reported
    return out;
  }

  function paragraph(p: XEl) {
    const pPr = child(p, 'w:pPr');
    const level = headingLevel(pPr ? child(pPr, 'w:pStyle')?.attrs['w:val'] : undefined);
    const content = inlines(p);
    if (!content.some((i) => i.text.trim())) return;
    if (pPr && child(pPr, 'w:numPr') && !level) report.add('list', content.map((i) => i.text).join(''));
    blocks.push(level ? { type: 'heading', attrs: { id: randomUUID(), level }, content } : { type: 'paragraph', attrs: { id: randomUUID() }, content });
  }

  function table(t: XEl) {
    let layout = false;
    const rows: { type: 'table_row'; content: { type: 'table_cell'; content: Inline[] }[] }[] = [];
    for (const tr of elements(t, 'w:tr')) {
      const cells: { type: 'table_cell'; content: Inline[] }[] = [];
      for (const tc of elements(tr, 'w:tc')) {
        const tcPr = child(tc, 'w:tcPr');
        if (tcPr && (child(tcPr, 'w:gridSpan') || child(tcPr, 'w:vMerge') || child(tcPr, 'w:hMerge'))) layout = true;
        if (descendants(tc, 'w:tbl').length) layout = true;
        const content: Inline[] = [];
        // every paragraph of the cell (nested tables' paragraphs too), in order, separated by a space
        for (const p of descendants(tc, 'w:p')) {
          const part = inlines(p);
          if (content.length && part.length) content.push({ type: 'text', text: ' ' });
          content.push(...part);
        }
        cells.push({ type: 'table_cell', content: content.filter((i) => i.text) });
      }
      if (cells.length) rows.push({ type: 'table_row', content: cells });
    }
    if (layout) report.add('table_layout', rows[0]?.content.map((c) => c.content.map((i) => i.text).join('')).join(' | '));
    if (rows.length) blocks.push({ type: 'table', attrs: { id: randomUUID() }, content: rows });
  }

  const walkBody = (e: XEl) => {
    for (const c of e.children as XNode[]) {
      if (typeof c === 'string') continue;
      if (c.name === 'w:p') paragraph(c);
      else if (c.name === 'w:tbl') table(c);
      else if (c.name === 'w:sdt' || c.name === 'w:sdtContent' || c.name === 'w:customXml') walkBody(c);
    }
  };
  walkBody(body);
  for (const n of notes) if (n.trim()) blocks.push({ type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text: n }] });
  for (const [id, text] of commentText) report.add('comment', `"${anchors.get(id) ?? ''}" — ${text}`);
  if (insertions + deletions > 0) for (let k = 0; k < insertions + deletions; k++) report.add('tracked_change');

  const doc = { type: 'doc' as const, content: blocks };
  const v = validateDocument(doc, 1);
  if (!v.ok) throw new DocxError(`the converted document is not valid: ${v.errors[0]?.message ?? 'unknown'}`, 'CORRUPT');
  return {
    doc,
    report: {
      format: 'docx', parser_version: DOCX_PARSER_VERSION, blocks: blocks.length, characters, losses: report.losses(choice),
      tracked_changes: { insertions, deletions, choice }, round_trip: 'not_supported',
    },
  };
}
