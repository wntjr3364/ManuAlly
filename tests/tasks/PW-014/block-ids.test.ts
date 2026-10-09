// PW-014 review M4: block ids follow the block. On a duplicate the block that existed before keeps
// its id and the inserted copy gets a new one; changing a block's type keeps its id.
import { describe, expect, test } from 'vitest';
import { createEditorState, editorSchema as schema, reconcileBlockIds, type EditorState, type Transaction } from '../../../apps/web/src/features/paper/block-ids.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const doc = () => schema.nodeFromJSON({ type: 'doc', content: [
  { type: 'paragraph', attrs: { id: A }, content: [{ type: 'text', text: 'first' }] },
  { type: 'paragraph', attrs: { id: B }, content: [{ type: 'text', text: 'second' }] },
  { type: 'paragraph', attrs: { id: C }, content: [{ type: 'text', text: 'third' }] },
] });
const ids = (s: EditorState) => { const out: string[] = []; s.doc.forEach((n) => out.push(n.attrs.id)); return out; };
// apply one user transaction, then the reconciliation that appendTransaction would add
function step(state: EditorState, build: (s: EditorState) => Transaction) {
  const tr = build(state);
  const next = state.apply(tr);
  const fix = reconcileBlockIds(state.doc, next, [tr]);
  return fix ? next.apply(fix) : next;
}
const offsetOf = (s: EditorState, id: string) => { let p = -1; s.doc.forEach((n, off) => { if (n.attrs.id === id) p = off; }); return p; };

describe('block ids', () => {
  test('pasting a copy of B above B: the original keeps B, the copy gets a new id', () => {
    const s0 = createEditorState(doc());
    const bNode = s0.doc.child(1);
    const s1 = step(s0, (s) => s.tr.insert(offsetOf(s, B), bNode));
    const out = ids(s1);
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(A);
    expect(out[2]).toBe(B); // the original, now third
    expect(out[1]).not.toBe(B);
    expect(new Set(out).size).toBe(4);
  });

  test('pasting a copy of B below B: the original keeps B', () => {
    const s0 = createEditorState(doc());
    const bNode = s0.doc.child(1);
    const s1 = step(s0, (s) => s.tr.insert(offsetOf(s, B) + bNode.nodeSize, bNode));
    expect(ids(s1)[1]).toBe(B);
    expect(ids(s1)[2]).not.toBe(B);
  });

  test('turning several paragraphs into headings keeps their ids', () => {
    const s0 = createEditorState(doc());
    const s1 = step(s0, (s) => s.tr.setBlockType(1, s.doc.content.size - 1, schema.nodes.heading!, { level: 2 }));
    expect(ids(s1)).toEqual([A, B, C]);
    expect(s1.doc.child(0).type.name).toBe('heading');
  });

  test('splitting a paragraph: the first part keeps the id, the new part gets a fresh one', () => {
    const s0 = createEditorState(doc());
    const s1 = step(s0, (s) => s.tr.split(offsetOf(s, B) + 1 + 3));
    const out = ids(s1);
    expect(out[1]).toBe(B);
    expect(out[2]).not.toBe(B);
    expect(out[3]).toBe(C);
  });

  test('splitting at the very start of a paragraph: the text keeps the id, the new empty block gets a fresh one', () => {
    const s0 = createEditorState(doc());
    const s1 = step(s0, (s) => s.tr.split(offsetOf(s, B) + 1));
    expect(s1.doc.child(1).textContent).toBe('');
    expect(s1.doc.child(2).textContent).toBe('second');
    expect(ids(s1)[2]).toBe(B);
    expect(ids(s1)[1]).not.toBe(B);
  });

  test('typing or pasting inline text at the start of a paragraph keeps its id', () => {
    const s0 = createEditorState(doc());
    const s1 = step(s0, (s) => s.tr.insertText('X', offsetOf(s, B) + 1));
    expect(ids(s1)).toEqual([A, B, C]);
    expect(s1.doc.child(1).textContent).toBe('Xsecond');
    const s2 = step(s1, (s) => s.tr.insertText('pasted ', offsetOf(s, A) + 1));
    expect(ids(s2)).toEqual([A, B, C]);
  });

  test('the first character typed into an empty paragraph keeps its id', () => {
    const E = '00000000-0000-4000-8000-00000000000e';
    const s0 = createEditorState(schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: A }, content: [{ type: 'text', text: 'a' }] }, { type: 'paragraph', attrs: { id: E } }] }));
    const s1 = step(s0, (s) => s.tr.insertText('x', offsetOf(s, E) + 1));
    expect(ids(s1)).toEqual([A, E]);
  });

  test('pasting two paragraphs at the start of B: B keeps its id on its own text, the pasted ones get new ids', () => {
    const s0 = createEditorState(doc());
    const two = schema.nodeFromJSON({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'P1' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'P2' }] },
    ] });
    const s1 = step(s0, (s) => s.tr.replace(offsetOf(s, B) + 1, offsetOf(s, B) + 1, two.slice(1, two.content.size - 1)));
    const out = ids(s1);
    expect(new Set(out).size).toBe(out.length);
    expect(out).toContain(B);
    expect(s1.doc.child(out.indexOf(B)).textContent).toContain('second');
  });

  test('blocks without ids get one; deleting a block leaves the others alone', () => {
    const bare = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph', attrs: { id: B } }] });
    const s0 = createEditorState(bare);
    const fix = reconcileBlockIds(s0.doc, s0, []);
    const s1 = fix ? s0.apply(fix) : s0;
    expect(ids(s1)[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids(s1)[1]).toBe(B);
    const s2 = step(createEditorState(doc()), (s) => s.tr.delete(offsetOf(s, B), offsetOf(s, C)));
    expect(ids(s2)).toEqual([A, C]);
  });
});
