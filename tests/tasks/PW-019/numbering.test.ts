// PW-019 — TST-019A (unit): citation labels and figure/table numbers follow the document and the chosen
// style, and are recalculated when the order or the style changes. Unknown targets are never numbered.
import { describe, expect, test } from 'vitest';
import { bibliography, citationLabels, figureLabels, type RefMeta } from '../../../packages/editor-core/src/references/index.ts';

const R1 = '00000000-0000-4000-8000-0000000000f1';
const R2 = '00000000-0000-4000-8000-0000000000f2';
const R3 = '00000000-0000-4000-8000-0000000000f3';
const NOPE = '00000000-0000-4000-8000-0000000000ff';
const refs: RefMeta[] = [
  { id: R1, authors: [{ family: 'Kim', given: 'Ji' }], year: 2020, title: 'Drought induces ABC1', container: 'Plant J', doi: '10.1/abc' },
  { id: R2, authors: [{ family: 'Lee', given: 'Su' }, { family: 'Park', given: 'Ho' }], year: 2019, title: 'Root growth' },
  { id: R3, authors: [{ family: 'Kim', given: 'Ji' }, { family: 'Cho' }, { family: 'Han' }], year: 2020, title: 'Another 2020 paper' },
];
const cite = (referenceId: string, locator: string | null = null) => ({ referenceId, locator });

describe('citation labels', () => {
  test('numeric: numbered by first appearance; repeats reuse their number', () => {
    expect(citationLabels([cite(R2), cite(R1, 'p. 4'), cite(R2)], refs, 'numeric').labels).toEqual(['[1]', '[2, p. 4]', '[1]']);
  });

  test('changing the style recalculates every label consistently', () => {
    const occ = [cite(R2), cite(R1), cite(R3)];
    expect(citationLabels(occ, refs, 'author_year').labels).toEqual(['(Lee & Park 2019)', '(Kim 2020)', '(Kim et al. 2020)']);
    expect(citationLabels(occ, refs, 'numeric').labels).toEqual(['[1]', '[2]', '[3]']);
  });

  test('author-year: same first author and year get a/b by bibliography order', () => {
    const r4: RefMeta = { id: '00000000-0000-4000-8000-0000000000f4', authors: [{ family: 'Kim', given: 'Ji' }], year: 2020, title: 'A later Kim 2020' };
    expect(citationLabels([cite(R1), cite(r4.id)], [...refs, r4], 'author_year').labels).toEqual(['(Kim 2020b)', '(Kim 2020a)']);
  });

  test('a citation to an unknown reference is not numbered and is reported', () => {
    const r = citationLabels([cite(R1), cite(NOPE), cite(R2)], refs, 'numeric');
    expect(r.labels).toEqual(['[1]', '[?]', '[2]']);
    expect(r.unresolved).toEqual([NOPE]);
  });

  test('the bibliography is built from stored metadata only, in the style\'s order', () => {
    const occ = [cite(R2), cite(R1), cite(NOPE)];
    expect(bibliography(occ, refs, 'numeric').map((b) => b.label)).toEqual(['[1]', '[2]']);
    expect(bibliography(occ, refs, 'numeric')[1]!.text).toBe('Kim, J. (2020). Drought induces ABC1. Plant J. https://doi.org/10.1/abc');
    expect(bibliography(occ, refs, 'author_year').map((b) => b.id)).toEqual([R1, R2]); // alphabetical
  });
});

describe('figure and table numbers', () => {
  const figs = [
    { id: 'f-a', kind: 'figure' as const, position: 2, title: 'Survival' },
    { id: 'f-b', kind: 'figure' as const, position: 1, title: 'Induction' },
    { id: 't-a', kind: 'table' as const, position: 1, title: 'Primers' },
  ];
  test('numbers follow the figure order set by the user, per kind', () => {
    expect(figureLabels(['f-a', 't-a', 'f-b'], figs).labels).toEqual(['Figure 2', 'Table 1', 'Figure 1']);
  });
  test('reordering the figures renumbers every reference to them', () => {
    const reordered = figs.map((f) => (f.id === 'f-a' ? { ...f, position: 1 } : f.id === 'f-b' ? { ...f, position: 2 } : f));
    expect(figureLabels(['f-a', 't-a', 'f-b'], reordered).labels).toEqual(['Figure 1', 'Table 1', 'Figure 2']);
  });
  test('a reference to a missing figure is marked, not numbered', () => {
    const r = figureLabels(['f-a', 'gone'], figs);
    expect(r.labels).toEqual(['Figure 2', '[그림/표 없음]']);
    expect(r.unresolved).toEqual(['gone']);
  });
});

describe('review nits', () => {
  test('undated works by the same author read n.d.-a / n.d.-b', () => {
    const a: RefMeta = { id: 'a', authors: [{ family: 'Kim' }], year: null, title: 'Alpha' };
    const b: RefMeta = { id: 'b', authors: [{ family: 'Kim' }], year: null, title: 'Beta' };
    expect(citationLabels([cite('a'), cite('b', 'p. 2')], [a, b], 'author_year').labels).toEqual(['(Kim n.d.-a)', '(Kim n.d.-b, p. 2)']);
    expect(bibliography([cite('a'), cite('b')], [a, b], 'author_year').map((e) => e.text)).toEqual(['Kim (n.d.-a). Alpha.', 'Kim (n.d.-b). Beta.']);
  });
  test('initials take a whole character, also outside the BMP', () => {
    const r: RefMeta = { id: 'x', authors: [{ family: 'Yoshida', given: '𠮷田 太郎' }], year: 2020, title: 'T' };
    const text = bibliography([cite('x')], [r], 'numeric')[0]!.text;
    expect(text).toBe('Yoshida, 𠮷. 太. (2020). T.');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false);
  });
});
