// PW-012 — regression tests for the independent review (M1, M2, minors 1–11)
import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import * as core from '../../../packages/editor-core/src/index.ts';
import { validateAiReplacement } from '../../../packages/contracts/src/index.ts';
import { ID, REPLACEMENTS, manuscript } from './fixtures.ts';

const V = core.EDITOR_SCHEMA_VERSION;
const LETTERS = 'abcdefab-cdef-4abc-8def-abcdefabcdef'; // upper-casing changes it (ID.ref is all digits)
const t = (text: string) => ({ type: 'text', text });
const para = (...content: unknown[]) => ({ type: 'paragraph', attrs: { id: ID.plain }, content });
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const codes = (r: core.ValidationResult) => (r.ok ? [] : r.errors.map((e) => e.code));

describe('review M1: inline atoms need their attributes', () => {
  test.each(['citation', 'math_inline', 'figure_ref'])('%s without attrs is refused', (type) => {
    expect(codes(core.validateDocument(doc(para(t('a'), { type })), V))).toContain('INVALID_ATTR');
  });
});

describe('review M2: every replacement editor-core builds is a valid document fragment', () => {
  const block = () => core.findBlock(core.parseDocument(manuscript, V), ID.plain).node;
  test.each([
    ['subscript + superscript', [{ type: 'text', text: 'x', marks: ['subscript', 'superscript'] }]],
    ['NUL in locator', [{ type: 'citation', reference_id: ID.ref, locator: 'p\u0000' }]],
    ['lone surrogate in locator', [{ type: 'citation', reference_id: ID.ref, locator: 'p\uD800' }]],
    ['blank locator', [{ type: 'citation', reference_id: ID.ref, locator: '   ' }]],
    ['object replacement character in text', [{ type: 'text', text: 'a￼b' }]],
    ['very long text', [{ type: 'text', text: 'x'.repeat(100_001) }]],
    ['uppercase reference id', [{ type: 'citation', reference_id: LETTERS.toUpperCase() }]],
  ])('%s is refused', (_n, replacement) => {
    expect(() => core.buildReplacement(replacement, core.atomNodesIn(block(), 0, 4))).toThrow(/INVALID_REPLACEMENT/);
  });

  test('accepted fixture replacements, placed in a paragraph, pass validateDocument', () => {
    const d = core.parseDocument(manuscript, V);
    for (const c of REPLACEMENTS.filter((r) => !r.error)) {
      const { node } = core.findBlock(d, c.blockId);
      const built = core.buildReplacement(c.replacement, core.atomNodesIn(node, c.from, c.to));
      const r = core.validateDocument(doc(para(...built.map((n) => n.toJSON()))), V);
      expect(r.ok, `${c.name}: ${JSON.stringify(r)}`).toBe(true);
    }
  });

  test('the model-output contract refuses subscript + superscript and non-canonical UUIDs', () => {
    const base = { schema_version: 1, selection_handle_id: '00000000-0000-4000-8000-0000000000f1', outcome: 'replacement' };
    expect(validateAiReplacement({ ...base, replacement: [{ type: 'text', text: 'x', marks: ['subscript', 'superscript'] }] }).ok).toBe(false);
    for (const id of [LETTERS.toUpperCase(), `urn:uuid:${LETTERS}`, '00000000-0000-0000-0000-000000000000']) {
      expect(validateAiReplacement({ ...base, replacement: [{ type: 'citation', reference_id: id }] }).ok, id).toBe(false);
    }
    expect(validateAiReplacement({ ...base, selection_handle_id: LETTERS.toUpperCase(), replacement: [] }).ok).toBe(false);
  });
});

describe('review minors', () => {
  test('1: editor-core loads under node --experimental-strip-types (the API dev runtime)', () => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', `import(${JSON.stringify(path.resolve('packages/editor-core/src/index.ts'))}).then((m) => console.log(typeof m.validateDocument))`], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('function');
  });

  test('2: inline atoms are hard boundaries, whatever text is next to them', () => {
    const d = core.parseDocument(doc(para(t('a'), { type: 'citation', attrs: { referenceId: ID.ref } }, t('́b'))), V);
    expect(core.graphemeBoundaries(core.findBlock(d, ID.plain).node)).toEqual([0, 1, 2, 3, 4]);
    const d2 = core.parseDocument(doc(para(t('a؀'), { type: 'citation', attrs: { referenceId: ID.ref } })), V);
    expect(core.graphemeBoundaries(core.findBlock(d2, ID.plain).node)).toEqual([0, 1, 2, 3]);
  });

  test('2b: a grapheme split across two differently formatted runs is still one grapheme', () => {
    const d = core.parseDocument(doc(para({ type: 'text', text: 'e', marks: [{ type: 'bold' }] }, t('́x'))), V);
    expect(core.graphemeBoundaries(core.findBlock(d, ID.plain).node)).toEqual([0, 2, 3]);
  });

  test('3: U+FFFC (the atom placeholder) cannot appear in text', () => {
    expect(codes(core.validateDocument(doc(para(t('a￼b'))), V))).toContain('INVALID_TEXT');
  });

  test('4/5: marks only on text; text and atoms have no content', () => {
    expect(codes(core.validateDocument({ ...doc(para(t('a'))), marks: [{ type: 'bold' }] }, V))).toContain('UNKNOWN_MARK');
    expect(codes(core.validateDocument(doc({ ...para(t('a')), marks: [{ type: 'bold' }] }), V))).toContain('UNKNOWN_MARK');
    expect(codes(core.validateDocument(doc(para({ type: 'citation', attrs: { referenceId: ID.ref }, marks: [{ type: 'bold' }] })), V))).toContain('UNKNOWN_MARK');
    expect(codes(core.validateDocument(doc(para({ type: 'text', text: 'a', content: [para(t('hidden'))] })), V))).toContain('INVALID_STRUCTURE');
  });

  test('8: blocks are found only by a UUID', () => {
    const d = core.parseDocument(manuscript, V);
    for (const id of [null, undefined, '', 'not-a-uuid']) {
      expect(() => core.findBlock(d, id as unknown as string), String(id)).toThrow(/BLOCK_ID_INVALID/);
    }
  });

  test('9: migrateDocument validates what it returns', () => {
    expect(() => core.migrateDocument({ type: 'evil' }, V)).toThrow(/NOT_A_DOCUMENT/);
  });

  test('10: canonical JSON stays valid JSON for sparse arrays', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(JSON.parse(core.canonicalJson([1, , null, undefined]))).toEqual([1, null, null, null]);
  });
});
