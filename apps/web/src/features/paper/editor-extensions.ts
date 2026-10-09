// Tiptap configured to produce exactly the editor-core document schema (PW-012): paragraph and heading
// blocks with stable UUID ids, bold/italic/sub/sup marks, and the three inline atoms. Nothing else is
// enabled, so the editor cannot create content the server would refuse.
import { Extension, Node, type AnyExtension } from '@tiptap/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BLOCKS = ['paragraph', 'heading'];

// Gives every top-level block a UUID; a block that got a copied id (Enter splits, paste) gets a new one.
export function assignBlockIds(doc: PMNode, tr: Transaction): boolean {
  const seen = new Set<string>();
  let changed = false;
  doc.forEach((node, offset) => {
    if (!BLOCKS.includes(node.type.name)) return;
    const id = node.attrs.id as string | null;
    if (typeof id === 'string' && UUID.test(id) && !seen.has(id)) {
      seen.add(id);
      return;
    }
    const fresh = crypto.randomUUID();
    seen.add(fresh);
    tr.setNodeMarkup(offset, undefined, { ...node.attrs, id: fresh });
    changed = true;
  });
  return changed;
}

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
      appendTransaction: (_trs, _old, state) => {
        const tr = state.tr;
        return assignBlockIds(state.doc, tr) ? tr.setMeta('addToHistory', false) : null;
      },
    })];
  },
});

// Inline atoms are kept and shown; creating them comes with references/figures (P04).
const atom = (name: string, attrs: Record<string, { default: unknown }>, label: (a: Record<string, unknown>) => string) =>
  Node.create({
    name,
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    addAttributes: () => attrs,
    parseHTML: () => [{ tag: `span[data-pw-${name}]` }],
    renderHTML: ({ node }) => ['span', { [`data-pw-${name}`]: '', class: `atom atom-${name}`, contenteditable: 'false' }, label(node.attrs)],
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
  atom('citation', { referenceId: { default: null }, locator: { default: null } }, (a) => `[인용${a.locator ? `, ${String(a.locator)}` : ''}]`),
  atom('math_inline', { latex: { default: null } }, (a) => `⟨${String(a.latex)}⟩`),
  atom('figure_ref', { targetId: { default: null } }, () => '[그림/표]'),
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
