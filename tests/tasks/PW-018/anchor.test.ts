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

describe('review regressions', () => {
  test('review MAJOR P1: a deleted short quote does not jump to the same word in another sentence', () => {
    const d0 = doc(para(A, text('We measured growth. The effect was large in mutants.')));
    const a = makeAnchor(d0, A, 'We measured growth. The '.length, 'We measured growth. The effect'.length);
    const d1 = doc(para(A, text('We measured growth. Its size was large in mutants. A side effect remains unclear.')));
    expect(resolveAnchor(d1, a)).toEqual({ state: 'ORPHANED', reason: 'TEXT_CHANGED' });
  });

  test('review MAJOR P2: the original sentence replaced and one identical copy elsewhere: ORPHANED, like with two copies', () => {
    const one = doc(para(A, text('Roots grew. Something else now. Leaves were small. Later: Expression rose in roots. End.')));
    expect(resolveAnchor(one, anchor)).toEqual({ state: 'ORPHANED', reason: 'TEXT_CHANGED' });
  });

  test('review MINOR: a comment on a citation does not stay attached when the citation is replaced by another', () => {
    const OTHER = '00000000-0000-4000-8000-0000000000f2';
    const c = (id: string, locator: string | null = null) => ({ type: 'citation', attrs: { referenceId: id, locator } });
    const d0 = doc(para(A, text('As shown '), c(REF), text(' before.')));
    const a = makeAnchor(d0, A, 0, 'As shown '.length + 1);
    expect(a.atoms).toEqual([{ type: 'citation', referenceId: REF, locator: null }]);
    expect(resolveAnchor(doc(para(A, text('As shown '), c(OTHER, 'p. 9'), text(' before.'))), a)).toEqual({ state: 'ORPHANED', reason: 'TEXT_CHANGED' });
    expect(resolveAnchor(doc(para(A, text('Earlier. As shown '), c(REF), text(' before.'))), a)).toMatchObject({ state: 'ATTACHED', from: 9 });
  });
});

describe('re-review regressions', () => {
  test('re-review MAJOR-2 P4: near text that was not unique when the comment was made is not evidence', () => {
    const d0 = doc(para(A, text('In controls the number of cells rose sharply. In mutants the number of cells fell slightly.')));
    const second = d0.firstChild!.textContent.lastIndexOf('cells');
    const a = makeAnchor(d0, A, second, second + 5);
    expect(a.near).toEqual({ before: false, after: true });
    const d1 = doc(para(A, text('In controls the number of cells rose sharply.')));
    expect(resolveAnchor(d1, a)).toEqual({ state: 'ORPHANED', reason: 'TEXT_CHANGED' });
    // the unique side still carries a small edit on the other side
    const d2 = doc(para(A, text('In controls the number of cells rose sharply. In mutant lines the count of cells fell slightly.')));
    expect(resolveAnchor(d2, a)).toMatchObject({ state: 'ATTACHED', moved: true });
  });

  test('re-review MAJOR-1: atoms are compared independent of key order (as stored in jsonb)', () => {
    const c = { type: 'citation', attrs: { referenceId: REF, locator: 'p. 4' } };
    const d0 = doc(para(A, text('As shown '), c, text(' here.')));
    const a = makeAnchor(d0, A, 0, 10);
    const reordered = { ...a, atoms: a.atoms.map((x) => ({ locator: x.locator, referenceId: x.referenceId, type: x.type })) };
    expect(resolveAnchor(d0, reordered)).toMatchObject({ state: 'ATTACHED', moved: false });
  });
});

describe('final check regressions', () => {
  test('final check MINOR-1 P8: a paragraph edge alone is not evidence', () => {
    const d0 = doc(para(A, text('Effect was large.')));
    const a = makeAnchor(d0, A, 0, 6);
    expect(resolveAnchor(doc(para(A, text('Effect sizes were small.'))), a)).toEqual({ state: 'ORPHANED', reason: 'TEXT_CHANGED' });
    expect(resolveAnchor(doc(para(A, text('Effect was large. Clearly so.'))), a)).toMatchObject({ state: 'ATTACHED', from: 0 }); // the text after it still matches
  });
});
