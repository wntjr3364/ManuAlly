// PW-020 — the mock provider is deterministic, offline and always labelled MOCK; its corrections keep
// atoms, marks and every number, so the PW-017 checks pass for the fixtures used in tests and demos.
import { describe, expect, test } from 'vitest';
import { createMockProvider, MOCK_LABEL } from '../../../packages/providers/src/mock/index.ts';
import { selectProvider } from '../../../packages/providers/src/index.ts';

const collect = async (it: AsyncIterable<string>) => { const out: string[] = []; for await (const x of it) out.push(x); return out; };

describe('mock provider', () => {
  const m = createMockProvider();
  test('is labelled MOCK and selected by default', () => {
    expect(m).toMatchObject({ id: 'mock', label: MOCK_LABEL });
    expect(MOCK_LABEL).toBe('MOCK');
    expect(selectProvider({}).id).toBe('mock');
  });

  test('answers deterministically, in several pieces, saying it is a mock', async () => {
    const a = await collect(m.answer({ question: 'Is this too strong?', quote: 'very clear' }));
    const b = await collect(m.answer({ question: 'Is this too strong?', quote: 'very clear' }));
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(1);
    expect(a.join('')).toMatch(/^\[MOCK\] /);
    expect(a.join('')).toContain('실제 AI');
  });

  test('concise removes filler words only; atoms and marks stay', async () => {
    const r = await m.revise({ intent: 'concise', instruction: '', items: [{ type: 'text', text: 'It was very very clear ' }, { type: 'preserve_atom', atom_index: 0 }, { type: 'text', text: ' in order to test', marks: ['italic'] }] });
    expect(r.items).toEqual([{ type: 'text', text: 'It was clear ' }, { type: 'preserve_atom', atom_index: 0 }, { type: 'text', text: ' to test', marks: ['italic'] }]);
    expect(r.explanation).toMatch(/MOCK/);
  });

  test('grammar fixes spacing and doubled words; numbers are untouched', async () => {
    const r = await m.revise({ intent: 'grammar', instruction: '', items: [{ type: 'text', text: 'The the cells  grew 2.4-fold , then stopped .' }] });
    expect(r.items).toEqual([{ type: 'text', text: 'The cells grew 2.4-fold, then stopped.' }]);
  });

  test('nothing to change returns the same items', async () => {
    const items = [{ type: 'text' as const, text: 'Cells divided twice.' }];
    expect((await m.revise({ intent: 'grammar', instruction: '', items })).items).toEqual(items);
  });

  test('a text item that would become empty is dropped, never sent as empty text', async () => {
    const r = await m.revise({ intent: 'concise', instruction: '', items: [{ type: 'text', text: 'very ' }, { type: 'preserve_atom', atom_index: 0 }] });
    expect(r.items).toEqual([{ type: 'preserve_atom', atom_index: 0 }]);
  });
});
