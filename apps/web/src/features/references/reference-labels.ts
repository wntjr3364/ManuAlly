// Shows computed labels on citation and figure/table reference atoms (display only). The document
// keeps stable ids; the labels come from editor-core with the paper's references, figure order and
// style, so any change of those renumbers every atom at once. Unknown targets show [?] / a warning.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { citationLabels, figureLabels, type CitationStyle, type FigureMeta, type RefMeta } from '@pw/editor-core';

export interface ReferenceContext { refs: RefMeta[]; figures: FigureMeta[]; style: CitationStyle }
const key = new PluginKey<ReferenceContext>('pwReferenceLabels');
const empty: ReferenceContext = { refs: [], figures: [], style: 'numeric' };

export function labelsFor(doc: PMNode, ctx: ReferenceContext) {
  const cites: { pos: number; referenceId: string; locator: string | null }[] = [];
  const figs: { pos: number; targetId: string }[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name === 'citation') cites.push({ pos, referenceId: String(n.attrs.referenceId), locator: (n.attrs.locator as string | null) ?? null });
    if (n.type.name === 'figure_ref') figs.push({ pos, targetId: String(n.attrs.targetId) });
  });
  const c = citationLabels(cites, ctx.refs, ctx.style);
  const f = figureLabels(figs.map((x) => x.targetId), ctx.figures);
  return { cites, figs, c, f };
}

export const ReferenceLabels = Extension.create({
  name: 'referenceLabels',
  addProseMirrorPlugins() {
    return [new Plugin<ReferenceContext>({
      key,
      state: {
        init: () => empty,
        apply: (tr, v) => (tr.getMeta(key) as ReferenceContext | undefined) ?? v,
      },
      props: {
        decorations(state) {
          const { cites, figs, c, f } = labelsFor(state.doc, key.getState(state) ?? empty);
          const deco = [
            ...cites.map((x, i) => Decoration.node(x.pos, x.pos + 1, { 'data-label': c.labels[i]!, class: c.labels[i] === '[?]' ? 'labeled unresolved' : 'labeled' })),
            ...figs.map((x, i) => Decoration.node(x.pos, x.pos + 1, { 'data-label': f.labels[i]!, class: f.unresolved.includes(x.targetId) ? 'labeled unresolved' : 'labeled' })),
          ];
          return DecorationSet.create(state.doc, deco);
        },
      },
    })];
  },
});

export function setReferenceContext(view: EditorView, ctx: ReferenceContext): void {
  view.dispatch(view.state.tr.setMeta(key, ctx).setMeta('addToHistory', false));
}
