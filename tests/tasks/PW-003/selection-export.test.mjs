// PW-003 — TST-003A / TST-003B (revised after the independent P00 review, findings M1–M3)
// Run: node --test 'tests/tasks/PW-003/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSelectionHandle, HandleStore, applyAiProposal, applyUserEdit, blockText, blockHash, SelectionError } from '../../../spikes/editor-export/src/selection.mjs';
import { exportDocument, buildLossReport } from '../../../spikes/editor-export/src/export.mjs';
import { buildDoc, posOf, bibliography, REF_A, REF_B } from './fixture.mjs';

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pw003-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// Takes a handle on the n-th occurrence of `needle` in a block and registers it, as the server would.
function select(doc, handles, blockId, needle, { endNeedle = needle, nth = 0 } = {}) {
  let from = -1;
  for (let i = 0; i <= nth; i++) from = posOf(doc, blockId, needle, { startAt: from + 1 });
  const to = endNeedle === needle ? from + needle.length : posOf(doc, blockId, endNeedle, { after: true, startAt: from });
  return handles.register(createSelectionHandle(doc, { blockId, from, to }));
}
const proposal = (handle, replacement, extra = {}) => ({ proposal_id: randomUUID(), selection_handle_id: handle.handle_id, replacement, ...extra });
const text = (s) => ({ type: 'text', text: s });
const citationsIn = (doc, blockId) => {
  const out = [];
  doc.forEach((n) => { if (n.attrs.id === blockId) n.descendants((c) => { if (c.type.name === 'citation') out.push(c.attrs.referenceId); }); });
  return out;
};
const ctx = () => ({ handles: new HandleStore(), applied: new Set() });

// ---------- TST-003A: preservation ----------

test('TST-003A: an AI proposal changes only its selection; the base document object is untouched', () => {
  const doc = buildDoc();
  const c = ctx();
  const h = select(doc, c.handles, 'b-p1', 'under stress');
  const before = blockText(doc, 'b-p1');
  const res = applyAiProposal(doc, proposal(h, [text('during drought')]), c);
  assert.equal(res.status, 'APPLIED');
  assert.equal(blockText(res.doc, 'b-p1'), before.replace('under stress', 'during drought'));
  assert.deepEqual(citationsIn(res.doc, 'b-p1'), [REF_A]);
  for (const id of ['b-p2', 'b-p3', 'b-p4', 'b-p5', 'b-p6']) assert.equal(blockText(res.doc, id), blockText(doc, id));
  assert.equal(blockText(doc, 'b-p1'), before);
});

test('TST-003A: a selection spanning a citation must keep the same citation, locator and anchor word', () => {
  const doc = buildDoc();
  const c = ctx();
  const h = select(doc, c.handles, 'b-p1', 'was stable', { endNeedle: '￼.' });
  assert.deepEqual(h.atoms, [{ type: 'citation', referenceId: REF_A, locator: null }]);
  assert.equal(applyAiProposal(doc, proposal(h, [text('remained stable.')]), c).code, 'CITATION_CHANGED');
  const kept = applyAiProposal(doc, proposal(h, [text('remained stable '), { type: 'citation', reference_id: REF_A, locator: null }, text('.')]), c);
  assert.equal(kept.status, 'APPLIED');
  assert.deepEqual(citationsIn(kept.doc, 'b-p1'), [REF_A]);
});

test('TST-003A: conservative guard catches the value, comparator, unit, direction, negation, mark and locator changes found in review', () => {
  const doc = buildDoc();
  const c = ctx();
  const whole = select(doc, c.handles, 'b-p6', 'Group A', { endNeedle: ' cells ￼.' });
  const orig = { cite: { type: 'citation', reference_id: REF_B, locator: 'p. 4' }, sup: { type: 'text', text: '5', marks: ['superscript'] } };
  const variant = (head, { sup = orig.sup, tail = ' cells ', cite = orig.cite } = {}) => [text(head), sup, text(tail), cite, text('.')].filter(Boolean);
  const base = 'Group A had 1.2 and group B had 3.4 (p < 0.05); 5 µM treatment increased growth and did not cause damage in 10';
  const cases = [
    ['group values swapped', variant(base.replace('1.2', 'X').replace('3.4', '1.2').replace('X', '3.4')), 'NUMBERS_CHANGED'],
    ['comparator flipped', variant(base.replace('p < 0.05', 'p > 0.05')), 'NUMBERS_CHANGED'],
    ['unit changed', variant(base.replace('µM', 'mM')), 'NUMBERS_CHANGED'],
    ['direction flipped', variant(base.replace('increased', 'decreased')), 'DIRECTION_CHANGED'],
    ['negation removed', variant(base.replace('did not cause', 'caused')), 'NEGATION_CHANGED'],
    ['superscript flattened', variant(`${base}5`, { sup: null }), 'MARKS_CHANGED'],
    ['superscript mark dropped', variant(base, { sup: text('5') }), 'MARKS_CHANGED'],
    ['citation locator changed', variant(base, { cite: { ...orig.cite, locator: 'p. 99' } }), 'CITATION_CHANGED'],
    ['citation moved to another clause', [text('Group A had 1.2 '), orig.cite, text(base.slice('Group A had 1.2'.length)), orig.sup, text(' cells.')], 'CITATION_MOVED'],
  ];
  for (const [name, replacement, code] of cases) {
    const res = applyAiProposal(doc, proposal(whole, replacement), c);
    assert.equal(res.code, code, `${name}: ${JSON.stringify(res)}`);
  }
  // a faithful grammar edit passes
  const ok = applyAiProposal(doc, proposal(whole, variant(base.replace('treatment increased', 'treatment clearly increased'))), c);
  assert.equal(ok.status, 'APPLIED');
});

// ---------- TST-003A: export ----------

test('TST-003A: export writes DOCX + HTML preview + a per-block loss report', (t) => {
  const out = tmp(t);
  const { report } = exportDocument(buildDoc(), { bibliography, outDir: out });
  for (const f of ['manuscript.docx', 'preview.html', 'loss-report.json', 'pandoc-input.json']) assert.ok(fs.existsSync(path.join(out, f)), f);
  const byFeature = Object.fromEntries(report.features.map((f) => [f.feature, f]));
  for (const f of ['block_text', 'korean_text', 'emoji', 'greek', 'combining_marks', 'italic', 'subscript', 'superscript', 'table', 'inline_math', 'bibliography', 'citation_rendered_text']) {
    assert.equal(byFeature[f]?.status, 'preserved', `${f}: ${JSON.stringify(byFeature[f])}`);
  }
  assert.equal(byFeature.citation_live_field.status, 'lost');
  assert.equal(byFeature.block_ids.status, 'lost');
  assert.equal(byFeature.figure_ref.status, 'degraded');
});

test('TST-003A: the loss report flags dropped blocks and dropped marks, not just feature presence', (t) => {
  const out = tmp(t);
  const doc = buildDoc();
  const { roundTrip, docxXml, info } = exportDocument(doc, { bibliography, outDir: out });
  const dropped = structuredClone(roundTrip);
  // remove the duplicated paragraph b-p3 and the decomposed-Hangul paragraph b-p5
  dropped.blocks = dropped.blocks.filter((b) => !JSON.stringify(b).includes('Jamo'));
  dropped.blocks.splice(3, 1);
  const r1 = buildLossReport({ doc, docxXml, roundTrip: dropped, bibliography, info });
  const blockText = r1.features.find((f) => f.feature === 'block_text');
  assert.equal(blockText.status, 'lost');
  assert.ok(blockText.blocks.includes('b-p5'), JSON.stringify(blockText));

  const unmarked = JSON.parse(JSON.stringify(roundTrip).replaceAll('"Subscript"', '"Span_"').replaceAll('{"t":"Span_","c":', '{"t":"Emph","c":'));
  const r2 = buildLossReport({ doc, docxXml, roundTrip: unmarked, bibliography, info });
  assert.equal(r2.features.find((f) => f.feature === 'subscript').status, 'lost');
});

// ---------- TST-003B: binding, ambiguity, replay ----------

test('TST-003B: identical sentences — only the selected occurrence changes; quote-only operations are refused', () => {
  const doc = buildDoc();
  const c = ctx();
  const h = select(doc, c.handles, 'b-p3', 'may contribute');
  const res = applyAiProposal(doc, proposal(h, [text('might contribute')]), c);
  assert.equal(blockText(res.doc, 'b-p2'), 'The pathway may contribute to growth.');
  assert.equal(blockText(res.doc, 'b-p3'), 'The pathway might contribute to growth.');
  assert.equal(applyAiProposal(doc, { proposal_id: randomUUID(), quote: 'may contribute', replacement: [text('x')] }, c).code, 'HANDLE_NOT_FOUND');
});

test('TST-003B: a proposal cannot move or widen the user selection (review M1)', () => {
  const doc = buildDoc();
  const c = ctx();
  const h = select(doc, c.handles, 'b-p6', '1.2');
  const otherFrom = posOf(doc, 'b-p6', '3.4');
  for (const extra of [{ from: otherFrom, to: otherFrom + 3 }, { from: 0, to: 40 }, { block_id: 'b-p1' }]) {
    const res = applyAiProposal(doc, proposal(h, [text('1.2')], extra), c);
    assert.equal(res.code, 'HANDLE_RANGE_MISMATCH', JSON.stringify(extra));
  }
  // the slice hash is bound to the position: identical text at two positions gives different hashes
  const h2 = createSelectionHandle(doc, { blockId: 'b-p2', from: 0, to: 3 });
  const h3 = createSelectionHandle(doc, { blockId: 'b-p3', from: 0, to: 3 });
  assert.notEqual(h2.selected_slice_hash, h3.selected_slice_hash);
});

test('TST-003B: replaying an applied proposal is refused, even against the original base document', () => {
  const doc = buildDoc();
  const c = ctx();
  const h = select(doc, c.handles, 'b-p2', 'may');
  const p1 = proposal(h, [text('might')]);
  assert.equal(applyAiProposal(doc, p1, c).status, 'APPLIED');
  assert.equal(applyAiProposal(doc, p1, c).status, 'ALREADY_APPLIED');
  // a second proposal on the same handle after the first one applied: the handle is consumed
  assert.equal(applyAiProposal(doc, proposal(h, [text('could')]), c).code, 'HANDLE_CONSUMED');
});

test('TST-003B: an AI proposal cannot opt out of the guard by asking for manual mode', () => {
  const doc = buildDoc();
  const c = ctx();
  const h = select(doc, c.handles, 'b-p6', 'increased');
  const res = applyAiProposal(doc, proposal(h, [text('decreased')], { mode: 'manual', actor: 'user' }), c);
  assert.equal(res.code, 'DIRECTION_CHANGED');
});

test('TST-003B: duplicated block IDs are refused instead of guessing', () => {
  const doc = buildDoc();
  const json = doc.toJSON();
  json.content[3].attrs.id = 'b-p2';
  const dup = doc.type.schema.nodeFromJSON(json);
  assert.throws(() => createSelectionHandle(dup, { blockId: 'b-p2', from: 0, to: 3 }), (e) => e instanceof SelectionError && e.code === 'BLOCK_ID_DUPLICATE');
});

test('TST-003B: positions that split an emoji, a combining sequence or decomposed Hangul are refused', () => {
  const doc = buildDoc();
  const emoji = posOf(doc, 'b-p1', '🌱');
  assert.throws(() => createSelectionHandle(doc, { blockId: 'b-p1', from: emoji + 1, to: emoji + 2 }), (e) => e.code === 'SPLITS_SURROGATE_PAIR');
  const combining = posOf(doc, 'b-p1', 'é');
  assert.throws(() => createSelectionHandle(doc, { blockId: 'b-p1', from: combining - 3, to: combining + 1 }), (e) => e.code === 'SPLITS_GRAPHEME');
  const jamo = posOf(doc, 'b-p5', 'ᄒ');
  assert.throws(() => createSelectionHandle(doc, { blockId: 'b-p5', from: jamo, to: jamo + 1 }), (e) => e.code === 'SPLITS_GRAPHEME');
  assert.equal(createSelectionHandle(doc, { blockId: 'b-p1', from: emoji, to: emoji + 2 }).quote, '🌱');
});

test('TST-003B: out-of-range, inverted, empty and non-text selections are refused', () => {
  const doc = buildDoc();
  assert.throws(() => createSelectionHandle(doc, { blockId: 'b-p2', from: 5, to: 9999 }), (e) => e.code === 'RANGE_OUT_OF_BOUNDS');
  assert.throws(() => createSelectionHandle(doc, { blockId: 'b-p2', from: 9, to: 5 }), (e) => e.code === 'RANGE_INVERTED');
  assert.throws(() => createSelectionHandle(doc, { blockId: 'b-p2', from: 5, to: 5 }), (e) => e.code === 'EMPTY_SELECTION');
  assert.throws(() => createSelectionHandle(doc, { blockId: 'nope', from: 0, to: 1 }), (e) => e.code === 'BLOCK_NOT_FOUND');
  assert.throws(() => createSelectionHandle(doc, { blockId: 'b-t1', from: 0, to: 1 }), (e) => e.code === 'NOT_TEXTBLOCK');
});

test('TST-003B: a block edited by the user after the selection makes the AI proposal STALE', () => {
  const doc = buildDoc();
  const c = ctx();
  const h = select(doc, c.handles, 'b-p2', 'may');
  const block = doc.child(2);
  const edited = applyUserEdit(doc, { block_id: 'b-p2', expected_block_hash: blockHash(block), from: 0, to: 3, replacement: [text('This')] }).doc;
  const res = applyAiProposal(edited, proposal(h, [text('might')]), c);
  assert.equal(res.status, 'STALE');
  assert.equal(blockText(edited, 'b-p2'), 'This pathway may contribute to growth.');
});

test('TST-003B: math and figure atoms need explicit preserve_atom items (RFC-005)', () => {
  const doc = buildDoc();
  const c = ctx();
  const h = select(doc, c.handles, 'b-p4', ' with ', { endNeedle: '￼ and ' });
  assert.ok(h.atoms.some((a) => a.type === 'math_inline'));
  assert.equal(applyAiProposal(doc, proposal(h, [text(' with beta = 0.5 and ')]), c).code, 'PROTECTED_ATOM');
  const ok = applyAiProposal(doc, proposal(h, [text(' using '), { type: 'preserve_atom', atom_index: 0 }, text(' and ')]), c);
  assert.equal(ok.status, 'APPLIED');
  let latex = null;
  ok.doc.descendants((n) => { if (n.type.name === 'math_inline') latex = n.attrs.latex; });
  assert.equal(latex, '\\beta = 0.5');
});
