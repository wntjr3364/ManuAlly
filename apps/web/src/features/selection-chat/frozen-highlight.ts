// Keeps the frozen request range visible while focus is in the popup (the browser hides the editor's
// own selection highlight when focus leaves it). Display only: the range follows later edits on
// screen, but the request itself keeps its frozen snapshot.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

type Range = { from: number; to: number } | null;
const key = new PluginKey<Range>('pwFrozenSelection');

export const FrozenSelection = Extension.create({
  name: 'frozenSelection',
  addProseMirrorPlugins() {
    return [new Plugin<Range>({
      key,
      state: {
        init: () => null,
        apply(tr, value) {
          const meta = tr.getMeta(key) as Range | undefined;
          if (meta !== undefined) return meta;
          if (!value || !tr.docChanged) return value;
          const from = tr.mapping.map(value.from, 1);
          const to = tr.mapping.map(value.to, -1);
          return from < to ? { from, to } : null;
        },
      },
      props: {
        decorations(state) {
          const r = key.getState(state);
          return r ? DecorationSet.create(state.doc, [Decoration.inline(r.from, r.to, { class: 'frozen-selection', 'data-testid': 'frozen-selection' })]) : null;
        },
      },
    })];
  },
});

export function setFrozenRange(view: EditorView, range: Range): void {
  view.dispatch(view.state.tr.setMeta(key, range).setMeta('addToHistory', false));
}
export const frozenRange = (state: EditorState): Range => key.getState(state) ?? null;
