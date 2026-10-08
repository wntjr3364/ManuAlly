// PW-003 — TST-003A / TST-003B
// Run: node --test 'tests/tasks/PW-003/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSelectionHandle, applyReplaceSelection, blockText, SelectionError } from '../../../spikes/editor-export/src/selection.mjs';
import { exportDocument } from '../../../spikes/editor-export/src/export.mjs';
import { buildDoc, posOf, bibliography, REF_A, REF_B } from './fixture.mjs';

const op = (handle, replacement) => ({ type: 'replace_selection', ...handle, replacement });
const citationsIn = (doc, blockId) => {
  const out = [];
  doc.forEach((n) => { if (n.attrs.id === blockId) n.descendants((c) => { if (c.type.name === 'citation') out.push(c.attrs.referenceId); }); });
  return out;
};

// ---------- TST-003A: preservation + export ----------

test('TST-003A: replacing a selection keeps everything outside it, including the citation atom', () => {
  const doc = buildDoc();
  const from = posOf(doc, 'b-p1', 'under stress');
  const to = posOf(doc, 'b-p1', 'under stress', { after: true });
  const handle = createSelectionHandle(doc, { blockId: 'b-p1', from, to });
  assert.equal(handle.quote, 'under stress');
  const before = blockText(doc, 'b-p1');
  const res = applyReplaceSelection(doc, op(handle, [{ type: 'text', text: 'during drought' }]));
  assert.equal(res.status, 'APPLIED');
  assert.equal(blockText(res.doc, 'b-p1'), before.replace('under stress', 'during drought'));
  assert.deepEqual(citationsIn(res.doc, 'b-p1'), [REF_A]);
  // other blocks are byte-identical
  for (const id of ['b-p2', 'b-p3', 'b-p4', 'b-p5']) assert.equal(blockText(res.doc, id), blockText(doc, id));
  // original document object is untouched (immutable revisions)
  assert.equal(blockText(doc, 'b-p1'), before);
});

test('TST-003A: a selection spanning a citation must keep the same citation in conservative mode', () => {
  const doc = buildDoc();
  const from = posOf(doc, 'b-p1', 'was stable');
  const to = posOf(doc, 'b-p1', '. 한국어', { after: false }) + 1;
  const handle = createSelectionHandle(doc, { blockId: 'b-p1', from, to });
  assert.deepEqual(handle.atoms, [{ type: 'citation', referenceId: REF_A }]);
  const dropped = applyReplaceSelection(doc, op(handle, [{ type: 'text', text: 'remained stable.' }]));
  assert.equal(dropped.status, 'REJECTED');
  assert.equal(dropped.code, 'CITATION_CHANGED');
  const kept = applyReplaceSelection(doc, op(handle, [{ type: 'text', text: 'remained stable ' }, { type: 'citation', reference_id: REF_A, locator: null }, { type: 'text', text: '.' }]));
  assert.equal(kept.status, 'APPLIED');
  assert.deepEqual(citationsIn(kept.doc, 'b-p1'), [REF_A]);
});

test('TST-003A: numbers inside the selection cannot change in conservative mode', () => {
  const doc = buildDoc();
  const from = posOf(doc, 'b-p1', 'increased');
  const to = posOf(doc, 'b-p1', '(n = 6)', { after: true });
  const handle = createSelectionHandle(doc, { blockId: 'b-p1', from, to });
  const res = applyReplaceSelection(doc, op(handle, [{ type: 'text', text: 'rose 3-fold (n = 8)' }]));
  assert.equal(res.status, 'REJECTED');
  assert.equal(res.code, 'NUMBERS_CHANGED');
  const ok = applyReplaceSelection(doc, op(handle, [{ type: 'text', text: 'rose 2.4-fold (n = 6)' }]));
  assert.equal(ok.status, 'APPLIED');
});

test('TST-003A: export produces DOCX + HTML preview + loss report with the expected features', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pw003-'));
  const result = exportDocument(buildDoc(), { bibliography, outDir: out });
  for (const f of ['manuscript.docx', 'preview.html', 'loss-report.json', 'pandoc-input.json']) assert.ok(fs.existsSync(path.join(out, f)), f);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'loss-report.json'), 'utf8'));
  assert.equal(report.pandoc_version.startsWith('pandoc '), true);
  const byFeature = Object.fromEntries(report.features.map((f) => [f.feature, f]));
  for (const f of ['korean_text', 'emoji', 'greek', 'combining_marks', 'italic', 'subscript', 'superscript', 'table', 'inline_math', 'bibliography']) {
    assert.equal(byFeature[f]?.status, 'preserved', `${f}: ${JSON.stringify(byFeature[f])}`);
  }
  // citations become formatted text, not live Word/Zotero fields — reported, not hidden
  assert.equal(byFeature.citation_live_field.status, 'lost');
  assert.equal(byFeature.citation_rendered_text.status, 'preserved');
  assert.equal(byFeature.block_ids.status, 'lost');
  assert.ok(result.docxPath.endsWith('manuscript.docx'));
});

// ---------- TST-003B: ambiguous positions are refused ----------

test('TST-003B: identical sentences in two blocks — only the addressed block changes, never by text search', () => {
  const doc = buildDoc();
  const from = posOf(doc, 'b-p3', 'may contribute');
  const to = posOf(doc, 'b-p3', 'may contribute', { after: true });
  const handle = createSelectionHandle(doc, { blockId: 'b-p3', from, to });
  const res = applyReplaceSelection(doc, op(handle, [{ type: 'text', text: 'might contribute' }]));
  assert.equal(res.status, 'APPLIED');
  assert.equal(blockText(res.doc, 'b-p2'), 'The pathway may contribute to growth.');
  assert.equal(blockText(res.doc, 'b-p3'), 'The pathway might contribute to growth.');
  // an operation that only carries the quote is refused
  const quoteOnly = { type: 'replace_selection', quote: 'may contribute', replacement: [{ type: 'text', text: 'x' }] };
  assert.equal(applyReplaceSelection(doc, quoteOnly).code, 'BLOCK_ID_MISSING');
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
  // selecting the whole emoji is fine and its PM size is 2 (UTF-16 units)
  const h = createSelectionHandle(doc, { blockId: 'b-p1', from: emoji, to: emoji + 2 });
  assert.equal(h.quote, '🌱');
});

test('TST-003B: out-of-range, inverted and empty selections are refused', () => {
  const doc = buildDoc();
  assert.throws(() => createSelectionHandle(doc, { blockId: 'b-p2', from: 5, to: 9999 }), (e) => e.code === 'RANGE_OUT_OF_BOUNDS');
  assert.throws(() => createSelectionHandle(doc, { blockId: 'b-p2', from: 9, to: 5 }), (e) => e.code === 'RANGE_INVERTED');
  assert.throws(() => createSelectionHandle(doc, { blockId: 'b-p2', from: 5, to: 5 }), (e) => e.code === 'EMPTY_SELECTION');
  assert.throws(() => createSelectionHandle(doc, { blockId: 'nope', from: 0, to: 1 }), (e) => e.code === 'BLOCK_NOT_FOUND');
  assert.throws(() => createSelectionHandle(doc, { blockId: 'b-t1', from: 0, to: 1 }), (e) => e.code === 'NOT_TEXTBLOCK');
});

test('TST-003B: a block edited after the selection was taken makes the proposal STALE', () => {
  const doc = buildDoc();
  const from = posOf(doc, 'b-p2', 'may');
  const handle = createSelectionHandle(doc, { blockId: 'b-p2', from, to: from + 3 });
  const userEdit = createSelectionHandle(doc, { blockId: 'b-p2', from: 0, to: 3 });
  const edited = applyReplaceSelection(doc, op(userEdit, [{ type: 'text', text: 'This' }]), { mode: 'manual' }).doc;
  const res = applyReplaceSelection(edited, op(handle, [{ type: 'text', text: 'might' }]));
  assert.equal(res.status, 'STALE');
  assert.equal(blockText(edited, 'b-p2'), 'This pathway may contribute to growth.');
});

test('TST-003B: tampered slice hash is refused', () => {
  const doc = buildDoc();
  const handle = createSelectionHandle(doc, { blockId: 'b-p2', from: 4, to: 11 });
  const res = applyReplaceSelection(doc, op({ ...handle, from: 5 }, [{ type: 'text', text: 'x' }]));
  assert.equal(res.status, 'REJECTED');
  assert.equal(res.code, 'SLICE_HASH_MISMATCH');
});

test('TST-003B: math atoms cannot be rewritten through the text-only replacement contract', () => {
  const doc = buildDoc();
  const from = posOf(doc, 'b-p4', ' with ');
  // the math atom is the first atom (U+FFFC) in b-p4; select " with <math> and "
  const to = posOf(doc, 'b-p4', '\uFFFC and ', { after: true });
  const handle = createSelectionHandle(doc, { blockId: 'b-p4', from, to });
  assert.ok(handle.atoms.some((a) => a.type === 'math_inline'));
  const res = applyReplaceSelection(doc, op(handle, [{ type: 'text', text: ' with beta = 0.5 and ' }]));
  assert.equal(res.status, 'REJECTED');
  assert.equal(res.code, 'PROTECTED_ATOM');
});
