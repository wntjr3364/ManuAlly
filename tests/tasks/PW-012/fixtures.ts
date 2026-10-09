// PW-012 golden fixtures (synthetic). Positions are hand-checked: text counts UTF-16 units, each
// inline atom (citation, math, figure reference) counts 1, and a selection may not split a
// surrogate pair or a grapheme cluster.
export const ID = {
  plain: '00000000-0000-4000-8000-000000000001',
  emoji: '00000000-0000-4000-8000-000000000002',
  zwj: '00000000-0000-4000-8000-000000000003',
  combining: '00000000-0000-4000-8000-000000000004',
  hangul: '00000000-0000-4000-8000-000000000005',
  cite: '00000000-0000-4000-8000-000000000006',
  marks: '00000000-0000-4000-8000-000000000007',
  flag: '00000000-0000-4000-8000-000000000008',
  heading: '00000000-0000-4000-8000-000000000009',
  table: '00000000-0000-4000-8000-00000000000a',
  ref: '11111111-1111-4111-8111-111111111111',
  fig: '22222222-2222-4222-8222-222222222222',
};
const t = (text: string, marks?: string[]) => (marks ? { type: 'text', text, marks: marks.map((m) => ({ type: m })) } : { type: 'text', text });
const p = (id: string, ...content: unknown[]) => ({ type: 'paragraph', attrs: { id }, content });

export const manuscript = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { id: ID.heading, level: 2 }, content: [t('Results')] },
    p(ID.plain, t('ABC1 rose 2.4-fold')),
    p(ID.emoji, t('a😀b')),
    p(ID.zwj, t('x👨‍👩‍👧y')),
    p(ID.combining, t('éx')),
    p(ID.hangul, t('각다')), // decomposed 각 (3 jamo) + precomposed 다
    p(ID.cite, t('induced'), { type: 'citation', attrs: { referenceId: ID.ref, locator: 'p. 4' } }, t(' in roots')),
    p(ID.marks, t('CO'), t('2', ['subscript']), t(' at '), { type: 'math_inline', attrs: { latex: '\\alpha' } }, t(' ('), { type: 'figure_ref', attrs: { targetId: ID.fig } }, t(').')),
    p(ID.flag, t('🇰🇷')),
    { type: 'table', attrs: { id: ID.table }, content: [{ type: 'table_row', content: [{ type: 'table_cell', content: [t('n')] }, { type: 'table_cell', content: [t('3')] }] }] },
  ],
};

// hand-checked allowed positions per textblock
export const BOUNDARIES: Record<string, number[]> = {
  [ID.plain]: Array.from({ length: 19 }, (_, i) => i),
  [ID.emoji]: [0, 1, 3, 4],
  [ID.zwj]: [0, 1, 9, 10], // 👨‍👩‍👧 = 2+1+2+1+2 UTF-16 units, one grapheme
  [ID.combining]: [0, 2, 3],
  [ID.hangul]: [0, 3, 4],
  [ID.cite]: Array.from({ length: 18 }, (_, i) => i), // 7 + atom + 9
  [ID.marks]: Array.from({ length: 14 }, (_, i) => i), // CO(2) 2(1) ␣at␣(4) α(1) ␣((2) fig(1) ).(2) = 13
  [ID.flag]: [0, 4],
  [ID.heading]: [0, 1, 2, 3, 4, 5, 6, 7],
};

export interface SelectionCase { name: string; blockId: string; from: unknown; to: unknown; quote?: string; error?: string; atoms?: string[] }
export const SELECTIONS: SelectionCase[] = [
  { name: 'plain word', blockId: ID.plain, from: 5, to: 9, quote: 'rose', atoms: [] },
  { name: 'whole emoji', blockId: ID.emoji, from: 1, to: 3, quote: '😀' },
  { name: 'half an emoji', blockId: ID.emoji, from: 1, to: 2, error: 'SPLITS_SURROGATE_PAIR' },
  { name: 'inside a ZWJ sequence', blockId: ID.zwj, from: 1, to: 3, error: 'SPLITS_GRAPHEME' },
  { name: 'whole ZWJ family', blockId: ID.zwj, from: 1, to: 9, quote: '👨‍👩‍👧' },
  { name: 'base letter without its accent', blockId: ID.combining, from: 0, to: 1, error: 'SPLITS_GRAPHEME' },
  { name: 'decomposed Hangul syllable', blockId: ID.hangul, from: 0, to: 3, quote: '각' },
  { name: 'half a decomposed syllable', blockId: ID.hangul, from: 0, to: 2, error: 'SPLITS_GRAPHEME' },
  { name: 'text with its citation', blockId: ID.cite, from: 0, to: 8, quote: 'induced', atoms: ['citation'] },
  { name: 'marks, math and figure ref', blockId: ID.marks, from: 0, to: 13, quote: 'CO2 at  ().', atoms: ['math_inline', 'figure_ref'] },
  { name: 'half a flag', blockId: ID.flag, from: 0, to: 2, error: 'SPLITS_GRAPHEME' },
  { name: 'inverted', blockId: ID.plain, from: 9, to: 5, error: 'RANGE_INVERTED' },
  { name: 'empty', blockId: ID.plain, from: 3, to: 3, error: 'EMPTY_SELECTION' },
  { name: 'past the end', blockId: ID.plain, from: 0, to: 19, error: 'RANGE_OUT_OF_BOUNDS' },
  { name: 'fractional', blockId: ID.plain, from: 0.5, to: 3, error: 'RANGE_OUT_OF_BOUNDS' },
  { name: 'table is not a textblock', blockId: ID.table, from: 0, to: 1, error: 'NOT_TEXTBLOCK' },
  { name: 'unknown block', blockId: '99999999-9999-4999-8999-999999999999', from: 0, to: 1, error: 'BLOCK_NOT_FOUND' },
];

export interface ReplacementCase { name: string; blockId: string; from: number; to: number; replacement: unknown; error?: boolean }
export const REPLACEMENTS: ReplacementCase[] = [
  { name: 'reword around kept atoms', blockId: ID.marks, from: 0, to: 13, replacement: [{ type: 'text', text: 'CO' }, { type: 'text', text: '2', marks: ['subscript'] }, { type: 'text', text: ' measured at ' }, { type: 'preserve_atom', atom_index: 0 }, { type: 'text', text: ' (' }, { type: 'preserve_atom', atom_index: 1 }, { type: 'text', text: ').' }] },
  { name: 'citation kept as a citation item', blockId: ID.cite, from: 0, to: 8, replacement: [{ type: 'text', text: 'was induced' }, { type: 'citation', reference_id: ID.ref, locator: 'p. 4' }] },
  { name: 'atom index outside the selection', blockId: ID.marks, from: 0, to: 13, replacement: [{ type: 'preserve_atom', atom_index: 2 }], error: true },
  { name: 'same atom twice', blockId: ID.marks, from: 0, to: 13, replacement: [{ type: 'preserve_atom', atom_index: 0 }, { type: 'preserve_atom', atom_index: 0 }], error: true },
  { name: 'unknown mark', blockId: ID.plain, from: 5, to: 9, replacement: [{ type: 'text', text: 'rose', marks: ['link'] }], error: true },
  { name: 'raw HTML item', blockId: ID.plain, from: 5, to: 9, replacement: [{ type: 'html', html: '<b>rose</b>' }], error: true },
  { name: 'empty text', blockId: ID.plain, from: 5, to: 9, replacement: [{ type: 'text', text: '' }], error: true },
];
