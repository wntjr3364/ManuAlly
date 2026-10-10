// PW-056 — the DOCX export (packages/exports/src/docx): written by the app from the stored document, with
// citation labels, the bibliography and figure numbers computed by the same pinned renderer as the screen
// (editor-core references, STYLE_VERSION), read back after writing and compared block by block.
// TST-056A: meaning, citations, tables and formatting of the golden fixture are found in the exported file.
// TST-056B: an export with citation numbers nobody linked, or a citation to a missing reference, is never
//   marked as a normal export.
import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { bibliography } from '../../../packages/editor-core/src/index.ts';
import { renderDocx, cslJson, RENDERER_VERSION } from '../../../packages/exports/src/docx/index.ts';
import { writeDocx } from '../../../packages/exports/src/docx/render.ts';
import { parseDocx } from '../../../packages/domain/src/imports/docx/index.ts';
import { openZip } from '../../../packages/domain/src/imports/docx/zip.ts';
import { doc, figures, refs, R1, R2, R3 } from './golden.ts';

type Inline = { text?: string; marks?: { type: string }[] };
type Block = { type: string; attrs: { level?: number }; content?: (Inline & { content?: { content?: Inline[] }[] })[] };
const text = (b: Block) => (b.content ?? []).map((i) => i.text ?? '').join('');
const back = (bytes: Buffer) => parseDocx(bytes, {}).doc.content as Block[];
const part = (bytes: Buffer, name: string) => openZip(bytes).read(name)!.toString('utf8');

describe('TST-056A: the golden paper survives the export', () => {
  test('numeric style: headings, marks, citations with locators, figure numbers, the table, references and legends', () => {
    const out = renderDocx({ doc, refs, figures, style: 'numeric' });
    const blocks = back(out.bytes);
    expect(blocks.map((b) => [b.type, b.attrs.level ?? null, b.type === 'table' ? null : text(b)])).toEqual([
      ['heading', 1, 'Drought marker paper'],
      ['heading', 2, 'Introduction'],
      ['paragraph', null, 'In Arabidopsis thaliana, H2O loss rises 103 fold (strong) as shown [1, p. 4] and [2] (see Figure 1 and Table 1).'],
      ['paragraph', null, 'Again [1] & <safe> "quotes".'],
      ['table', null, null],
      ['heading', 1, 'References'],
      ['paragraph', null, '[1] Kim, J. (2020). Root signals under drought. Journal of Plant Studies. https://doi.org/10.1234/jps.2020.1'],
      ['paragraph', null, '[2] Lee, A., & Park, M. (2019). A second study.'],
      ['heading', 1, 'Figure and table legends'],
      ['paragraph', null, 'Figure 1. ABC1 induction in roots under drought (n = 3).'],
      ['paragraph', null, 'Table 1. Fold changes'],
    ]);
    // the bibliography is exactly the pinned renderer's (only cited references, never the uncited one)
    const bib = bibliography([{ referenceId: R1, locator: 'p. 4' }, { referenceId: R2, locator: null }, { referenceId: R1, locator: null }], refs, 'numeric');
    expect(blocks.slice(6, 8).map(text)).toEqual(bib.map((b) => `${b.label} ${b.text}`));
    expect(JSON.stringify(blocks)).not.toContain('Never cited');
    // marks
    const p = blocks[2]!.content!;
    expect(p.find((i) => i.text === 'Arabidopsis thaliana')!.marks).toEqual([{ type: 'italic' }]);
    expect(p.find((i) => i.text === '2')!.marks).toEqual([{ type: 'subscript' }]);
    expect(p.find((i) => i.text === '3')!.marks).toEqual([{ type: 'superscript' }]);
    expect(p.find((i) => i.text === '(strong)')!.marks).toEqual([{ type: 'bold' }]);
    // the table
    const tbl = blocks[4] as unknown as { content: { content: { content: Inline[] }[] }[] };
    expect(tbl.content.map((row) => row.content.map((c) => c.content.map((i) => i.text).join('')))).toEqual([['Group', 'Fold'], ['drought', '2.4']]);
    // styles are real Word styles (headings navigable, references styled)
    const styles = part(out.bytes, 'word/styles.xml');
    for (const s of ['heading 1', 'heading 2', 'Title', 'Bibliography', 'Caption']) expect(styles).toContain(`w:val="${s}"`);
    // the check passed and says how it was made
    expect(out.report).toMatchObject({ status: 'clean', issues: [], style: 'numeric', style_version: 'pw-builtin-1', renderer_version: RENDERER_VERSION, readback: { ok: true, mismatches: [] } });
  });

  test('author-year style labels and order come from the same renderer', () => {
    const blocks = back(renderDocx({ doc, refs, figures, style: 'author_year' }).bytes);
    expect(text(blocks[2]!)).toContain('as shown (Kim 2020, p. 4) and (Lee & Park 2019)');
    expect(blocks.slice(6, 8).map(text)).toEqual([
      '(Kim 2020) Kim, J. (2020). Root signals under drought. Journal of Plant Studies. https://doi.org/10.1234/jps.2020.1',
      '(Lee & Park 2019) Lee, A., & Park, M. (2019). A second study.',
    ]);
  });

  test('the same input gives the same bytes (no dates or random ids in the file)', () => {
    const a = renderDocx({ doc, refs, figures, style: 'numeric' }).bytes;
    const b = renderDocx({ doc, refs, figures, style: 'numeric' }).bytes;
    expect(createHash('sha256').update(a).digest('hex')).toBe(createHash('sha256').update(b).digest('hex'));
  });

  test('math is written as its LaTeX text and reported (no equation layout in v1)', () => {
    const m = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: '00000000-0000-4000-8000-000000000009' }, content: [{ type: 'text', text: 'Rate ' }, { type: 'math_inline', attrs: { latex: 'k = 2.4' } }] }] };
    const out = renderDocx({ doc: m, refs: [], figures: [], style: 'numeric' });
    expect(text(back(out.bytes)[0]!)).toBe('Rate k = 2.4');
    expect(out.report.status).toBe('needs_attention');
    expect(out.report.issues).toEqual([expect.objectContaining({ kind: 'math_as_text', severity: 'warning', count: 1, examples: ['k = 2.4'] })]);
  });
});

describe('TST-056B: unlinked or missing citations never make a normal export', () => {
  test('a citation to a reference that is not stored: shown as [?], an error, the file is marked as a draft', () => {
    const bad = JSON.parse(JSON.stringify(doc));
    bad.content[3].content[1].attrs.referenceId = '99999999-9999-4999-8999-999999999999';
    const out = renderDocx({ doc: bad, refs, figures, style: 'numeric' });
    expect(out.report.status).toBe('draft_with_errors');
    expect(out.report.issues).toContainEqual(expect.objectContaining({ kind: 'unresolved_citation', severity: 'error', count: 1 }));
    expect(text(back(out.bytes)[3]!)).toBe('Again [?] & <safe> "quotes".');
    // the file itself says it is a draft (header), so it cannot pass as a clean export
    expect(part(out.bytes, 'word/header1.xml')).toContain('초안');
  });

  test('citation numbers or author-year citations typed as plain text (e.g. written by a model) are errors', () => {
    for (const typed of ['as reported [12].', 'as reported [3, 5–7].', 'as reported (Smith et al., 2019).', 'as reported (Kim & Lee 2020a).']) {
      const d = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: '00000000-0000-4000-8000-000000000010' }, content: [{ type: 'text', text: `Root growth increased ${typed}` }] }] };
      const out = renderDocx({ doc: d, refs, figures, style: 'numeric' });
      expect(out.report.status, typed).toBe('draft_with_errors');
      expect(out.report.issues, typed).toContainEqual(expect.objectContaining({ kind: 'citation_like_text', severity: 'error' }));
    }
    // ordinary brackets and years are not citations
    const ok = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: '00000000-0000-4000-8000-000000000011' }, content: [{ type: 'text', text: 'Samples (n = 3) from 2019 were dried [at 60 °C].' }] }] };
    expect(renderDocx({ doc: ok, refs, figures, style: 'numeric' }).report.status).toBe('clean');
  });

  test('a cross-reference to a missing figure is an error', () => {
    const bad = JSON.parse(JSON.stringify(doc));
    bad.content[2].content[13].attrs.targetId = '99999999-9999-4999-8999-999999999999';
    const out = renderDocx({ doc: bad, refs, figures, style: 'numeric' });
    expect(out.report.status).toBe('draft_with_errors');
    expect(out.report.issues).toContainEqual(expect.objectContaining({ kind: 'unresolved_figure', severity: 'error' }));
  });

  test('a file that does not read back as intended is an error and a draft (a writer that drops a block)', () => {
    const broken: typeof writeDocx = (blocks, note) => writeDocx(blocks.filter((_, k) => k !== 3), note);
    const out = renderDocx({ doc, refs, figures, style: 'numeric' }, broken);
    expect(out.report.status).toBe('draft_with_errors');
    expect(out.report.readback.ok).toBe(false);
    expect(out.report.issues).toContainEqual(expect.objectContaining({ kind: 'readback_mismatch', severity: 'error' }));
    expect(part(out.bytes, 'word/header1.xml')).toContain('readback_mismatch');
  });

  test('a stored reference with no year is a warning, not silently "n.d."', () => {
    const r2 = refs.map((r) => (r.id === R2 ? { ...r, year: null } : r));
    const out = renderDocx({ doc, refs: r2, figures, style: 'numeric' });
    expect(out.report.issues).toContainEqual(expect.objectContaining({ kind: 'incomplete_reference', severity: 'warning', count: 1 }));
  });
});

describe('CSL-JSON of the cited references', () => {
  test('the stored records of the cited references, in bibliography order, with their stable ids', () => {
    const stored = new Map([[R1, { type: 'article-journal', title: 'Root signals under drought' }], [R2, { type: 'article-journal', title: 'A second study' }], [R3, { type: 'article-journal', title: 'Never cited' }]]);
    expect(cslJson(doc, refs, stored, 'numeric')).toEqual({ items: [
      { id: R1, type: 'article-journal', title: 'Root signals under drought' },
      { id: R2, type: 'article-journal', title: 'A second study' },
    ], missing: [] });
  });
});

// PW-056 review: MINOR m1–m2, NIT n2–n4
const para = (...content: unknown[]) => ({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: '00000000-0000-4000-8000-000000000020' }, content }] });
const tx = (text: string, ...marks: string[]) => (marks.length ? { type: 'text', text, marks: marks.map((type) => ({ type })) } : { type: 'text', text });
const kinds = (o: ReturnType<typeof renderDocx>) => o.report.issues.map((i) => `${i.kind}:${i.severity}`);

describe('review m1: typed citations — fewer false alarms, fewer misses', () => {
  test('interval notation and dates in parentheses are not citations', () => {
    for (const s of ['values normalized to [0, 1].', 'a range [0.5, 2] was used.', 'samples collected (March 2020) were dried.', 'in spring (May 2019).']) {
      expect(renderDocx({ doc: para(tx(s)), refs, figures, style: 'numeric' }).report.status, s).toBe('clean');
    }
  });
  test('narrative, prefixed and Korean citations typed as text are errors', () => {
    for (const s of ['Smith et al. (2019) showed this.', 'as before (see Kim 2020).', 'as before (e.g., Smith 2019).', '선행 연구 (김 외, 2020) 참고.', 'Lee and Park (2018) found it.']) {
      expect(kinds(renderDocx({ doc: para(tx(s)), refs, figures, style: 'numeric' })), s).toContain('citation_like_text:error');
    }
  });
  test('superscript numbers after a word are reported as possible citations (a warning: units such as m² look the same); exponents are not', () => {
    expect(kinds(renderDocx({ doc: para(tx('Root growth rose'), tx('12', 'superscript'), tx('.')), refs, figures, style: 'numeric' }))).toContain('superscript_citation_like:warning');
    expect(kinds(renderDocx({ doc: para(tx('Root growth rose¹²˒¹⁴.')), refs, figures, style: 'numeric' }))).toContain('superscript_citation_like:warning');
    // 10³ is an exponent
    expect(renderDocx({ doc: para(tx('a 10'), tx('3', 'superscript'), tx('-fold rise')), refs, figures, style: 'numeric' }).report.status).toBe('clean');
  });
});

describe('review m2: species and gene names written in italics once are italic everywhere', () => {
  test('a name italic in one place and plain in another is reported', () => {
    const out = renderDocx({ doc: para(tx('In '), tx('Arabidopsis thaliana', 'italic'), tx(' roots, but Arabidopsis thaliana leaves differ.')), refs, figures, style: 'numeric' });
    expect(out.report.issues).toContainEqual(expect.objectContaining({ kind: 'italic_inconsistent', severity: 'warning', examples: ['Arabidopsis thaliana'] }));
    expect(renderDocx({ doc: para(tx('In '), tx('Arabidopsis thaliana', 'italic'), tx(' roots.')), refs, figures, style: 'numeric' }).report.status).toBe('clean');
  });
});

describe('review n2–n4', () => {
  test('n4: a cited reference with an empty title, or one the library knows is retracted, is reported', () => {
    const r1 = refs.map((r) => (r.id === R1 ? { ...r, title: ' ' } : r));
    expect(kinds(renderDocx({ doc, refs: r1, figures, style: 'numeric' }))).toContain('incomplete_reference:warning');
    const out = renderDocx({ doc, refs, figures, style: 'numeric', retracted: new Set([R2]) });
    expect(out.report.issues).toContainEqual(expect.objectContaining({ kind: 'retracted_reference', severity: 'warning', count: 1 }));
  });
  test('n3: a cited reference without a stored CSL record is named, not silently left out', () => {
    const stored = new Map([[R1, { type: 'article-journal', title: 'Root signals under drought' }]]);
    expect(cslJson(doc, refs, stored, 'numeric')).toEqual({ items: [{ id: R1, type: 'article-journal', title: 'Root signals under drought' }], missing: [R2] });
  });
  test('n2: a read-back the reader cannot do is a reported warning, not a crash', () => {
    const tooBig: typeof writeDocx = () => Buffer.from('not a zip');
    const out = renderDocx({ doc, refs, figures, style: 'numeric' }, tooBig);
    expect(out.report.readback.ok).toBe(false);
    expect(kinds(out)).toContain('readback_unverified:warning');
  });
});
