// PW-003 spike schema. The P01 packages/editor-core schema will be derived from this
// after the position contract is approved; it is not the production schema yet.
import { Schema } from 'prosemirror-model';

const blockId = { id: { default: null } };

export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', attrs: { ...blockId } },
    heading: { group: 'block', content: 'inline*', attrs: { ...blockId, level: { default: 1 } } },
    table: { group: 'block', content: 'table_row+', attrs: { ...blockId } },
    table_row: { content: 'table_cell+' },
    table_cell: { content: 'inline*' },
    text: { group: 'inline' },
    // Atoms occupy exactly one ProseMirror position.
    citation: { group: 'inline', inline: true, atom: true, attrs: { referenceId: {}, locator: { default: null } } },
    math_inline: { group: 'inline', inline: true, atom: true, attrs: { latex: {} } },
    figure_ref: { group: 'inline', inline: true, atom: true, attrs: { targetId: {} } },
  },
  marks: {
    bold: {},
    italic: {},
    subscript: { excludes: 'superscript' },
    superscript: { excludes: 'subscript' },
  },
});
