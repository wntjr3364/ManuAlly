// Writes the PW-003 evidence artifacts: export sample + loss report + catalogue of refused positions.
// Usage: node spikes/editor-export/run-spike.mjs <outDir>
import fs from 'node:fs';
import path from 'node:path';
import { exportDocument } from './src/export.mjs';
import { createSelectionHandle } from './src/selection.mjs';
import { buildDoc, bibliography, posOf } from '../../tests/tasks/PW-003/fixture.mjs';

const outDir = path.resolve(process.argv[2] || 'out');
const doc = buildDoc();
const { report } = exportDocument(doc, { bibliography, outDir: path.join(outDir, 'export-sample') });

const attempts = [
  ['inside emoji surrogate pair', 'b-p1', () => { const e = posOf(doc, 'b-p1', '🌱'); return [e + 1, e + 2]; }],
  ['between base letter and combining acute', 'b-p1', () => { const c = posOf(doc, 'b-p1', 'é'); return [c - 3, c + 1]; }],
  ['inside decomposed Hangul syllable', 'b-p5', () => { const j = posOf(doc, 'b-p5', 'ᄒ'); return [j, j + 1]; }],
  ['empty selection', 'b-p2', () => [5, 5]],
  ['range beyond block end', 'b-p2', () => [5, 9999]],
  ['table block (not a textblock)', 'b-t1', () => [0, 1]],
  ['unknown block id', 'b-zz', () => [0, 1]],
];
const cases = attempts.map(([name, blockId, range]) => {
  const [from, to] = range();
  try {
    createSelectionHandle(doc, { blockId, from, to });
    return { name, blockId, from, to, outcome: 'ACCEPTED_UNEXPECTEDLY' };
  } catch (e) {
    return { name, blockId, from, to, outcome: 'REFUSED', code: e.code };
  }
});
fs.writeFileSync(path.join(outDir, 'impossible-cases.json'), JSON.stringify({ note: 'positions the server refuses instead of guessing', cases }, null, 2) + '\n');
console.log(JSON.stringify({ features: report.features.map((f) => `${f.feature}:${f.status}`), refused: cases.map((c) => `${c.code || c.outcome}`) }, null, 1));
