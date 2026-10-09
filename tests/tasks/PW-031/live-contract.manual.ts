// PW-031 — LIVE contract check against the real Crossref and PubMed endpoints. MANUAL ONLY: run it on
// your machine when you want to confirm the response shapes still match (no paper data is sent: one
// fixed synthetic query). Never part of `pnpm test`.
//   node --experimental-strip-types tests/tasks/PW-031/live-contract.manual.ts --approve-network \
//     --contact you@example.org --database-url postgres://… --paper-id <id> --out reports/tasks/PW-031/live-contract.json
// The paper must be a scratch paper whose title starts with "scratch" (the search log is permanent and
// belongs to that paper). It runs one search per source through searchBibliographic (the same code the
// app uses) and records: status, reason if unavailable, number of candidates, observed time.
import fs from 'node:fs';
import pg from 'pg';
import { searchBibliographic } from '../../../packages/search/src/bibliographic/index.ts';

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
if (!argv.includes('--approve-network') || !opt('--contact') || !opt('--database-url') || !opt('--out') || !opt('--paper-id')) {
  console.error('not run: needs --approve-network, --contact, --database-url, --paper-id and --out (see the header)');
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: opt('--database-url') });
const { rows: [paper] } = await pool.query('SELECT p.id, p.owner_id, p.working_title FROM paper_projects p WHERE p.id = $1', [opt('--paper-id')]);
if (!paper || !/^scratch/i.test(paper.working_title)) { console.error('not run: --paper-id must name a paper whose title starts with "scratch"'); await pool.end(); process.exit(2); }
const out: Record<string, unknown> = { checked_at: new Date().toISOString() };
for (const source of ['crossref', 'pubmed'] as const) {
  const r = await searchBibliographic(pool, { paperId: paper.id, createdBy: paper.owner_id, source, query: 'Arabidopsis drought root gene expression', limit: 3, config: { contact: opt('--contact'), cacheTtlMs: 1 } });
  out[source] = r.status === 'ok' ? { status: r.status, candidates: r.candidates.length, with_doi: r.candidates.filter((c) => c.doi).length } : { status: r.status, reason: r.reason };
}
await pool.end();
fs.writeFileSync(opt('--out')!, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out));
