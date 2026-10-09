// Every change that does not come from the user's own keyboard (an AI patch, PW-017; a restore) goes
// through here. It is refused while an IME composition is in progress: changing the document under
// a composition breaks the composed text (spec 04 "IME composition 중 patch 적용 금지").
import type { EditorState, Transaction } from '@tiptap/pm/state';

export interface PatchView {
  composing: boolean;
  editable?: boolean;
  readonly state: EditorState;
  dispatch(tr: Transaction): void;
}
export type PatchResult = { applied: true } | { applied: false; code: 'COMPOSING' | 'NOT_EDITABLE' | 'NO_EDITOR' | 'NO_CHANGE' };

export function applyExternalPatch(view: PatchView | null | undefined, build: (state: EditorState) => Transaction | null): PatchResult {
  if (!view) return { applied: false, code: 'NO_EDITOR' };
  if (view.composing) return { applied: false, code: 'COMPOSING' };
  if (view.editable === false) return { applied: false, code: 'NOT_EDITABLE' };
  const tr = build(view.state);
  if (!tr || !tr.docChanged) return { applied: false, code: 'NO_CHANGE' };
  view.dispatch(tr);
  return { applied: true };
}
