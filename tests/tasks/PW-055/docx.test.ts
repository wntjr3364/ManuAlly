// PW-055 — reading a .docx into a preview with a loss report (spec 10 "가져오기"). Synthetic files built in
// tests/tasks/PW-055/fixture.ts, plus two made by real producers (LibreOffice, pandoc) and kept as files.
// TST-055A: the owner sees what the conversion lost before anything is imported.
// TST-055B: tracked changes and citation fields are never lost silently; nothing claims a full round trip.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateDocument } from '../../../packages/editor-core/src/index.ts';
import { DocxError, parseDocx } from '../../../packages/domain/src/imports/docx/index.ts';
import { makeDocx, makeZip, p, r, richDocx, CONTENT_TYPES } from './fixture.ts';

type Inline = { type: string; text?: string; marks?: { type: string }[] };
type Block = { type: string; attrs: { id: string; level?: number }; content?: (Inline & { content?: { content?: Inline[] }[] })[] };
const text = (b: Block) => (b.content ?? []).map((i) => i.text ?? '').join('');
const all = (doc: { content: Block[] }) => JSON.stringify(doc);
const loss = (report: { losses: { kind: string; count: number; examples: string[]; note: string }[] }, kind: string) => report.losses.find((l) => l.kind === kind);

describe('TST-055A: a preview with every loss named', () => {
  test('a clean paper: title and headings from the styles (also Korean Word\'s numbered style ids), italic, bold, sub/superscript', () => {
    const doc = makeDocx(p(r('A title'), 'a3') + p(r('Introduction'), '1') + p(r('Methods'), '2')
      + p(`${r('In ')}${r('Arabidopsis thaliana', '<w:i/>')}${r(' H')}${r('2', '<w:vertAlign w:val="subscript"/>')}${r('O and 10')}${r('3', '<w:vertAlign w:val="superscript"/>')}${r(' and ')}${r('not italic', '<w:i w:val="0"/>')}${r(' and ')}${r('bold', '<w:b/>')}`));
    const out = parseDocx(doc, {});
    expect(validateDocument(out.doc, 1).ok).toBe(true);
    const blocks = out.doc.content as Block[];
    expect(blocks.map((b) => [b.type, b.attrs.level ?? null, text(b)])).toEqual([
      ['heading', 1, 'A title'], ['heading', 1, 'Introduction'], ['heading', 2, 'Methods'],
      ['paragraph', null, 'In Arabidopsis thaliana H2O and 103 and not italic and bold'],
    ]);
    const inl = blocks[3]!.content!;
    expect(inl.find((i) => i.text === 'Arabidopsis thaliana')!.marks).toEqual([{ type: 'italic' }]);
    expect(inl.find((i) => i.text === '2')!.marks).toEqual([{ type: 'subscript' }]);
    expect(inl.find((i) => i.text === '3')!.marks).toEqual([{ type: 'superscript' }]);
    // w:i w:val="0" is not italic; the run merges with its unmarked neighbours
    expect(inl.find((i) => i.text!.includes('not italic'))!.marks).toBeUndefined();
    expect(inl.find((i) => i.text === 'bold')!.marks).toEqual([{ type: 'bold' }]);
    // new block ids, all distinct
    expect(new Set(blocks.map((b) => b.attrs.id)).size).toBe(4);
    expect(out.report).toMatchObject({ format: 'docx', blocks: 4, losses: [], round_trip: 'not_supported', tracked_changes: { insertions: 0, deletions: 0, choice: null } });
  });

  test('a rich paper: comments, citation and bibliography fields, an equation, a merged table cell, an image, a footnote and a link are each reported', () => {
    const out = parseDocx(richDocx(), { trackedChanges: 'accept' });
    expect(validateDocument(out.doc, 1).ok).toBe(true);
    const s = all(out.doc as { content: Block[] });
    // kept as text
    for (const t of ['(Kim et al., 2020)', 'This sentence has a comment.', 'k=2.4', 'drought', 'Figure caption text.', 'a linked word', 'Kim J. 2020. A study.']) expect(s).toContain(t);
    // the comment's own text is not put into the manuscript
    expect(s).not.toContain('Please cite the source.');
    // the table stays a table
    expect((out.doc.content as Block[]).some((b) => b.type === 'table')).toBe(true);
    // the footnote: a marker where it was and its text as a paragraph at the end
    expect(s).toContain('Footnoted sentence[1].');
    expect(text((out.doc.content as Block[]).at(-1)!)).toBe('[1] Measured in 2025.');
    const r0 = out.report;
    expect(loss(r0, 'comment')).toMatchObject({ count: 1, examples: [expect.stringContaining('Please cite the source.')] });
    expect(loss(r0, 'citation_field')).toMatchObject({ count: 1, examples: ['(Kim et al., 2020)'] });
    expect(loss(r0, 'bibliography_field')).toMatchObject({ count: 1 });
    expect(loss(r0, 'equation')).toMatchObject({ count: 1, examples: ['k=2.4'] });
    expect(loss(r0, 'table_layout')).toMatchObject({ count: 1 });
    expect(loss(r0, 'image')).toMatchObject({ count: 1 });
    expect(loss(r0, 'footnote')).toMatchObject({ count: 1 });
    expect(loss(r0, 'link')).toMatchObject({ count: 1, examples: ['a linked word'] });
    expect(loss(r0, 'tracked_change')).toMatchObject({ count: 2 });
    for (const l of r0.losses) expect(l.note.length).toBeGreaterThan(5);
  });
});

describe('lists', () => {
  test('list items keep their text; their numbers and bullets are reported, not dropped silently', () => {
    const li = (t: string) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${r(t)}</w:p>`;
    const out = parseDocx(makeDocx(li('First step') + li('Second step') + p(r('Plain.'))), {});
    expect((out.doc.content as Block[]).map(text)).toEqual(['First step', 'Second step', 'Plain.']);
    expect(loss(out.report, 'list')).toMatchObject({ count: 2, examples: ['First step', 'Second step'] });
  });
});

describe('fields', () => {
  test('a field nested in another field\'s instruction (Word IF fields) adds nothing to the text; only the shown result stays', () => {
    const f = (t: string) => `<w:r><w:fldChar w:fldCharType="${t}"/></w:r>`;
    const instr = (t: string) => `<w:r><w:instrText xml:space="preserve">${t}</w:instrText></w:r>`;
    const out = parseDocx(makeDocx(p(`${r('Value: ')}${f('begin')}${instr(' IF ')}${f('begin')}${instr(' REF bm1 ')}${f('separate')}${r('inner')}${f('end')}${instr(' = 1 "yes" "no" ')}${f('separate')}${r('yes')}${f('end')}`)), {});
    expect(JSON.stringify(out.doc)).toContain('Value: yes');
    expect(JSON.stringify(out.doc)).not.toContain('inner');
  });
});

describe('TST-055B: tracked changes need the owner\'s choice; nothing claims a round trip', () => {
  test('unresolved tracked changes: no preview until the owner says which text to take; each choice gives its own text', () => {
    let err: unknown;
    try { parseDocx(richDocx(), {}); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DocxError);
    expect(err).toMatchObject({ reason: 'TRACKED_CHANGES_CHOICE', details: { insertions: 1, deletions: 1 } });
    const accepted = all(parseDocx(richDocx(), { trackedChanges: 'accept' }).doc as { content: Block[] });
    expect(accepted).toContain('The marker was clearly induced.');
    expect(accepted).not.toContain('barely');
    const rejected = parseDocx(richDocx(), { trackedChanges: 'reject' });
    expect(all(rejected.doc as { content: Block[] })).toContain('The marker was barely induced.');
    expect(all(rejected.doc as { content: Block[] })).not.toContain('clearly');
    expect(rejected.report.tracked_changes).toEqual({ insertions: 1, deletions: 1, choice: 'reject' });
    expect(loss(rejected.report, 'tracked_change')!.note).toMatch(/거부|변경 전/);
  });

  test('every report says the conversion is not a round trip', () => {
    for (const out of [parseDocx(makeDocx(p(r('x'))), {}), parseDocx(richDocx(), { trackedChanges: 'reject' })]) {
      expect(out.report.round_trip).toBe('not_supported');
      expect(JSON.stringify(out.report)).not.toMatch(/round_trip":"(full|supported)"/);
    }
  });

  test('a choice for a file without tracked changes is refused (nothing to choose)', () => {
    expect(() => parseDocx(makeDocx(p(r('x'))), { trackedChanges: 'accept' })).toThrow(DocxError);
  });
});

describe('files that are not a plain .docx, or are hostile, are refused before parsing', () => {
  const refused = (b: Buffer, reason: string) => {
    let err: unknown;
    try { parseDocx(b, {}); } catch (e) { err = e; }
    expect(err, reason).toBeInstanceOf(DocxError);
    expect((err as DocxError).reason).toBe(reason);
  };
  test('not a ZIP, an old binary .doc, no document part, an encrypted entry', () => {
    refused(Buffer.from('just some text'), 'NOT_DOCX');
    refused(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]), 'LEGACY_DOC');
    refused(makeZip({ '[Content_Types].xml': CONTENT_TYPES, 'word/other.xml': '<x/>' }), 'NOT_DOCX');
    refused(makeDocx(p(r('x')), {}, { encrypted: true }), 'ENCRYPTED');
  });
  test('a ZIP bomb (a part far larger than allowed when unpacked) and a part that lies about its size', () => {
    refused(makeDocx(p(r('x'.repeat(10))), { extra: { 'word/media/big.bin': Buffer.alloc(60 * 1024 * 1024) } }), 'TOO_LARGE');
    refused(makeDocx(p(r('x')), {}, { declaredSize: 5 }), 'CORRUPT');
  });
  test('a DOCTYPE without any entity is refused too', () => {
    refused(makeZip({ '[Content_Types].xml': CONTENT_TYPES, 'word/document.xml': '<?xml version="1.0"?><!DOCTYPE w:document><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>' }), 'CORRUPT');
  });
  test('a DOCTYPE (external entities) in a part is refused', () => {
    const body = makeZip({ '[Content_Types].xml': CONTENT_TYPES, 'word/document.xml': '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>&e;</w:t></w:r></w:p></w:body></w:document>' });
    refused(body, 'CORRUPT');
  });
});

describe('files made by real word processors (synthetic text)', () => {
  test('LibreOffice: tracked changes and a comment are found and reported', () => {
    const b = readFileSync('tests/tasks/PW-055/fixtures/libreoffice-tracked.docx');
    expect(() => parseDocx(b, {})).toThrow(expect.objectContaining({ reason: 'TRACKED_CHANGES_CHOICE' }));
    const out = parseDocx(b, { trackedChanges: 'accept' });
    expect(validateDocument(out.doc, 1).ok).toBe(true);
    expect(all(out.doc as { content: Block[] })).toContain('Root growth');
    expect(loss(out.report, 'tracked_change')!.count).toBeGreaterThanOrEqual(1);
    expect(loss(out.report, 'comment')!.count).toBe(1);
  });
  test('pandoc: headings, italics, a table and a footnote', () => {
    const b = readFileSync('tests/tasks/PW-055/fixtures/pandoc-paper.docx');
    const out = parseDocx(b, {});
    expect(validateDocument(out.doc, 1).ok).toBe(true);
    const blocks = out.doc.content as Block[];
    expect(blocks.filter((x) => x.type === 'heading').map(text)).toEqual(expect.arrayContaining(['Introduction', 'Results']));
    expect(JSON.stringify(blocks)).toMatch(/"text":"Arabidopsis thaliana","marks":\[\{"type":"italic"\}\]/);
    expect(blocks.some((x) => x.type === 'table')).toBe(true);
    expect(loss(out.report, 'footnote')!.count).toBe(1);
  });
});

// PW-055 review (changes requested): MAJOR 1–2, MINOR 1–4, NIT 1–4
describe('review M1: nothing common in Word papers disappears silently', () => {
  test('Symbol-font characters become their Unicode characters (5 μM, ±, ≤); an unknown symbol font is a reported placeholder', () => {
    const sym = (ch: string, font = 'Symbol') => `<w:r><w:sym w:font="${font}" w:char="${ch}"/></w:r>`;
    const out = parseDocx(makeDocx(p(`${r('5 ')}${sym('F06D')}${r('M, 3 ')}${sym('F0B1')}${r(' 1, p ')}${sym('F0A3')}${r(' 0.05')}${sym('F06C', 'Wingdings')}`)), {});
    const s = text((out.doc.content as Block[])[0]!);
    expect(s).toBe('5 μM, 3 ± 1, p ≤ 0.05□');
    expect(loss(out.report, 'symbol')).toMatchObject({ count: 1, examples: [expect.stringContaining('Wingdings')] });
  });
  test('a text box in mc:AlternateContent (Word 2010+): its text is kept once and reported; the shape is reported', () => {
    const box = '<w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:docPr w:id="3" name="Text Box 1"/><a:graphic xmlns:a="a"><a:graphicData><wps:wsp xmlns:wps="wps"><wps:txbx><w:txbxContent><w:p><w:r><w:t>Box text with 2.4-fold result</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape xmlns:v="v"><v:textbox><w:txbxContent><w:p><w:r><w:t>Box text with 2.4-fold result</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>';
    const out = parseDocx(makeDocx(p(`${r('Before.')}${box}`)), {});
    const s = JSON.stringify(out.doc);
    expect(s.split('Box text with 2.4-fold result').length - 1).toBe(1);
    expect(loss(out.report, 'textbox')).toMatchObject({ count: 1, examples: ['Box text with 2.4-fold result'] });
  });
  test('mc:AlternateContent at paragraph level keeps its text', () => {
    const out = parseDocx(makeDocx(`<w:p><mc:AlternateContent xmlns:mc="mc"><mc:Choice Requires="w14">${r('Chosen text')}</mc:Choice><mc:Fallback>${r('Fallback text')}</mc:Fallback></mc:AlternateContent></w:p>`), {});
    expect(text((out.doc.content as Block[])[0]!)).toBe('Chosen text');
  });
  test('any other element holding text is kept and reported, never dropped', () => {
    const out = parseDocx(makeDocx(p(`${r('A ')}<w:dir w:val="rtl">${r('mirrored')}</w:dir><w:r><w:ruby><w:rubyBase><w:r><w:t>漢字</w:t></w:r></w:rubyBase><w:rt><w:r><w:t>かんじ</w:t></w:r></w:rt></w:ruby></w:r>`)), {});
    const s = text((out.doc.content as Block[])[0]!);
    expect(s).toContain('mirrored');
    expect(s).toContain('漢字');
    expect(loss(out.report, 'other')!.count).toBeGreaterThanOrEqual(1);
  });
});

describe('review M2 / m4: a small hostile file cannot stall or crash the server', () => {
  test('a document part far larger than a paper (unpacked) is refused before parsing', () => {
    const big = makeDocx('<w:p/>'.repeat(4_000_000));
    const t0 = Date.now();
    expect(() => parseDocx(big, {})).toThrow(expect.objectContaining({ reason: 'TOO_LARGE' }));
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  test('too many elements in an allowed size is refused while parsing', () => {
    // under the part size limit (about 8.7 MB) but about a million elements
    const many = makeDocx('<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(250_000));
    const t0 = Date.now();
    expect(() => parseDocx(many, {})).toThrow(expect.objectContaining({ reason: 'TOO_LARGE' }));
    expect(Date.now() - t0).toBeLessThan(8000);
  });
  // each limit alone (the others would not stop these files)
  test('one part over the size limit, with few elements: refused by the part size', () => {
    expect(() => parseDocx(makeDocx(p(r('x'.repeat(11 * 1024 * 1024)))), {})).toThrow(expect.objectContaining({ reason: 'TOO_LARGE' }));
  });
  test('many elements in one small paragraph: refused by the element count', () => {
    expect(() => parseDocx(makeDocx(`<w:p>${'<w:r/>'.repeat(600_000)}${r('x')}</w:p>`), {})).toThrow(expect.objectContaining({ reason: 'TOO_LARGE' }));
  });
  test('more paragraphs than any paper (under the element count): refused by the block count', () => {
    expect(() => parseDocx(makeDocx(p(r('x')).repeat(60_000)), {})).toThrow(expect.objectContaining({ reason: 'TOO_LARGE' }));
  });
  test('nesting just past the limit (no stack overflow involved): refused by the depth', () => {
    expect(() => parseDocx(makeDocx(p('<w:hyperlink>'.repeat(300) + r('x') + '</w:hyperlink>'.repeat(300))), {})).toThrow(expect.objectContaining({ reason: 'CORRUPT' }));
  });
  test('deep nesting is a readable refusal (CORRUPT), not a stack overflow', () => {
    const deep = '<w:hyperlink>'.repeat(200_000) + r('x') + '</w:hyperlink>'.repeat(200_000);
    expect(() => parseDocx(makeDocx(p(deep)), {})).toThrow(expect.objectContaining({ reason: 'CORRUPT' }));
  });
  test('a ">" inside an attribute value does not cut the tag (the field instruction is read whole)', () => {
    const out = parseDocx(makeDocx(p(`<w:fldSimple w:instr="IF 1 &gt; 0 &quot;a&quot; &quot;b&quot;">${r('a')}</w:fldSimple><w:fldSimple w:instr="IF 2 > 1 x y">${r('x')}</w:fldSimple>`)), {});
    expect(text((out.doc.content as Block[])[0]!)).toBe('ax');
    expect(loss(out.report, 'field')).toMatchObject({ count: 2 });
  });
});

describe('review m1: tracked changes outside runs', () => {
  const del = '<w:del w:id="9" w:author="A" w:date="2026-01-01T00:00:00Z"/>';
  test('a deleted paragraph mark: accepted, the two paragraphs merge; rejected, they stay apart; it is counted', () => {
    const body = `<w:p><w:pPr><w:rPr>${del}</w:rPr></w:pPr>${r('First half ')}</w:p>${p(r('second half.'))}`;
    expect(() => parseDocx(makeDocx(body), {})).toThrow(expect.objectContaining({ reason: 'TRACKED_CHANGES_CHOICE', details: { insertions: 0, deletions: 1 } }));
    expect((parseDocx(makeDocx(body), { trackedChanges: 'accept' }).doc.content as Block[]).map(text)).toEqual(['First half second half.']);
    expect((parseDocx(makeDocx(body), { trackedChanges: 'reject' }).doc.content as Block[]).map(text)).toEqual(['First half', 'second half.']);
  });
  test('a deleted table row: accepted, the row goes; rejected, it stays', () => {
    const row = (t: string, trPr = '') => `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}<w:tc>${p(r(t))}</w:tc></w:tr>`;
    const body = `<w:tbl>${row('keep')}${row('gone', del)}</w:tbl>`;
    const rows = (c: 'accept' | 'reject') => ((parseDocx(makeDocx(body), { trackedChanges: c }).doc.content as Block[])[0] as unknown as { content: unknown[] }).content.length;
    expect(rows('accept')).toBe(1);
    expect(rows('reject')).toBe(2);
  });
  test('tracked changes in footnotes are counted and follow the choice', () => {
    const fn = `<w:footnote w:id="2"><w:p>${r('See ')}<w:ins w:id="3" w:author="A" w:date="2026-01-01T00:00:00Z">${r('new')}</w:ins><w:del w:id="4" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>old</w:delText></w:r></w:del></w:p></w:footnote>`;
    const body = p(`${r('Text')}<w:r><w:footnoteReference w:id="2"/></w:r>`);
    expect(() => parseDocx(makeDocx(body, { footnotes: fn }), {})).toThrow(expect.objectContaining({ details: { insertions: 1, deletions: 1 } }));
    const last = (c: 'accept' | 'reject') => text((parseDocx(makeDocx(body, { footnotes: fn }), { trackedChanges: c }).doc.content as Block[]).at(-1)!);
    expect(last('accept')).toBe('[1] See new');
    expect(last('reject')).toBe('[1] See old');
  });
});

describe('review m2: citations in footnotes and in content controls are reported', () => {
  test('a Zotero citation inside a footnote', () => {
    const fn = `<w:footnote w:id="2"><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> ADDIN ZOTERO_ITEM CSL_CITATION {} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${r('Lee 2019')}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:footnote>`;
    const out = parseDocx(makeDocx(p(`${r('Text')}<w:r><w:footnoteReference w:id="2"/></w:r>`), { footnotes: fn }), {});
    expect(loss(out.report, 'citation_field')).toMatchObject({ count: 1, examples: ['Lee 2019'] });
    expect(text((out.doc.content as Block[]).at(-1)!)).toBe('[1] Lee 2019');
  });
  test('a Mendeley Cite citation in a content control (w:sdt)', () => {
    const out = parseDocx(makeDocx(p(`${r('As shown ')}<w:sdt><w:sdtPr><w:tag w:val="MENDELEY_CITATION_v3_eyJjaXRhdGlvbklEIjoi"/></w:sdtPr><w:sdtContent>${r('(Smith 2020)')}</w:sdtContent></w:sdt>`)), {});
    expect(text((out.doc.content as Block[])[0]!)).toBe('As shown (Smith 2020)');
    expect(loss(out.report, 'citation_field')).toMatchObject({ count: 1, examples: ['(Smith 2020)'] });
  });
});

describe('review NITs', () => {
  test('n1 hidden text is not shown and is reported; n2 a positional tab is a space', () => {
    const out = parseDocx(makeDocx(p(`${r('hidden text', '<w:vanish/>')}${r('a')}<w:r><w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/></w:r>${r('b')}`)), {});
    expect(text((out.doc.content as Block[])[0]!)).toBe('a b');
    expect(loss(out.report, 'hidden_text')).toMatchObject({ count: 1, examples: ['hidden text'] });
  });
  test('n3 a text box does not shift footnote numbers; n4 an embedded object is not called a figure', () => {
    const box = '<w:r><w:pict><v:shape xmlns:v="v"><v:textbox><w:txbxContent><w:p><w:r><w:t>boxed</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r>';
    const fn = `<w:footnote w:id="2"><w:p>${r('Note.')}</w:p></w:footnote>`;
    const out = parseDocx(makeDocx(p(`${box}${r('Text')}<w:r><w:footnoteReference w:id="2"/></w:r><w:r><w:object><o:OLEObject xmlns:o="o" ProgID="Equation.DSMT4"/></w:object></w:r>`), { footnotes: fn }), {});
    expect(JSON.stringify(out.doc)).toContain('Text[1]');
    expect(loss(out.report, 'embedded_object')).toMatchObject({ count: 1, examples: [expect.stringContaining('Equation')] });
    expect(loss(out.report, 'image')).toBeUndefined();
  });
});

// PW-055 re-review (changes requested): MAJOR R1, MINOR m1'–m2', NIT n1–n3
describe('re-review R1: notes that reference notes cannot blow up', () => {
  test('footnotes that each reference the next twice (2^20 paths) are read once each, quickly; a reference inside a note is reported', () => {
    const levels = 20;
    const fns = Array.from({ length: levels }, (_, k) => `<w:footnote w:id="${k + 2}"><w:p>${r(`note ${k}`)}${k + 1 < levels ? `<w:r><w:footnoteReference w:id="${k + 3}"/></w:r><w:r><w:footnoteReference w:id="${k + 3}"/></w:r>` : ''}</w:p></w:footnote>`).join('');
    const t0 = Date.now();
    const out = parseDocx(makeDocx(p(`${r('Text')}<w:r><w:footnoteReference w:id="2"/></w:r>`), { footnotes: fns }), {});
    expect(Date.now() - t0).toBeLessThan(2000);
    const blocks = out.doc.content as Block[];
    expect(blocks.length).toBe(2);
    expect(text(blocks[1]!)).toBe('[1] note 0[?][?]');
    expect(loss(out.report, 'other')!.examples[0]).toMatch(/note reference inside a note/);
  });
});

describe("re-review m1': text boxes are read like body text", () => {
  test('a symbol, a tracked change and hidden text inside a text box follow the same rules', () => {
    const box = `<w:r><w:pict><v:shape xmlns:v="v"><v:textbox><w:txbxContent><w:p>${r('10 ')}<w:r><w:sym w:font="Symbol" w:char="F06D"/></w:r>${r('g')}<w:ins w:id="7" w:author="A" w:date="2026-01-01T00:00:00Z">${r(' added')}</w:ins>${r(' secret', '<w:vanish/>')}</w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r>`;
    const doc = makeDocx(p(`${r('Body.')}${box}`));
    expect(() => parseDocx(doc, {})).toThrow(expect.objectContaining({ reason: 'TRACKED_CHANGES_CHOICE' }));
    const blocks = (c: 'accept' | 'reject') => (parseDocx(doc, { trackedChanges: c }).doc.content as Block[]).map(text);
    expect(blocks('accept')).toEqual(['Body.', '[글상자] 10 μg added']);
    expect(blocks('reject')).toEqual(['Body.', '[글상자] 10 μg']);
  });
  test('n2: a text box inside a text box is not read twice', () => {
    const inner = '<w:r><w:pict><v:textbox xmlns:v="v"><w:txbxContent><w:p><w:r><w:t>inner</w:t></w:r></w:p></w:txbxContent></v:textbox></w:pict></w:r>';
    const outer = `<w:r><w:pict><v:textbox xmlns:v="v"><w:txbxContent><w:p><w:r><w:t>outer </w:t></w:r>${inner}</w:p></w:txbxContent></v:textbox></w:pict></w:r>`;
    const s = JSON.stringify(parseDocx(makeDocx(p(`${r('Body.')}${outer}`)), {}).doc);
    expect(s.split('inner').length - 1).toBe(1);
  });
});

describe("re-review m2': a merged paragraph keeps the following paragraph's style (as Word)", () => {
  test('a heading whose mark is deleted joins the body paragraph after it as body text', () => {
    const body = `<w:p><w:pPr><w:pStyle w:val="1"/><w:rPr><w:del w:id="9" w:author="A" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr>${r('Results')}</w:p>${p(r('Body text.'))}`;
    const blocks = parseDocx(makeDocx(body), { trackedChanges: 'accept' }).doc.content as Block[];
    expect(blocks.map((b) => [b.type, text(b)])).toEqual([['paragraph', 'ResultsBody text.']]);
  });
});

describe('re-review n1 / n3', () => {
  test('n1: an mc:Choice holding only markup this reader does not know falls back to mc:Fallback\'s text', () => {
    const out = parseDocx(makeDocx(`<w:p><mc:AlternateContent xmlns:mc="mc"><mc:Choice Requires="w16"><w16:thing xmlns:w16="w16"/></mc:Choice><mc:Fallback>${r('Fallback text')}</mc:Fallback></mc:AlternateContent></w:p>`), {});
    expect((out.doc.content as Block[]).map(text)).toEqual(['Fallback text']);
  });
  test('n3: text directly in an unknown inline element is kept, as the "other" note says', () => {
    const out = parseDocx(makeDocx(p(`${r('A ')}<x:mystery xmlns:x="x"><w:t>kept text</w:t></x:mystery>`)), {});
    expect(text((out.doc.content as Block[])[0]!)).toBe('A kept text');
    expect(loss(out.report, 'other')).toBeDefined();
  });
});
