// DOCX → the shared editor document, with a loss report (PW-055, spec 10 "가져오기"). Nothing that cannot be
// carried over as such is dropped silently: each kind is counted, with examples and a note; an element this
// reader does not know that holds text keeps its text and is reported as "other".
// - Kept: paragraphs; headings by style (the style's own name in styles.xml, so Korean Word's numbered style
//   ids work: "heading 1".."heading 6", "Title"); bold, italic, subscript, superscript; tables (cell text);
//   Symbol-font characters as their Unicode characters (μ, ±, ≤ …); the chosen branch of mc:AlternateContent.
// - Kept as text and reported: citation and bibliography fields and content controls (Zotero, Mendeley,
//   EndNote, CSL, Word's own — the shown text stays, the link to the library does not), other fields,
//   equations (their characters), links (text only), footnotes and endnotes (a [n] marker, the note as a
//   paragraph at the end), text boxes (a paragraph at the end), symbols of other fonts (□).
// - Dropped and reported: comments (the anchored text stays; the comment is listed), images and shapes,
//   embedded objects (e.g. MathType), hidden text, merged or nested table cells' layout, list numbers and
//   bullets, tracked formatting changes.
// - Tracked insertions and deletions (of text, paragraph marks and table rows, in the body and the notes) are
//   never resolved silently: with any present, the owner must choose to take the text with the changes
//   accepted or rejected; the choice is reported.
// Untrusted input: part sizes, element counts and nesting are bounded (zip.ts, xml.ts); blocks too.
// The result is not a round trip: exporting it again does not give back the original file (report.round_trip
// is always 'not_supported'); the original bytes are kept by the caller.
import { randomUUID } from 'node:crypto';
import { validateDocument } from '@pw/editor-core';
import { openZip, ZipError, type ZipFailure } from './zip.ts';
import { child, descendants, elements, parseXml, textOf, XmlError, type XEl } from './xml.ts';

export const DOCX_PARSER_VERSION = 'pw-docx-import-4';
export const MAX_BLOCKS = 50_000;
export type TrackedChoice = 'accept' | 'reject';
export type DocxLossKind =
  | 'tracked_change' | 'tracked_formatting' | 'list' | 'comment' | 'citation_field' | 'bibliography_field' | 'field' | 'equation' | 'table_layout'
  | 'image' | 'embedded_object' | 'textbox' | 'footnote' | 'link' | 'symbol' | 'hidden_text' | 'other';
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
  citation_field: () => '인용 필드(Zotero·Mendeley·EndNote·Word 인용)는 보이는 글자만 남겼습니다 — 문헌 관리기와의 연결은 끊겼습니다. 문헌 탭에서 다시 연결하세요',
  bibliography_field: () => '참고문헌 목록 필드는 글자로만 남겼습니다(자동 갱신되지 않음)',
  field: () => 'Word 필드(상호 참조·쪽 번호 등)는 보이는 글자만 남겼습니다',
  equation: () => '수식은 글자만 남겼습니다(수식 구조·LaTeX로 바꾸지 않음)',
  table_layout: () => '표의 병합 셀·중첩 표 배치는 옮기지 않았습니다(셀 글자는 남음)',
  image: () => '그림·도형은 넣지 않았습니다(그림은 자료에서 따로 추가)',
  embedded_object: () => '포함된 개체(MathType 수식, Excel 표 등)는 넣지 않았습니다 — 원본 파일에서 확인하세요',
  textbox: () => '글상자 안의 글은 원고 끝에 "[글상자]" 문단으로 남겼습니다(위치는 옮기지 않음)',
  footnote: () => '각주·미주는 [1]처럼 글자 표시와 원고 끝의 문단으로 남겼습니다(연결 없음)',
  link: () => '링크 주소를 빼고 글자만 남겼습니다',
  symbol: () => '알 수 없는 기호 글꼴의 문자는 □로 남겼습니다 — 원본에서 확인하세요',
  hidden_text: () => '숨긴 글자(Word "숨김" 서식)는 가져오지 않았습니다',
  other: () => '이 변환기가 모르는 요소의 글자는 그대로 남겼습니다(서식·구조는 옮기지 않음)',
};

type Mark = 'bold' | 'italic' | 'subscript' | 'superscript';
type Inline = { type: 'text'; text: string; marks?: { type: Mark }[] };
type Block =
  | { type: 'paragraph' | 'heading'; attrs: { id: string; level?: number }; content: Inline[] }
  | { type: 'table'; attrs: { id: string }; content: { type: 'table_row'; content: { type: 'table_cell'; content: Inline[] }[] }[] };

const CITATION = /ZOTERO_ITEM|CSL_CITATION|MENDELEY.?CITATION|ADDIN EN\.CITE|ADDIN PAPERS2_CITATIONS|ADDIN CITAVI|^\s*CITATION\b/i;
const BIBLIOGRAPHY = /ZOTERO_BIBL|CSL_BIBLIOGRAPHY|MENDELEY.?BIBLIOGRAPHY|ADDIN EN\.REFLIST|^\s*BIBLIOGRAPHY\b/i;
const MAX_EXAMPLES = 5;
const short = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}…` : s);
const on = (el: XEl | undefined) => !!el && !['0', 'false', 'off'].includes(el.attrs['w:val'] ?? '');
const EMPTY: XEl = { name: '', attrs: {}, children: [] };
// elements that carry no text of their own (properties, markers); anything else unknown holding text is reported
const SILENT = new Set(['w:rPr', 'w:pPr', 'w:proofErr', 'w:bookmarkStart', 'w:bookmarkEnd', 'w:permStart', 'w:permEnd', 'w:lastRenderedPageBreak', 'w:softHyphen',
  'w:commentReference', 'w:annotationRef', 'w:footnoteRef', 'w:endnoteRef', 'w:separator', 'w:continuationSeparator', 'w:moveFromRangeStart', 'w:moveFromRangeEnd',
  'w:moveToRangeStart', 'w:moveToRangeEnd', 'w:customXmlInsRangeStart', 'w:customXmlInsRangeEnd', 'w:customXmlDelRangeStart', 'w:customXmlDelRangeEnd', 'w:sectPr', 'w:sdtPr', 'w:sdtEndPr',
  'w:dayLong', 'w:dayShort', 'w:monthLong', 'w:monthShort', 'w:yearLong', 'w:yearShort', 'w:pgNum', 'w:contentPart', 'w:tblPr', 'w:tblGrid', 'w:trPr', 'w:tcPr']);

// the Symbol font's private-use code points (F020–F0FF, or 20–FF) → Unicode (Adobe Symbol encoding)
const SYMBOL: Record<number, string> = {};
{
  const greekUpper = 'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ';
  const greekLower = 'αβχδεφγηιϕκλμνοπθρστυϖωξψζ';
  for (let k = 0; k < 26; k++) { SYMBOL[0x41 + k] = greekUpper[k]!; SYMBOL[0x61 + k] = greekLower[k]!; }
  for (let c = 0x20; c <= 0x3f; c++) SYMBOL[c] = String.fromCharCode(c);
  Object.assign(SYMBOL, {
    0x22: '∀', 0x24: '∃', 0x27: '∋', 0x2a: '∗', 0x2d: '−', 0x40: '≅', 0x5b: '[', 0x5c: '∴', 0x5d: ']', 0x5e: '⊥', 0x5f: '_', 0x7b: '{', 0x7c: '|', 0x7d: '}', 0x7e: '∼',
    0xa1: 'ϒ', 0xa2: '′', 0xa3: '≤', 0xa4: '⁄', 0xa5: '∞', 0xa6: 'ƒ', 0xa7: '♣', 0xa8: '♦', 0xa9: '♥', 0xaa: '♠', 0xab: '↔', 0xac: '←', 0xad: '↑', 0xae: '→', 0xaf: '↓',
    0xb0: '°', 0xb1: '±', 0xb2: '″', 0xb3: '≥', 0xb4: '×', 0xb5: '∝', 0xb6: '∂', 0xb7: '•', 0xb8: '÷', 0xb9: '≠', 0xba: '≡', 0xbb: '≈', 0xbc: '…',
    0xc0: 'ℵ', 0xc1: 'ℑ', 0xc2: 'ℜ', 0xc3: '℘', 0xc4: '⊗', 0xc5: '⊕', 0xc6: '∅', 0xc7: '∩', 0xc8: '∪', 0xc9: '⊃', 0xca: '⊇', 0xcb: '⊄', 0xcc: '⊂', 0xcd: '⊆', 0xce: '∈', 0xcf: '∉',
    0xd0: '∠', 0xd1: '∇', 0xd5: '∏', 0xd6: '√', 0xd7: '⋅', 0xd8: '¬', 0xd9: '∧', 0xda: '∨', 0xdb: '⇔', 0xdc: '⇐', 0xdd: '⇑', 0xde: '⇒', 0xdf: '⇓',
    0xe0: '◊', 0xe1: '〈', 0xe5: '∑', 0xf1: '〉', 0xf2: '∫',
  });
}

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

// every failure of reading an untrusted file is a DocxError with a reason (never a raw crash)
function asDocxError(e: unknown): never {
  if (e instanceof DocxError) throw e;
  if (e instanceof ZipError) throw new DocxError(e.message, e.reason === 'NOT_ZIP' ? 'NOT_DOCX' : e.reason);
  if (e instanceof XmlError) throw new DocxError(`a part is not readable: ${e.message}`, e.tooLarge ? 'TOO_LARGE' : 'CORRUPT');
  if (e instanceof RangeError) throw new DocxError('the document is nested too deeply to read', 'CORRUPT');
  throw e;
}

function part(zip: ReturnType<typeof openZip>, name: string): XEl | null {
  const b = zip.read(name);
  return b ? parseXml(b.toString('utf8')) : null;
}

// tracked changes of text runs, of paragraph marks (w:pPr/w:rPr/w:ins|w:del) and of table rows (w:trPr/…)
function countChanges(root: XEl): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  const visit = (e: XEl, path: string) => {
    const kind = e.name === 'w:ins' || e.name === 'w:moveTo' ? 'ins' : e.name === 'w:del' || e.name === 'w:moveFrom' ? 'del' : null;
    if (kind && (elements(e).length > 0 || path.endsWith('w:pPr/w:rPr') || path.endsWith('w:trPr'))) {
      if (kind === 'ins') insertions++;
      else deletions++;
    }
    for (const c of elements(e)) visit(c, `${path.split('/').slice(-1)[0]}/${e.name}`);
  };
  visit(root, '');
  return { insertions, deletions };
}

export function parseDocx(bytes: Buffer, o: { trackedChanges?: TrackedChoice }): { doc: { type: 'doc'; content: Block[] }; report: DocxReport } {
  try {
    return convert(bytes, o);
  } catch (e) {
    return asDocxError(e);
  }
}

function convert(bytes: Buffer, o: { trackedChanges?: TrackedChoice }): { doc: { type: 'doc'; content: Block[] }; report: DocxReport } {
  sniff(bytes);
  const zip = openZip(bytes);
  if (!zip.names.includes('[Content_Types].xml') || !zip.names.includes('word/document.xml')) throw new DocxError('this ZIP file is not a Word document (.docx)', 'NOT_DOCX');
  const document = part(zip, 'word/document.xml');
  const styles = part(zip, 'word/styles.xml');
  const comments = part(zip, 'word/comments.xml');
  const footnotes = part(zip, 'word/footnotes.xml');
  const endnotes = part(zip, 'word/endnotes.xml');
  const body = document && child(document, 'w:body');
  if (!body) throw new DocxError('the document has no body', 'CORRUPT');

  let insertions = 0;
  let deletions = 0;
  for (const root of [body, footnotes, endnotes]) {
    if (!root) continue;
    const c = countChanges(root);
    insertions += c.insertions;
    deletions += c.deletions;
  }
  const choice = o.trackedChanges ?? null;
  if (insertions + deletions > 0 && !choice) {
    throw new DocxError('the document has tracked changes that are not resolved; choose to import the text with the changes accepted or rejected', 'TRACKED_CHANGES_CHOICE', { insertions, deletions });
  }
  if (insertions + deletions === 0 && choice) throw new DocxError('the document has no tracked changes to accept or reject', 'NO_TRACKED_CHANGES');
  // a paragraph mark or table row the choice removes: deleted when accepting, inserted when rejecting
  const removed = (props: XEl | undefined) => !!props && (choice === 'accept' ? !!(child(props, 'w:del') ?? child(props, 'w:moveFrom')) : choice === 'reject' ? !!(child(props, 'w:ins') ?? child(props, 'w:moveTo')) : false);

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
  const noteEl = new Map<string, XEl>();
  for (const [kind, root] of [['footnote', footnotes], ['endnote', endnotes]] as const) {
    for (const n of root ? elements(root, `w:${kind}`) : []) {
      if (n.attrs['w:type'] && n.attrs['w:type'] !== 'normal') continue; // separators
      noteEl.set(`${kind}:${n.attrs['w:id']}`, n);
    }
  }

  const report = new Report();
  const blocks: Block[] = [];
  const notes: string[] = [];
  const noteNumber = new Map<string, number>();
  const boxes: string[] = [];
  const anchors = new Map<string, string>(); // comment id → anchored text so far
  const open = new Set<string>();
  const state = { characters: 0, inNote: 0, carry: null as { content: Inline[] } | null };
  const push = (b: Block) => {
    if (blocks.length >= MAX_BLOCKS) throw new DocxError(`more than ${MAX_BLOCKS} paragraphs and tables`, 'TOO_LARGE');
    blocks.push(b);
  };
  const plain = (xs: Inline[]) => xs.map((i) => i.text).join('');
  // mc:AlternateContent: mc:Choice when it holds anything this reader uses (text or a reported element),
  // else mc:Fallback (re-review n1)
  const branchOf = (c: XEl): XEl | undefined => {
    const pick = child(c, 'mc:Choice');
    const useful = !!pick && (textOf(pick).trim() !== '' || ['w:drawing', 'w:pict', 'w:object', 'w:sym', 'm:oMath'].some((n) => descendants(pick, n).length > 0));
    return useful ? pick : child(c, 'mc:Fallback');
  };
  // the outermost elements of this name below e (a text box inside a text box is found while reading the outer one)
  const outermost = (e: XEl, name: string, found: XEl[] = []): XEl[] => {
    for (const c of elements(e)) { if (c.name === name) found.push(c); else outermost(c, name, found); }
    return found;
  };

  // one paragraph's (or cell's, or note's) inline content
  function inlines(p: XEl): Inline[] {
    const out: Inline[] = [];
    const fields: { instr: string; phase: 'instr' | 'result'; result: string }[] = [];
    const emit = (text: string, marks: Mark[]) => {
      if (!text) return;
      if (fields.some((f) => f.phase === 'instr')) return; // field instructions are not text
      for (const f of fields) f.result += text;
      for (const id of open) anchors.set(id, (anchors.get(id) ?? '') + text);
      state.characters += text.length;
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
    // a drawing, picture or object: a text box keeps its text (at the end), anything else is reported
    const shape = (c: XEl) => {
      const tb = outermost(c, 'w:txbxContent');
      if (tb.length) {
        // read like body text (symbols, the tracked-change choice, hidden text, fields: re-review m1')
        for (const t of tb) {
          const s = elements(t, 'w:p').map((x) => plain(inlines(x))).filter((x) => x.trim()).join(' ').trim();
          if (s) { boxes.push(s); report.add('textbox', s); }
        }
        return;
      }
      if (c.name === 'w:object') {
        report.add('embedded_object', descendants(c, 'o:OLEObject')[0]?.attrs.ProgID ?? 'object');
        return;
      }
      report.add('image', descendants(c, 'wp:docPr')[0]?.attrs.name);
    };
    // the branch of mc:AlternateContent this reader understands: mc:Choice when it holds anything, else mc:Fallback
    const alternate = (c: XEl, each: (x: XEl) => void) => {
      const branch = branchOf(c);
      if (branch) each(branch);
    };
    const run = (r: XEl) => {
      const rPr = child(r, 'w:rPr');
      const marks: Mark[] = [];
      if (rPr) {
        if (on(child(rPr, 'w:vanish')) || on(child(rPr, 'w:specVanish'))) {
          const hidden = textOf(r);
          if (hidden.trim()) report.add('hidden_text', hidden);
          return;
        }
        if (on(child(rPr, 'w:b'))) marks.push('bold');
        if (on(child(rPr, 'w:i'))) marks.push('italic');
        const va = child(rPr, 'w:vertAlign')?.attrs['w:val'];
        if (va === 'subscript') marks.push('subscript');
        else if (va === 'superscript') marks.push('superscript');
        if (child(rPr, 'w:rPrChange')) report.add('tracked_formatting');
      }
      const runChild = (c: XEl) => {
        switch (c.name) {
          case 'w:t': case 'w:delText': emit(c.children.filter((x): x is string => typeof x === 'string').join(''), marks); break;
          case 'w:tab': case 'w:ptab': case 'w:br': case 'w:cr': emit(' ', marks); break;
          case 'w:noBreakHyphen': emit('-', marks); break;
          case 'w:sym': {
            const font = c.attrs['w:font'] ?? '';
            let code = parseInt(c.attrs['w:char'] ?? '', 16);
            if (code >= 0xf000) code -= 0xf000;
            const ch = /^symbol$/i.test(font) ? SYMBOL[code] : undefined;
            if (ch) emit(ch, marks);
            else { report.add('symbol', `${font} ${c.attrs['w:char'] ?? ''}`); emit('□', marks); }
            break;
          }
          case 'w:fldChar': {
            const t = c.attrs['w:fldCharType'];
            if (t === 'begin') fields.push({ instr: '', phase: 'instr', result: '' });
            else if (t === 'separate' && fields.length) fields.at(-1)!.phase = 'result';
            else if (t === 'end') endField();
            break;
          }
          case 'w:instrText': if (fields.length) fields.at(-1)!.instr += textOf({ name: 'x', attrs: {}, children: [c] }, ['w:instrText']); break;
          case 'w:drawing': case 'w:pict': case 'w:object': shape(c); break;
          case 'mc:AlternateContent': alternate(c, (b) => { for (const x of elements(b)) runChild(x); }); break;
          case 'w:footnoteReference': case 'w:endnoteReference': {
            // Word has no notes inside notes: a reference there is not followed (it could repeat without end;
            // re-review R1) — shown as [?] and reported
            if (state.inNote > 0) {
              report.add('other', `note reference inside a note: ${c.attrs['w:id'] ?? ''}`);
              emit('[?]', []);
              break;
            }
            const kind = c.name === 'w:footnoteReference' ? 'footnote' : 'endnote';
            const key = `${kind}:${c.attrs['w:id']}`;
            // each note is read once: a repeated reference shows the first number (Word references a note
            // once; re-reading it per reference would multiply the work: third review R1')
            const seen = noteNumber.get(key);
            if (seen !== undefined) {
              report.add('other', `repeated note reference: ${key} → [${seen}]`);
              emit(`[${seen}]`, []);
              break;
            }
            const n = notes.length + 1;
            noteNumber.set(key, n);
            notes.push(''); // the number is taken before the note is read
            const el = noteEl.get(key);
            // read like body text: the tracked-change choice and fields apply inside notes too
            state.inNote++;
            let t: string;
            try {
              t = el ? elements(el, 'w:p').map((x) => plain(inlines(x))).filter((x) => x.trim()).join(' ').trim() : '';
            } finally {
              state.inNote--;
            }
            notes[n - 1] = `[${n}] ${t}`.trim();
            report.add('footnote', t);
            emit(`[${n}]`, []);
            break;
          }
          default:
            if (!SILENT.has(c.name)) {
              const t = textOf(c);
              if (t.trim()) { report.add('other', `${c.name}: ${t}`); emit(t, marks); }
            }
            break;
        }
      };
      for (const c of elements(r)) runChild(c);
    };
    const sdtKind = (sdt: XEl): 'citation' | 'bibliography' | null => {
      const pr = child(sdt, 'w:sdtPr');
      if (!pr) return null;
      if (child(pr, 'w:citation')) return 'citation';
      if (child(pr, 'w:bibliography')) return 'bibliography';
      const tag = `${child(pr, 'w:tag')?.attrs['w:val'] ?? ''} ${child(pr, 'w:alias')?.attrs['w:val'] ?? ''}`;
      return /CITATION/i.test(tag) ? 'citation' : /BIBLIOGRAPHY/i.test(tag) ? 'bibliography' : null;
    };
    const walk = (e: XEl) => {
      for (const c of elements(e)) {
        switch (c.name) {
          case 'w:r': run(c); break;
          // text directly in a container this reader does not know (re-review n3)
          case 'w:t': emit(c.children.filter((x): x is string => typeof x === 'string').join(''), []); break;
          case 'w:ins': case 'w:moveTo': if (choice !== 'reject') walk(c); break;
          case 'w:del': case 'w:moveFrom': if (choice === 'reject') walk(c); break;
          case 'w:hyperlink': {
            const before = state.characters;
            walk(c);
            if (state.characters > before) report.add('link', textOf(c, ['w:t']));
            break;
          }
          case 'w:fldSimple': {
            fields.push({ instr: c.attrs['w:instr'] ?? '', phase: 'result', result: '' });
            walk(c);
            endField();
            break;
          }
          case 'w:sdt': {
            const kind = sdtKind(c);
            const content = child(c, 'w:sdtContent') ?? EMPTY;
            if (kind) {
              fields.push({ instr: kind === 'citation' ? 'CITATION' : 'BIBLIOGRAPHY', phase: 'result', result: '' });
              walk(content);
              endField();
            } else walk(content);
            break;
          }
          case 'w:smartTag': case 'w:customXml': case 'w:sdtContent': case 'w:dir': case 'w:bdo': walk(c); break;
          case 'mc:AlternateContent': alternate(c, walk); break;
          case 'm:oMath': case 'm:oMathPara': {
            const t = textOf(c, ['m:t']);
            report.add('equation', t);
            emit(t, []);
            break;
          }
          case 'w:commentRangeStart': open.add(c.attrs['w:id'] ?? ''); break;
          case 'w:commentRangeEnd': open.delete(c.attrs['w:id'] ?? ''); break;
          default:
            if (!SILENT.has(c.name) && textOf(c).trim()) {
              report.add('other', `${c.name}: ${textOf(c)}`);
              walk(c);
            }
            break;
        }
      }
    };
    walk(p);
    while (fields.length) endField(); // an unterminated field: its text stays, reported
    return out;
  }

  function flushPara(content: Inline[], level: number | null) {
    if (!content.some((i) => i.text.trim())) return; // empty paragraphs are not kept
    const last = content.at(-1)!;
    last.text = last.text.replace(/\s+$/, '');
    if (!last.text) content.pop();
    push(level ? { type: 'heading', attrs: { id: randomUUID(), level }, content } : { type: 'paragraph', attrs: { id: randomUUID() }, content });
  }
  const flushCarry = () => {
    if (state.carry) flushPara(state.carry.content, null);
    state.carry = null;
  };
  // a paragraph whose mark the choice removes joins the next one, which keeps its own style (as Word: the
  // surviving paragraph mark carries the properties; re-review m2')
  function paragraph(p: XEl) {
    const pPr = child(p, 'w:pPr');
    const level = headingLevel(pPr ? child(pPr, 'w:pStyle')?.attrs['w:val'] : undefined);
    let content = inlines(p);
    if (pPr && child(pPr, 'w:numPr') && !level && content.some((i) => i.text.trim())) report.add('list', plain(content));
    if (state.carry) {
      content = [...state.carry.content, ...content];
      state.carry = null;
    }
    if (removed(pPr ? child(pPr, 'w:rPr') : undefined)) {
      state.carry = { content };
      return;
    }
    flushPara(content, level);
  }

  function table(t: XEl) {
    let layout = false;
    const rows: { type: 'table_row'; content: { type: 'table_cell'; content: Inline[] }[] }[] = [];
    for (const tr of elements(t, 'w:tr')) {
      if (removed(child(tr, 'w:trPr'))) continue;
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
    if (layout) report.add('table_layout', rows[0]?.content.map((c) => plain(c.content)).join(' | '));
    if (rows.length) push({ type: 'table', attrs: { id: randomUUID() }, content: rows });
  }

  const walkBody = (e: XEl) => {
    for (const c of elements(e)) {
      switch (c.name) {
        case 'w:p': paragraph(c); break;
        case 'w:tbl': flushCarry(); table(c); break;
        case 'w:sdt': {
          const pr = child(c, 'w:sdtPr');
          const tag = child(pr ?? EMPTY, 'w:tag')?.attrs['w:val'] ?? '';
          if (pr && (child(pr, 'w:bibliography') || /BIBLIOGRAPHY/i.test(tag))) report.add('bibliography_field', textOf(c));
          walkBody(child(c, 'w:sdtContent') ?? EMPTY);
          break;
        }
        case 'w:customXml': case 'w:sdtContent': walkBody(c); break;
        case 'w:ins': case 'w:moveTo': if (choice !== 'reject') walkBody(c); break;
        case 'w:del': case 'w:moveFrom': if (choice === 'reject') walkBody(c); break;
        case 'mc:AlternateContent': walkBody(branchOf(c) ?? EMPTY); break;
        default:
          if (!SILENT.has(c.name) && textOf(c).trim()) { report.add('other', `${c.name}: ${textOf(c)}`); walkBody(c); }
          break;
      }
    }
  };
  walkBody(body);
  flushCarry();
  for (const n of notes) if (n.trim()) push({ type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text: n }] });
  for (const b of boxes) push({ type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text: `[글상자] ${b}` }] });
  for (const [id, text] of commentText) report.add('comment', `"${anchors.get(id) ?? ''}" — ${text}`);
  for (let k = 0; k < insertions + deletions; k++) report.add('tracked_change');

  const doc = { type: 'doc' as const, content: blocks };
  const v = validateDocument(doc, 1);
  if (!v.ok) throw new DocxError(`the converted document is not valid: ${v.errors[0]?.message ?? 'unknown'}`, 'CORRUPT');
  return {
    doc,
    report: {
      format: 'docx', parser_version: DOCX_PARSER_VERSION, blocks: blocks.length, characters: state.characters, losses: report.losses(choice),
      tracked_changes: { insertions, deletions, choice }, round_trip: 'not_supported',
    },
  };
}
