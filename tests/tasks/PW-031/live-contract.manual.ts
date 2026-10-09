// PW-031 — LIVE contract check against the real Crossref and PubMed endpoints. MANUAL ONLY: run it on
// your machine when you want to confirm the response shapes still match (no paper data is sent: one
// fixed synthetic query). Never part of `pnpm test`.
//   node --experimental-strip-types tests/tasks/PW-031/live-contract.manual.ts --approve-network \
//     --contact you@example.org --database-url postgres://… --out reports/tasks/PW-031/live-contract.json
// It runs one search per source through searchBibliographic (the same code the app uses) on a scratch
// paper and records: status, reason if unavailable, API version, number of candidates, observed time.
import fs from 'node:fs';
import pg from 'pg';
import { searchBibliographic } from '../../../packages/search/src/bibliographic/index.ts';

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
if (!argv.includes('--approve-network') || !opt('--contact') || !opt('--database-url') || !opt('--out')) {
  console.error('not run: needs --approve-network, --contact, --database-url and --out (see the header)');
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: opt('--database-url') });
const { rows: [paper] } = await pool.query('SELECT p.id, p.owner_id FROM paper_projects p ORDER BY created_at LIMIT 1');
if (!paper) { console.error('not run: create a scratch paper first'); process.exit(2); }
const out: Record<string, unknown> = { checked_at: new Date().toISOString() };
for (const source of ['crossref', 'pubmed'] as const) {
  const r = await searchBibliographic(pool, { paperId: paper.id, createdBy: paper.owner_id, source, query: 'Arabidopsis drought root gene expression', limit: 3, config: { contact: opt('--contact'), cacheTtlMs: 1 } });
  out[source] = r.status === 'ok' ? { status: r.status, candidates: r.candidates.length, with_doi: r.candidates.filter((c) => c.doi).length } : { status: r.status, reason: r.reason };
}
await pool.end();
fs.writeFileSync(opt('--out')!, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out));
