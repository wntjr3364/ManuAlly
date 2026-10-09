// Highlights of open, attached comments in the editor (display only). Ranges come from the server for
// the stored head the screen shows; afterwards they follow edits on screen until the next refresh.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

export type CommentRange = { id: string; from: number; to: number };
const key = new PluginKey<CommentRange[]>('pwCommentHighlights');

export const CommentHighlights = Extension.create({
  name: 'commentHighlights',
  addProseMirrorPlugins() {
    return [new Plugin<CommentRange[]>({
      key,
      state: {
        init: () => [],
        apply(tr, ranges) {
          const meta = tr.getMeta(key) as CommentRange[] | undefined;
          if (meta) return meta;
          if (!tr.docChanged) return ranges;
          return ranges
            .map((r) => ({ ...r, from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) }))
            .filter((r) => r.from < r.to);
        },
      },
      props: {
        decorations(state) {
          const ranges = key.getState(state) ?? [];
          return DecorationSet.create(state.doc, ranges.map((r) => Decoration.inline(r.from, r.to, { class: 'comment-highlight', 'data-thread-id': r.id })));
        },
      },
    })];
  },
});

export function setCommentRanges(view: EditorView, ranges: CommentRange[]): void {
  view.dispatch(view.state.tr.setMeta(key, ranges).setMeta('addToHistory', false));
}
