// PW-056 golden fixture: a small paper in the shared editor schema with every element the DOCX export
// writes, the stored references (as RefMeta) and figures. All text is synthetic.
import type { FigureMeta, RefMeta } from '../../../packages/editor-core/src/index.ts';

export const R1 = '11111111-1111-4111-8111-111111111111';
export const R2 = '22222222-2222-4222-8222-222222222222';
export const R3 = '33333333-3333-4333-8333-333333333333'; // stored, never cited
export const F1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const T1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const t = (text: string, ...marks: string[]) => (marks.length ? { type: 'text', text, marks: marks.map((type) => ({ type })) } : { type: 'text', text });

export const refs: RefMeta[] = [
  { id: R1, authors: [{ family: 'Kim', given: 'Jiyoon' }], year: 2020, title: 'Root signals under drought', container: 'Journal of Plant Studies', doi: '10.1234/jps.2020.1' },
  { id: R2, authors: [{ family: 'Lee', given: 'Ana' }, { family: 'Park', given: 'Min' }], year: 2019, title: 'A second study', container: null, doi: null },
  { id: R3, authors: [{ family: 'Unused', given: 'X' }], year: 2001, title: 'Never cited', container: null, doi: null },
];
export const figures: (FigureMeta & { caption: string | null })[] = [
  { id: F1, kind: 'figure', position: 1, title: 'Root induction', caption: 'ABC1 induction in roots under drought (n = 3).' },
  { id: T1, kind: 'table', position: 1, title: 'Fold changes', caption: null },
];

export const doc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { id: id(1), level: 1 }, content: [t('Drought marker paper')] },
    { type: 'heading', attrs: { id: id(2), level: 2 }, content: [t('Introduction')] },
    { type: 'paragraph', attrs: { id: id(3) }, content: [
      t('In '), t('Arabidopsis thaliana', 'italic'), t(', H'), t('2', 'subscript'), t('O loss rises 10'), t('3', 'superscript'), t(' fold '), t('(strong)', 'bold'),
      t(' as shown '), { type: 'citation', attrs: { referenceId: R1, locator: 'p. 4' } }, t(' and '), { type: 'citation', attrs: { referenceId: R2, locator: null } },
      t(' (see '), { type: 'figure_ref', attrs: { targetId: F1 } }, t(' and '), { type: 'figure_ref', attrs: { targetId: T1 } }, t(').'),
    ] },
    { type: 'paragraph', attrs: { id: id(4) }, content: [t('Again '), { type: 'citation', attrs: { referenceId: R1, locator: null } }, t(' & <safe> "quotes".')] },
    { type: 'table', attrs: { id: id(5) }, content: [
      { type: 'table_row', content: [{ type: 'table_cell', content: [t('Group')] }, { type: 'table_cell', content: [t('Fold', 'bold')] }] },
      { type: 'table_row', content: [{ type: 'table_cell', content: [t('drought')] }, { type: 'table_cell', content: [t('2.4')] }] },
    ] },
  ],
};
