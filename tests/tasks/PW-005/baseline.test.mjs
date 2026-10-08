// PW-005 — TST-005A / TST-005B
// Run: node --test 'tests/tasks/PW-005/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBaseline, validateBaseline, REQUIRED_CATEGORIES } from '../../../spikes/writing-baseline/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('TST-005A: the shipped baseline is internally consistent', () => {
  const baseline = loadBaseline();
  assert.deepEqual(validateBaseline(baseline), []);
});

test('TST-005A: every required category has expected outcomes, including both pass and fail examples', () => {
  const { cases } = loadBaseline();
  for (const cat of REQUIRED_CATEGORIES) {
    const inCat = cases.filter((c) => c.category === cat);
    assert.ok(inCat.length >= 2, `${cat} needs at least 2 cases`);
    assert.ok(inCat.some((c) => c.expected === 'ALLOW'), `${cat} needs an ALLOW example`);
    assert.ok(inCat.some((c) => c.expected !== 'ALLOW'), `${cat} needs a failing example`);
    for (const c of inCat) assert.ok(c.reason && c.outline_node_id, c.id);
  }
});

test('TST-005A: two article types are covered and the rubric/procedure documents exist', () => {
  const { papers } = loadBaseline();
  assert.deepEqual(papers.map((p) => p.article_type).sort(), ['research_article', 'software_resource']);
  assert.notDeepEqual(papers[0].outline.sections, papers[1].outline.sections, 'software paper must not be forced into the same IMRaD outline');
  for (const f of ['evals/HUMAN_RUBRIC.md', 'spikes/writing-baseline/COLLECTION_PROCEDURE.md']) assert.ok(fs.existsSync(path.join(root, f)), f);
  const proc = fs.readFileSync(path.join(root, 'spikes/writing-baseline/COLLECTION_PROCEDURE.md'), 'utf8');
  for (const term of ['held-out', '외부 전송', '동의', 'blind']) assert.ok(proc.includes(term), term);
});

test('TST-005A: every designed SCI case is mapped to a baseline category', () => {
  const { sciMap } = loadBaseline();
  const sci = JSON.parse(fs.readFileSync(path.join(root, 'evals/SCIENTIFIC_CASES.json'), 'utf8')).cases.map((c) => c.id);
  assert.deepEqual(Object.keys(sciMap).sort(), sci.sort());
  for (const cat of Object.values(sciMap)) assert.ok(REQUIRED_CATEGORIES.includes(cat) || cat === 'other', cat);
});

test('TST-005B: an abstract-only reference cannot carry fulltext_style_verified', () => {
  const b = loadBaseline();
  const ref = b.papers[0].references.find((r) => r.source_depth === 'ABSTRACT_ONLY');
  ref.style_verification = 'fulltext_style_verified';
  assert.ok(validateBaseline(b).some((e) => e.includes(ref.id) && e.includes('style')));
});

test('TST-005B: style verification of a section requires that exact section to have been read', () => {
  const b = loadBaseline();
  const ref = b.papers[0].references.find((r) => r.style_verification === 'fulltext_style_verified');
  ref.style_sections = [...ref.style_sections, 'Discussion'];
  ref.sections_read = ref.sections_read.filter((s) => s !== 'Discussion');
  assert.ok(validateBaseline(b).some((e) => e.includes(ref.id) && e.includes('Discussion')));
});

test('TST-005B: a gold (ALLOW) paragraph may not contain results that are not in the fact records', () => {
  const b = loadBaseline();
  const gold = b.cases.find((c) => c.expected === 'ALLOW' && c.paper_id === b.papers[0].id && c.category === 'numbers');
  gold.text = gold.text.replace(/2\.4/, '3.1');
  assert.ok(validateBaseline(b).some((e) => e.includes(gold.id) && e.includes('3.1')));
});

test('TST-005B: gold paragraphs may not cite references or facts that do not exist, or unverified facts', () => {
  const b = loadBaseline();
  const gold = b.cases.find((c) => c.expected === 'ALLOW' && c.category === 'citation');
  gold.text += ' [@ref-does-not-exist]';
  gold.fact_ids = [...gold.fact_ids, 'fact-missing'];
  const errors = validateBaseline(b);
  assert.ok(errors.some((e) => e.includes('ref-does-not-exist')));
  assert.ok(errors.some((e) => e.includes('fact-missing')));
  const b2 = loadBaseline();
  b2.papers[0].facts[0].verification_state = 'candidate';
  assert.ok(validateBaseline(b2).some((e) => e.includes(b2.papers[0].facts[0].id) && e.includes('verified')));
});

test('TST-005B: fixtures must be marked synthetic', () => {
  const b = loadBaseline();
  b.papers[1].synthetic = false;
  assert.ok(validateBaseline(b).some((e) => e.includes('synthetic')));
});
