// PW-045 — writes the hard-case results and the release-quality decision as evidence.
// node --experimental-strip-types tests/scientific/report.ts reports/tasks/PW-045/hard-cases.json
import fs from 'node:fs';
import path from 'node:path';
import { runSuite } from './runner.ts';
import { releaseQuality, validateRubric } from './quality.ts';

const out = process.argv[2];
if (!out) { console.error('usage: report.ts <output.json>'); process.exit(2); }
const suite = runSuite();
const rubric = JSON.parse(fs.readFileSync(path.resolve('evals/human-rubric.results.json'), 'utf8'));
const report = { generated_by: 'tests/scientific/report.ts', suite, human_rubric: { file: 'evals/human-rubric.results.json', status: rubric.status, reason: rubric.reason ?? null, ...validateRubric(rubric) }, release_quality: releaseQuality(suite, rubric) };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ summary: suite.summary, release_quality: report.release_quality.outcome }));
