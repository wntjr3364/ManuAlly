// Synthetic manuscript used by the PW-003 tests. All values are invented.
import { schema } from '../../../spikes/editor-export/src/schema.mjs';

export const REF_A = '0a5d2c1e-7b1f-4c2e-9d3a-1f2e3d4c5b6a';
export const REF_B = '6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b';

export const bibliography = [
  { id: REF_A, type: 'article-journal', title: 'Synthetic stress response in a model plant', author: [{ family: 'Kimura', given: 'A.' }], issued: { 'date-parts': [[2021]] }, 'container-title': 'Journal of Synthetic Biology Fixtures' },
  { id: REF_B, type: 'article-journal', title: 'A second invented reference', author: [{ family: 'Okafor', given: 'B.' }], issued: { 'date-parts': [[2019]] }, 'container-title': 'Fixture Letters' },
];

const t = (text, marks = []) => schema.text(text, marks.map((m) => schema.marks[m].create()));
const cite = (referenceId, locator = null) => schema.nodes.citation.create({ referenceId, locator });
const math = (latex) => schema.nodes.math_inline.create({ latex });
const figref = (targetId) => schema.nodes.figure_ref.create({ targetId });
const p = (id, ...inline) => schema.nodes.paragraph.create({ id }, inline);

export function buildDoc() {
  return schema.nodes.doc.create(null, [
    schema.nodes.heading.create({ id: 'b-h1', level: 1 }, [t('Results')]),
    // Korean, emoji, Greek, combining mark (e + U+0301), citation atom
    p('b-p1', t('Expression of '), t('ABC1', ['italic']), t(' increased 2.4-fold (n = 6) 🌱 under stress; α-tubulin was stable '), cite(REF_A), t('. 한국어 문장도 포함된다. Café vs Café.')),
    // duplicated sentence on purpose
    p('b-p2', t('The pathway may contribute to growth.')),
    p('b-p3', t('The pathway may contribute to growth.')),
    p('b-p4', t('H'), t('2', ['subscript']), t('O and x'), t('2', ['superscript']), t(' with '), math('\\beta = 0.5'), t(' and '), cite(REF_B, 'p. 4'), t('.'), t(' See '), figref('fig-1'), t('.')),
    schema.nodes.table.create({ id: 'b-t1' }, [
      schema.nodes.table_row.create(null, [schema.nodes.table_cell.create(null, [t('Group')]), schema.nodes.table_cell.create(null, [t('Mean')])]),
      schema.nodes.table_row.create(null, [schema.nodes.table_cell.create(null, [t('Control')]), schema.nodes.table_cell.create(null, [t('1.0')])]),
    ]),
    // values, comparators, units, direction, negation, superscript and a citation locator (review M2 repros)
    p('b-p6', t('Group A had 1.2 and group B had 3.4 (p < 0.05); 5 µM treatment increased growth and did not cause damage in 10'), t('5', ['superscript']), t(' cells '), cite(REF_B, 'p. 4'), t('.')),
    // more re-review repros: direction verbs, spelled numbers, thousands separator, length units, comparator words
    p('b-p7', t('Uptake rose two-fold, reaching 1,000 cells within 5 µm of the surface (p below 0.05).')),
    // decomposed Hangul jamo: 한 = U+1112 U+1161 U+11AB
    p('b-p5', t('Jamo: 한 end.')),
  ]);
}

// Block-relative ProseMirror position of the first occurrence of `needle` inside a block's flattened text
// (atoms count as one position). Test helper only — production code never locates edits by text search.
export function posOf(doc, blockId, needle, { after = false, startAt = 0 } = {}) {
  let flat = null;
  doc.forEach((node) => {
    if (node.attrs.id === blockId) {
      flat = '';
      node.forEach((child) => { flat += child.isText ? child.text : '￼'; });
    }
  });
  const i = flat.indexOf(needle, startAt);
  if (i < 0) throw new Error(`needle not found: ${needle}`);
  return after ? i + needle.length : i;
}
