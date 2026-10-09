// PW-021 — comparing two revisions block by block (by stable block id): changed paragraphs show a
// word diff; added, removed and moved paragraphs are named as such.
import { describe, expect, test } from 'vitest';
import { compareDocuments } from '../../../apps/web/src/features/versions/compare.ts';

const p = (id: string, text: string) => ({ type: 'paragraph', attrs: { id }, content: text ? [{ type: 'text', text }] : [] });
const doc = (...b: unknown[]) => ({ type: 'doc', content: b });

describe('compareDocuments', () => {
  test('unchanged, changed, added and removed blocks', () => {
    const a = doc(p('1', 'Same text.'), p('2', 'It was very clear.'), p('3', 'Gone soon.'));
    const b = doc(p('1', 'Same text.'), p('2', 'It was clear.'), p('4', 'New one.'));
    const c = compareDocuments(a, b);
    expect(c.map((x) => [x.kind, x.id])).toEqual([['same', '1'], ['changed', '2'], ['removed', '3'], ['added', '4']]);
    const changed = c.find((x) => x.kind === 'changed')!;
    expect(changed.parts!.filter((x) => x.kind === 'del').map((x) => x.text.trim())).toEqual(['very']);
    expect(c.find((x) => x.kind === 'removed')!.text).toBe('Gone soon.');
    expect(c.find((x) => x.kind === 'added')!.text).toBe('New one.');
  });
  test('a moved paragraph is reported as moved, not as removed and added', () => {
    const c = compareDocuments(doc(p('1', 'A'), p('2', 'B'), p('3', 'C')), doc(p('3', 'C'), p('1', 'A'), p('2', 'B')));
    expect(c.map((x) => [x.kind, x.id])).toEqual([['moved', '3'], ['same', '1'], ['same', '2']]);
  });
  test('identical documents have no differences', () => {
    const d = doc(p('1', 'A'));
    expect(compareDocuments(d, d).every((x) => x.kind === 'same')).toBe(true);
  });
  test('a heading level change counts as a change', () => {
    const h = (level: number) => ({ type: 'heading', attrs: { id: 'h', level }, content: [{ type: 'text', text: 'Results' }] });
    expect(compareDocuments(doc(h(1)), doc(h(2)))[0]!.kind).toBe('changed');
  });
});
