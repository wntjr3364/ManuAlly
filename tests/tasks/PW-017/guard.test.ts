// PW-017 — server checks on a proposed replacement (TST-017B "숫자 보호 위반" part). Ported from the
// PW-003 conservative guard; known bypasses stay listed in RFC-003.
import { describe, expect, test } from 'vitest';
import { checkReplacement } from '../../../packages/domain/src/proposals/guard.ts';
import { schema } from '../../../packages/editor-core/src/index.ts';

const REF = '00000000-0000-4000-8000-0000000000f1';
const REF2 = '00000000-0000-4000-8000-0000000000f2';
const t = (text: string, marks: string[] = []) => schema.text(text, marks.map((m) => schema.marks[m]!.create()));
const cite = (id = REF, locator: string | null = null) => schema.nodes.citation!.create({ referenceId: id, locator });
const math = (latex: string) => schema.nodes.math_inline!.create({ latex });
const failed = (before: Parameters<typeof checkReplacement>[0], after: Parameters<typeof checkReplacement>[1], intent: Parameters<typeof checkReplacement>[2] = 'concise') =>
  checkReplacement(before, after, intent).filter((c) => c.result === 'fail').map((c) => c.check);

describe('replacement checks', () => {
  test('a pure wording change passes every check', () => {
    const checks = checkReplacement([t('Expression rose 2.4-fold in roots')], [t('Expression increased 2.4-fold in roots')], 'concise');
    expect(checks.every((c) => c.result === 'pass')).toBe(true);
    expect(checks.map((c) => c.check)).toEqual(['protected_atoms', 'citations', 'citation_positions', 'formatted_runs', 'numbers', 'negations', 'directions']);
  });

  test('numbers, units, comparators and spelled numbers are protected', () => {
    expect(failed([t('rose 2.4-fold')], [t('rose 2.5-fold')])).toEqual(['numbers']);
    expect(failed([t('10 mM')], [t('10 µM')])).toEqual(['numbers']);
    expect(failed([t('p < 0.05')], [t('p > 0.05')])).toEqual(['numbers']);
    expect(failed([t('two replicates')], [t('three replicates')])).toEqual(['numbers']);
    expect(failed([t('10'), t('5', ['superscript'])], [t('105')])).toEqual(['formatted_runs', 'numbers']);
  });

  test('citations, their locators and positions, and other atoms are protected', () => {
    expect(failed([t('induced'), cite()], [t('induced'), cite(REF2)])).toEqual(['citations']);
    expect(failed([t('induced'), cite(REF, 'p. 4')], [t('induced'), cite(REF, 'p. 5')])).toEqual(['citations']);
    expect(failed([t('induced'), cite(), t(' in roots')], [t('induced in roots'), cite()])).toEqual(['citation_positions']);
    expect(failed([t('with '), math('x^2')], [t('with x squared')])).toEqual(['protected_atoms']);
  });

  test('negations and directions are protected for conservative edits', () => {
    expect(failed([t('did not increase')], [t('increased')])).toEqual(['negations']);
    expect(failed([t('expression rose')], [t('expression fell')])).toEqual(['directions']);
  });

  test('academic rewrite may reorder clauses (directions compared as a multiset) but not add or flip them', () => {
    const before = [t('A rose while B fell')];
    expect(failed(before, [t('B fell while A rose')], 'rewrite')).toEqual([]);
    expect(failed(before, [t('B fell while A rose')], 'concise')).toEqual(['directions']);
    expect(failed(before, [t('A rose while B rose')], 'rewrite')).toEqual(['directions']);
  });
});
