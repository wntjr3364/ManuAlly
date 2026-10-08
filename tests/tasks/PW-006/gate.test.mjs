// PW-006 — TST-006A / TST-006B
// Run: node --test 'tests/tasks/PW-006/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const recordPath = 'docs/adr/P00_DECISION_RECORD.md';

test('TST-006A: the P00 decision record has every required part', () => {
  const doc = read(recordPath);
  for (const heading of ['## 1. Compatibility matrix', '## 2. ADR', '## 3. RFC', '## 4. Version pin', '## 5. Go / No-go', '## 6. 사용자 승인']) {
    assert.ok(doc.includes(heading), heading);
  }
  for (const lib of ['prosemirror-model', '@tiptap/core', 'fastify', 'pg-boss', 'PostgreSQL', 'pandoc', 'claude-code', 'codex']) assert.ok(doc.includes(lib), lib);
  assert.match(doc, /License/);
});

test('TST-006A: every RFC follows the template and has a status', () => {
  const dir = path.join(root, 'docs/adr/rfc');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 4);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const field of ['Status:', 'Trigger task:', 'Problem and evidence:', 'Proposed change:', 'Alternatives considered:', 'Tests and acceptance criteria:', 'User decision / reviewer:']) {
      assert.ok(text.includes(field), `${f}: ${field}`);
    }
    assert.match(text, /Status: (proposed|accepted|accepted \(delegated\)|rejected)/, f);
  }
});

test('TST-006B: nothing unverified is reported as verified', () => {
  const registry = JSON.parse(read('spikes/provider-admission/registry.json'));
  for (const e of registry.entries) {
    if (e.capability.provider === 'mock') continue;
    assert.notEqual(e.capability.admission, 'approved');
    assert.ok(!Object.values(e.capability.features).includes('verified'));
  }
  const doc = read(recordPath);
  assert.ok(!/\|\s*(claude|codex)[^|\n]*\|\s*verified\s*\|/i.test(doc), 'matrix must not mark a provider verified');
  assert.match(doc, /CONDITIONAL GO/);
});

test('TST-006B: no product scaffold exists unless the P00 gate approval is recorded', () => {
  const approved = /상태: \*\*승인됨\*\*/.test(read(recordPath)) && /사용자 승인 2026-/.test(read('reports/phases/P00_GATE.md'));
  if (approved) return; // P01 scaffold (PW-007) is allowed after the recorded user approval
  for (const d of ['apps', 'packages', 'db', 'infra']) assert.equal(fs.existsSync(path.join(root, d)), false, `${d}/ must not exist before P01 approval`);
  for (const f of ['package.json', 'pnpm-workspace.yaml']) assert.equal(fs.existsSync(path.join(root, f)), false, f);
});
