// PW-018 — comment anchors (TST-018A / TST-018B, unit part): an anchor follows its text when that is
// certain (paragraph moved, small edit elsewhere) and becomes ORPHANED when its text is gone or the
// place is ambiguous. It is never attached to a merely similar sentence.
import { describe, expect, test } from 'vitest';
import { makeAnchor, resolveAnchor } from '../../../packages/domain/src/comments/anchor.ts';
import { parseDocument } from '../../../packages/editor-core/src/index.ts';

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
const REF = '00000000-0000-4000-8000-0000000000f1';
const para = (id: string, ...content: unknown[]) => ({ type: 'paragraph', attrs: { id }, content });
const text = (t: string) => ({ type: 'text', text: t });
const doc = (...blocks: unknown[]) => parseDocument({ type: 'doc', content: blocks }, 1);

const base = doc(para(A, text('Roots grew. Expression rose in roots. Leaves were small.')), para(B, text('Other paragraph.')));
const quote = 'Expression rose in roots.';
const at = 'Roots grew. '.length;
const anchor = makeAnchor(base, A, at, at + quote.length);

describe('comment anchors', () => {
  test('an anchor records the quote and its surroundings', () => {
    expect(anchor).toMatchObject({ block_id: A, from: at, to: at + quote.length, quote, prefix: 'Roots grew. ', suffix: ' Leaves were small.' });
  });

  test('unchanged text: attached where it was', () => {
    expect(resolveAnchor(base, anchor)).toEqual({ state: 'ATTACHED', block_id: A, from: at, to: at + quote.length, moved: false });
  });

  test('TST-018A: the paragraph moved: attached in its new place', () => {
    const moved = doc(para(B, text('Other paragraph.')), para(A, text('Roots grew. Expression rose in roots. Leaves were small.')));
    expect(resolveAnchor(moved, anchor)).toMatchObject({ state: 'ATTACHED', block_id: A, from: at });
  });

  test('TST-018A: a small edit before the text: attached at the shifted position', () => {
    const edited = doc(para(A, text('Roots grew fast. Expression rose in roots. Leaves were small.')));
    expect(resolveAnchor(edited, anchor)).toEqual({ state: 'ATTACHED', block_id: A, from: at + 5, to: at + 5 + quote.length, moved: true });
  });

  test('TST-018A: an atom inserted before the text counts as one position', () => {
    const edited = doc(para(A, text('Roots grew'), { type: 'citation', attrs: { referenceId: REF, locator: null } }, text('. Expression rose in roots. Leaves were small.')));
    expect(resolveAnchor(edited, anchor)).toMatchObject({ state: 'ATTACHED', from: at + 1 });
  });

  test('TST-018B: the commented text was changed or deleted: ORPHANED', () => {
    expect(resolveAnchor(doc(para(A, text('Roots grew. Expression fell in roots. Leaves were small.'))), anchor)).toEqual({ state: 'ORPHANED', reason: 'TEXT_CHANGED' });
    expect(resolveAnchor(doc(para(A, text('Roots grew. Leaves were small.'))), anchor)).toEqual({ state: 'ORPHANED', reason: 'TEXT_CHANGED' });
  });

  test('TST-018B: the paragraph was deleted: ORPHANED, even if the same sentence exists elsewhere', () => {
    const elsewhere = doc(para(B, text('Roots grew. Expression rose in roots. Leaves were small.')));
    expect(resolveAnchor(elsewhere, anchor)).toEqual({ state: 'ORPHANED', reason: 'BLOCK_MISSING' });
  });

  test('TST-018B: several equal candidates that the surroundings cannot tell apart: ORPHANED', () => {
    const twice = doc(para(A, text('Roots grew. Expression rose in roots. Leaves were small. Roots grew. Expression rose in roots. Leaves were small.')));
    expect(resolveAnchor(twice, anchor)).toEqual({ state: 'ORPHANED', reason: 'AMBIGUOUS' });
    // the original place now holds other text and the sentence appears twice elsewhere in the block
    const moved = doc(para(A, text('Intro. Expression rose in roots. Then. Expression rose in roots. End.')));
    expect(resolveAnchor(moved, anchor)).toEqual({ state: 'ORPHANED', reason: 'AMBIGUOUS' });
  });

  test('several equal candidates, exactly one with the recorded surroundings: attached to that one', () => {
    const copy = doc(para(A, text('Copy: Expression rose in roots. Roots grew. Expression rose in roots. Leaves were small.')));
    const r = resolveAnchor(copy, anchor);
    expect(r).toMatchObject({ state: 'ATTACHED', moved: true });
    expect(r.state === 'ATTACHED' && r.from).toBe('Copy: Expression rose in roots. Roots grew. '.length);
  });
});
