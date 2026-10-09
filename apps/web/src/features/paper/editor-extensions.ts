// Tiptap configured to produce exactly the editor-core document schema (PW-012): paragraph and heading
// blocks with stable UUID ids, bold/italic/sub/sup marks, and the three inline atoms. Nothing else is
// enabled, so the editor cannot create content the server would refuse.
import { Extension, Node, type AnyExtension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { Heading } from '@tiptap/extension-heading';
import { Bold } from '@tiptap/extension-bold';
import { Italic } from '@tiptap/extension-italic';
import { Subscript } from '@tiptap/extension-subscript';
import { Superscript } from '@tiptap/extension-superscript';
import { UndoRedo } from '@tiptap/extensions';

const BLOCKS = ['paragraph', 'heading'];

// set by block-ids.ts (it imports this module to build the schema)
let reconcileIds: (oldDoc: PMNode, state: EditorState, trs: readonly Transaction[]) => Transaction | null = () => null;
export const setBlockIdReconciler = (fn: typeof reconcileIds) => { reconcileIds = fn; };

const BlockIds = Extension.create({
  name: 'blockIds',
  addGlobalAttributes() {
    return [{
      types: BLOCKS,
      attributes: {
        id: { default: null, keepOnSplit: false, parseHTML: (el) => el.getAttribute('data-block-id'), renderHTML: (a) => (a.id ? { 'data-block-id': a.id } : {}) },
      },
    }];
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('blockIds'),
      // lazy import keeps block-ids (which builds the schema from these extensions) out of a cycle
      appendTransaction: (trs, oldState, state) => (trs.some((t) => t.docChanged) || oldState.doc === state.doc ? reconcileIds(oldState.doc, state, trs) : null),
    })];
  },
});

// Inline atoms are kept and shown; creating them comes with references/figures (P04). Their
// attributes travel through copy/paste as data-* attributes (set via the DOM, never as markup).
const atom = (name: string, attrs: Record<string, string>, label: (a: Record<string, unknown>) => string) =>
  Node.create({
    name,
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    addAttributes: () => Object.fromEntries(Object.entries(attrs).map(([key, dataName]) => [key, {
      default: null,
      parseHTML: (el: HTMLElement) => el.getAttribute(`data-${dataName}`),
      renderHTML: (a: Record<string, unknown>) => (a[key] == null ? {} : { [`data-${dataName}`]: String(a[key]) }),
    }])),
    parseHTML: () => [{ tag: `span[data-pw-${name}]` }],
    renderHTML: ({ node, HTMLAttributes }) => ['span', { ...HTMLAttributes, [`data-pw-${name}`]: '', class: `atom atom-${name}`, contenteditable: 'false' }, label(node.attrs)],
  });

export const editorExtensions: AnyExtension[] = [
  Document,
  Paragraph,
  Text,
  Heading.configure({ levels: [1, 2, 3, 4, 5, 6] }),
  Bold,
  Italic,
  Subscript,
  Superscript,
  UndoRedo,
  BlockIds,
  atom('citation', { referenceId: 'reference-id', locator: 'locator' }, (a) => `[인용${a.locator ? `, ${String(a.locator)}` : ''}]`),
  atom('math_inline', { latex: 'latex' }, (a) => `⟨${String(a.latex)}⟩`),
  atom('figure_ref', { targetId: 'target-id' }, () => '[그림/표]'),
];

// Node types this editor can show. A stored document with anything else (e.g. a table) is shown
// read-only rather than silently dropping content.
export const EDITABLE_TYPES = new Set(['doc', 'paragraph', 'heading', 'text', 'citation', 'math_inline', 'figure_ref']);
export function unsupportedTypes(json: unknown): string[] {
  const out = new Set<string>();
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const o = n as { type?: unknown; content?: unknown };
    if (typeof o.type === 'string' && !EDITABLE_TYPES.has(o.type)) out.add(o.type);
    if (Array.isArray(o.content)) o.content.forEach(walk);
  };
  walk(json);
  return [...out];
}
