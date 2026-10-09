// What a selection in the editor refers to (spec 04 "현재 대상과 허용 범위를 항상 보여준다").
// Only a non-empty range inside one paragraph or heading is a target. An empty selection, a range
// across blocks or a whole-document selection never becomes an implicit "whole manuscript" target.
import type { Node as PMNode } from '@tiptap/pm/model';

export type SelectionTarget =
  | { kind: 'none' }
  | { kind: 'multi' }
  | {
    kind: 'block';
    blockId: string;
    blockIndex: number;
    blockType: string;
    from: number; // block-relative ProseMirror positions (editor-core contract)
    to: number;
    absFrom: number;
    absTo: number;
    quote: string; // the selected text, one U+FFFC per inline atom
  };

export function selectionTarget(doc: PMNode, from: number, to: number): SelectionTarget {
  if (from === to) return { kind: 'none' };
  const $from = doc.resolve(Math.min(from, to));
  const $to = doc.resolve(Math.max(from, to));
  if ($from.depth < 1 || $to.depth < 1 || $from.before(1) !== $to.before(1)) return { kind: 'multi' };
  const index = $from.index(0);
  const block = doc.child(index);
  const id = block.attrs.id as unknown;
  if (typeof id !== 'string' || !block.isTextblock) return { kind: 'none' };
  const start = $from.before(1) + 1;
  const absFrom = $from.pos;
  const absTo = $to.pos;
  return {
    kind: 'block',
    blockId: id,
    blockIndex: index,
    blockType: block.type.name,
    from: absFrom - start,
    to: absTo - start,
    absFrom,
    absTo,
    quote: doc.textBetween(absFrom, absTo, '\n', '￼'),
  };
}
