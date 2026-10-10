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
