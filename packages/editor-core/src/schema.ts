// The manuscript schema shared by the browser editor and the server (spec 04 "정본 표현").
// Derived from the PW-003 spike. Positions inside a textblock are ProseMirror positions: text counts
// its UTF-16 length, every inline atom (citation, inline math, figure/table reference) exactly 1.
import { Schema } from 'prosemirror-model';

// Version of the document JSON this schema reads. Stored with every DocumentRevision; a different
// version is never read silently, it goes through an explicit migration (document.ts).
export const EDITOR_SCHEMA_VERSION = 1;

const blockId = { id: { default: null } };

export const schema = new Schema({
  nodes: {
    // an empty manuscript is a valid state (new documents start empty)
    doc: { content: 'block*' },
    paragraph: { group: 'block', content: 'inline*', attrs: { ...blockId } },
    heading: { group: 'block', content: 'inline*', attrs: { ...blockId, level: { default: 1 } } },
    table: { group: 'block', content: 'table_row+', attrs: { ...blockId } },
    table_row: { content: 'table_cell+' },
    table_cell: { content: 'inline*' },
    text: { group: 'inline' },
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

// top-level blocks that carry a stable id
export const BLOCK_TYPES = ['paragraph', 'heading', 'table'] as const;
export const ATOM_TYPES = ['citation', 'math_inline', 'figure_ref'] as const;
export const MARK_TYPES = ['bold', 'italic', 'subscript', 'superscript'] as const;
