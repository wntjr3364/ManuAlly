// PW-012 — TST-012A (server side, hand-checked positions) and TST-012B (rejections, migration path)
import { describe, expect, test } from 'vitest';
import * as core from '../../../packages/editor-core/src/index.ts';
import { BOUNDARIES, ID, REPLACEMENTS, SELECTIONS, manuscript } from './fixtures.ts';
import { fixtureReport } from './fixture-report.ts';

const V = core.EDITOR_SCHEMA_VERSION;
const codes = (r: core.ValidationResult) => (r.ok ? [] : r.errors.map((e) => e.code));
const para = (id: string, content: unknown[] = [{ type: 'text', text: 'x' }], attrs: Record<string, unknown> = {}) => ({ type: 'paragraph', attrs: { id, ...attrs }, content });
const doc = (...content: unknown[]) => ({ type: 'doc', content });

describe('TST-012A: positions follow the contract on hand-checked fixtures', () => {
  test('the golden manuscript is valid and every textblock has the hand-checked boundaries', async () => {
    const r = await fixtureReport(core);
    expect(r.valid, JSON.stringify(r)).toBe(true);
    if (!r.valid || !r.blocks) throw new Error('invalid fixture');
    for (const [id, expected] of Object.entries(BOUNDARIES)) expect(r.blocks[id]!.boundaries, id).toEqual(expected);
    expect(r.blocks[ID.table], 'table block is hashed too').toBeDefined();
    expect(r.blocks[ID.table]!.boundaries).toBeNull();
    expect(r.blocks[ID.table]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('selections give the expected quote and atoms, or the expected refusal', async () => {
    const r = await fixtureReport(core);
    if (!r.valid || !r.selections) throw new Error('invalid fixture');
    for (const s of SELECTIONS) {
      const got = r.selections[s.name] as { ok?: core.SelectionSnapshot; error?: string };
      if (s.error) expect(got.error, s.name).toBe(s.error);
      else {
        expect(got.ok?.quote, s.name).toBe(s.quote);
        if (s.atoms) expect(got.ok?.atoms.map((a) => a.type), s.name).toEqual(s.atoms);
        expect(got.ok?.expected_block_hash, s.name).toMatch(/^[0-9a-f]{64}$/);
        expect(got.ok?.selected_slice_hash, s.name).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  test('replacement content is built from typed items; atoms are kept only by index', async () => {
    const r = await fixtureReport(core);
    if (!r.valid || !r.replacements) throw new Error('invalid fixture');
    for (const c of REPLACEMENTS) {
      const got = r.replacements[c.name] as { ok?: unknown[]; error?: string };
      expect(got.error ? 'error' : 'ok', c.name).toBe(c.error ? 'error' : 'ok');
    }
    const kept = (r.replacements['reword around kept atoms'] as { ok: { type: string; attrs?: Record<string, unknown> }[] }).ok;
    expect(kept.filter((n) => n.type !== 'text').map((n) => n.type)).toEqual(['math_inline', 'figure_ref']);
  });

  test('hashes are canonical: key order does not matter, any content change does', async () => {
    const a = core.parseDocument(doc(para(ID.plain, [{ text: 'same', type: 'text' }])), V);
    const b = core.parseDocument({ content: [{ content: [{ type: 'text', text: 'same' }], attrs: { id: ID.plain }, type: 'paragraph' }], type: 'doc' }, V);
    const c = core.parseDocument(doc(para(ID.plain, [{ type: 'text', text: 'same', marks: [{ type: 'italic' }] }])), V);
    const h = async (d: typeof a) => core.blockHash(core.findBlock(d, ID.plain).node);
    expect(await h(a)).toBe(await h(b));
    expect(await h(a)).not.toBe(await h(c));
    // sha256("abc") through the shared WebCrypto path
    expect(await core.sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('TST-012B: unknown nodes, raw HTML, duplicate ids and other versions are refused or migrated explicitly', () => {
  test.each([
    ['an HTML string', '<p onclick="x()">Hi</p>', 'RAW_HTML'],
    ['an html node', doc({ type: 'html_block', content: [] }), 'RAW_HTML'],
    ['an unknown node', doc({ type: 'video', attrs: { src: 'x' } }), 'UNKNOWN_NODE'],
    ['an unknown mark', doc(para(ID.plain, [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }])), 'UNKNOWN_MARK'],
    ['an event-handler attribute', doc(para(ID.plain, undefined, { onclick: 'x()' })), 'UNKNOWN_ATTR'],
    ['an extra field', doc({ ...para(ID.plain), html: '<b>x</b>' }), 'UNKNOWN_FIELD'],
    ['a block without id', doc({ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }), 'BLOCK_ID_MISSING'],
    ['a non-UUID block id', doc(para('b-1')), 'BLOCK_ID_INVALID'],
    ['duplicate block ids', doc(para(ID.plain), para(ID.plain)), 'BLOCK_ID_DUPLICATE'],
    ['a citation without reference', doc(para(ID.plain, [{ type: 'citation', attrs: { locator: 'p. 1' } }])), 'INVALID_ATTR'],
    ['a figure reference without target', doc(para(ID.plain, [{ type: 'figure_ref', attrs: { targetId: 'fig-1' } }])), 'INVALID_ATTR'],
    ['a table row outside a table', doc({ type: 'table_row', content: [] }), 'INVALID_STRUCTURE'],
    ['empty text', doc(para(ID.plain, [{ type: 'text', text: '' }])), 'INVALID_TEXT'],
    ['a lone surrogate', doc(para(ID.plain, [{ type: 'text', text: 'a\uD800' }])), 'INVALID_TEXT'],
  ])('%s is refused (%s)', (_name, json, code) => {
    expect(codes(core.validateDocument(json, V))).toContain(code);
  });

  test('text that merely looks like HTML is text, never markup', () => {
    const r = core.validateDocument(doc(para(ID.plain, [{ type: 'text', text: '<script>alert(1)</script>' }])), V);
    expect(r.ok).toBe(true);
  });

  test('another schema version is never read silently; migration is an explicit call that fails when no path exists', () => {
    for (const version of [0, 2, '1', undefined]) {
      const r = core.validateDocument(manuscript, version);
      expect(r.ok, String(version)).toBe(false);
      expect(codes(r)[0], String(version)).toMatch(/^MIGRATION_(REQUIRED|NOT_AVAILABLE)$/);
    }
    expect(() => core.migrateDocument(manuscript, 0)).toThrow(/MIGRATION_NOT_AVAILABLE/);
    expect(core.migrateDocument(manuscript, V).schema_version).toBe(V);
  });

  test('parseDocument throws with every problem listed', () => {
    expect(() => core.parseDocument(doc(para(ID.plain), para(ID.plain), { type: 'iframe' }), V)).toThrow(/BLOCK_ID_DUPLICATE.*RAW_HTML|RAW_HTML.*BLOCK_ID_DUPLICATE/);
  });
});
