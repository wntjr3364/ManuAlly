// PW-042 — the pure rules of the Writer's answer (packages/contracts/src/writing).
import { describe, expect, test } from 'vitest';
import { AnswerRefused, bibliographyString, hardWordCap, parseWriterAnswer, wordsIn, type ParagraphContract } from '../../../packages/contracts/src/writing/index.ts';

const REF = '11111111-1111-4111-8111-111111111111';
const CLAIM = '22222222-2222-4222-8222-222222222222';
const contract = (o: Partial<ParagraphContract> = {}) => ({
  mandatory_claims: [{ id: CLAIM, kind: 'observation', text: 'x' }], exact_facts: [], citable_references: [{ reference_id: REF, label: 'Kim 2019', linked_to_node: true }],
  target_length: { min_words: null, max_words: 60 }, operation: { mode: 'draft', document_id: '', base_revision_id: '', after_block_id: null, block_id: null, original: null }, ...o,
}) as unknown as ParagraphContract;
const refused = (raw: unknown, c = contract()) => { try { parseWriterAnswer(raw, c); return null; } catch (e) { return e instanceof AnswerRefused ? e.reason : 'other'; } };

describe('bibliography written as text is recognised', () => {
  test.each([
    'as shown (Smith et al., 2020).', 'as shown (Smith, 2020).', 'as shown (Smith and Lee, 2019a; Kim, 2020).', 'Smith et al. (2020) showed', 'Smith et al., 2020 showed',
    'Smith and Lee (2019) showed', 'as shown [12].', 'as shown [1–3, 7].', 'see doi: 10.1/x', 'see 10.1000/xyz123',
  ])('%s', (t) => expect(bibliographyString(t)).toBe(true));
  test.each([
    'ABC1 rose 2.4-fold in 2020 field trials.', 'In 2019 the Kim lab', 'Day 3 (n = 3) samples', 'Figure 2 shows', 'at 20 °C (Fig. 2A)', 'the ratio [Ca2+]',
  ])('not: %s', (t) => expect(bibliographyString(t)).toBe(false));
});

describe('parseWriterAnswer', () => {
  test('a draft with a citation of a paper reference and a declared claim is read', () => {
    const a = parseWriterAnswer({ status: 'draft', paragraph: [{ type: 'text', text: 'ABC1 rose ' }, { type: 'citation', reference_id: REF.toUpperCase() }], claim_ids: [CLAIM], fact_ids: [] }, contract());
    expect(a).toMatchObject({ status: 'draft', claim_ids: [CLAIM] });
    expect((a as { paragraph: { reference_id?: string }[] }).paragraph[1]!.reference_id).toBe(REF);
  });
  test('refusals: shape, ids, citations, line breaks, headings, length, atoms in a new paragraph', () => {
    expect(refused({ status: 'done' })).toBe('malformed');
    expect(refused({ status: 'needs_evidence', missing: [] })).toBe('malformed');
    expect(refused({ status: 'draft', paragraph: [{ type: 'text', text: 'x' }], claim_ids: [], fact_ids: [], extra: 1 })).toBe('unknown fields');
    expect(refused({ status: 'draft', paragraph: [{ type: 'text', text: 'x' }], claim_ids: ['33333333-3333-4333-8333-333333333333'], fact_ids: [] })).toBe('claim_not_in_contract');
    expect(refused({ status: 'draft', paragraph: [{ type: 'text', text: 'x' }], claim_ids: [], fact_ids: [CLAIM] })).toBe('fact_not_in_contract');
    expect(refused({ status: 'draft', paragraph: [{ type: 'citation', reference_id: CLAIM }], claim_ids: [], fact_ids: [] })).toBe('citation_not_in_paper');
    expect(refused({ status: 'draft', paragraph: [{ type: 'text', text: 'one\rtwo' }], claim_ids: [], fact_ids: [] })).toBe('scope_exceeded');
    expect(refused({ status: 'draft', paragraph: [{ type: 'text', text: '# Results' }], claim_ids: [], fact_ids: [] })).toBe('scope_exceeded');
    expect(refused({ status: 'draft', paragraph: [{ type: 'text', text: Array(121).fill('w').join(' ') }], claim_ids: [], fact_ids: [] })).toBe('scope_exceeded');
    expect(refused({ status: 'draft', paragraph: [{ type: 'text', text: Array(120).fill('w').join(' ') }], claim_ids: [], fact_ids: [] })).toBeNull();
    expect(refused({ status: 'draft', paragraph: [{ type: 'preserve_atom', atom_index: 0 }], claim_ids: [], fact_ids: [] })).toBe('malformed');
  });
  test('the hard cap is about twice the budget (300 words without one)', () => {
    expect(hardWordCap(contract())).toBe(120);
    expect(hardWordCap(contract({ target_length: { min_words: null, max_words: 20 } }))).toBe(60);
    expect(hardWordCap(contract({ target_length: { min_words: null, max_words: null } }))).toBe(300);
    expect(wordsIn([{ type: 'text', text: 'ABC1 rose 2.4-fold ( n = 3 ) .' }])).toBe(5); // punctuation alone is not a word
  });
});
