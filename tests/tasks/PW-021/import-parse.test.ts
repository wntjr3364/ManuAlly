// PW-021 — text/Markdown import parser: the result is a valid manuscript with new block ids, and every
// thing that could not be carried over is reported (spec 10 "손실 보고서"), never silently dropped.
import { describe, expect, test } from 'vitest';
import { validateDocument } from '../../../packages/editor-core/src/index.ts';
import { PARSER_VERSION, parseImport } from '../../../packages/domain/src/imports/text/parse.ts';

type Block = { type: string; attrs: { id: string; level?: number }; content?: { type: string; text: string; marks?: { type: string }[] }[] };
const blocks = (r: ReturnType<typeof parseImport>) => (r.doc.content as Block[]);
const texts = (r: ReturnType<typeof parseImport>) => blocks(r).map((b) => (b.content ?? []).map((c) => c.text).join(''));
const loss = (r: ReturnType<typeof parseImport>, kind: string) => r.report.losses.find((l) => l.kind === kind);

describe('plain text', () => {
  test('blank lines separate paragraphs; single line breaks join; CRLF and BOM are normalised', () => {
    const r = parseImport('﻿First line\r\ncontinues here.\r\n\r\n\r\nSecond  paragraph — α-helix, 2.4-fold.\n', 'text');
    expect(texts(r)).toEqual(['First line continues here.', 'Second  paragraph — α-helix, 2.4-fold.']);
    expect(validateDocument(r.doc, 1).ok).toBe(true);
    expect(r.report).toMatchObject({ format: 'text', parser_version: PARSER_VERSION, blocks: 2 });
    expect(r.report.losses).toEqual([]);
  });
  test('each block gets a new, distinct id', () => {
    const r = parseImport('a\n\nb\n\nc', 'text');
    const ids = blocks(r).map((b) => b.attrs.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
  });
  test('control characters are removed and reported; Markdown syntax in a .txt stays literal', () => {
    const r = parseImport('a\u0000b\u0007c **not bold**', 'text');
    expect(texts(r)).toEqual(['abc **not bold**']);
    expect(loss(r, 'control_characters')).toMatchObject({ count: 2 });
  });
  test('an empty file is refused', () => {
    expect(() => parseImport(' \n\n ', 'text')).toThrow(/empty/);
  });
});

describe('Markdown', () => {
  test('headings, bold, italic, sub- and superscript become nodes and marks', () => {
    const r = parseImport('# Title\n\n## Results\n\nH~2~O was **very** *clearly* x^2^ and __strong__ _em_.', 'markdown');
    expect(blocks(r).map((b) => [b.type, b.attrs.level])).toEqual([['heading', 1], ['heading', 2], ['paragraph', undefined]]);
    const p = blocks(r)[2]!.content!;
    const marked = (m: string) => p.filter((c) => c.marks?.some((x) => x.type === m)).map((c) => c.text);
    expect(marked('subscript')).toEqual(['2']);
    expect(marked('superscript')).toEqual(['2']);
    expect(marked('bold')).toEqual(['very', 'strong']);
    expect(marked('italic')).toEqual(['clearly', 'em']);
    expect(texts(r)[2]).toBe('H2O was very clearly x2 and strong em.');
    expect(validateDocument(r.doc, 1).ok).toBe(true);
    expect(r.report.losses).toEqual([]);
  });
  test('links keep their text, images, code, lists, quotes, tables, math, HTML, footnotes and rules are reported', () => {
    const md = [
      'See [the site](https://example.org) and ![fig](a.png).',
      '',
      '- item one',
      '- item two',
      '',
      '> quoted',
      '',
      '```',
      'code block',
      '```',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'Inline `x` and $E=mc^2$ and <b>tag</b> and note[^1].',
      '',
      '---',
      '',
      '[^1]: the note',
    ].join('\n');
    const r = parseImport(md, 'markdown');
    expect(texts(r)[0]).toBe('See the site and .');
    for (const k of ['link', 'image', 'list', 'blockquote', 'code', 'table', 'math', 'html', 'footnote', 'horizontal_rule']) expect(loss(r, k), k).toBeDefined();
    expect(loss(r, 'link')!.examples[0]).toMatch(/line 1/);
    expect(texts(r)).toContain('• item one');
    expect(texts(r)).toContain('code block');
    expect(texts(r).some((t) => t.includes('<b>tag</b>'))).toBe(true); // literal text, never markup
    expect(validateDocument(r.doc, 1).ok).toBe(true);
  });
  test('an unclosed marker stays literal text', () => {
    const r = parseImport('2 * 3 = 6 and a_b', 'markdown');
    expect(texts(r)).toEqual(['2 * 3 = 6 and a_b']);
  });
});
