// PW-059 security audit (review M1): cross-paper references are refused by the database, not only by route
// code. A foreign key between two paper-scoped tables must carry paper_id on both sides — then no write,
// through any route or worker, can make one paper's record point at another paper's. The keys that do not
// are listed below with the reason they are safe and where that is shown; the list must stay exact.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import { createTempDatabase } from '../../packages/config/src/test-db.ts';
import { migrate } from '../../apps/api/src/db/migrate.ts';

const JOB = 'written only by the worker for the job it runs (the job carries its paper; nothing in the request names it)';
const SIBLING = 'the same row also references the parent with paper_id (composite key), which fixes the paper';
// array columns holding ids of other records: who writes them, and where the paper is checked
const ID_ARRAYS: Record<string, string> = {
  'outline_nodes.claim_ids': 'request (outline save): a record id must be a claim of this paper — createOutlineRevision (F-05); sweep.int.test.ts "outline node claim ids"',
  'outline_nodes.evidence_ids': 'request (outline save): a record id must be an evidence record of this paper — createOutlineRevision (F-05); sweep.int.test.ts "outline node evidence ids"',
  'agent_run_tokens.handle_ids': 'worker (run token issue): every handle must be a selection handle of the token\'s paper and document — issueRunToken (PW-027)',
  'curation_runs.search_ids': 'request → job payload: the worker stores the run only when every search is this paper\'s — curation loadInput; sweep.int.test.ts "curation runs"',
  'paragraph_proposals.claim_ids': 'worker: only ids in the paragraph contract (contracts/writing "claim_not_in_contract"), which is read with the paper filter (nodeScope)',
  'paragraph_proposals.fact_ids': 'worker: only ids in the paragraph contract (contracts/writing), read with the paper filter (nodeScope)',
  'review_repairs.finding_ids': 'server: the accepted findings of this paper\'s review run (the repair request names no finding) — scientific-review requestRepair',
};
const NOT_IDS: Record<string, string> = {
  'agent_run_tokens.tools': 'gateway tool names',
  'curation_assessments.warnings': 'message codes',
  'figure_review_flags.reasons': 'reason codes',
  'outline_nodes.exclusions': 'the owner\'s text (prohibited inferences)',
  'paper_projects.allowed_providers': 'provider names',
  'paragraph_proposals.warnings': 'message codes',
  'pdf_pages.flags': 'parser flags',
  'pdf_pages.view_box': 'page geometry (numbers)',
  'reference_import_items.warnings': 'message codes',
  'review_findings.warnings': 'message codes',
  'story_alternatives.blocked_reasons': 'reason codes',
  'story_alternatives.warnings': 'message codes',
  'usage_events.unknown_fields': 'names of fields the provider did not report',
};
const EXCEPTIONS: Record<string, string> = {
  'agent_run_tokens(job_id)->jobs(id)': `${JOB}; tool calls are scoped by the token's paper (PW-027, tests/security/injection.int.test.ts)`,
  'curation_runs(job_id)->jobs(id)': JOB,
  'paragraph_proposals(job_id)->jobs(id)': JOB,
  'pdf_extractions(job_id)->jobs(id)': JOB,
  'review_repairs(job_id)->jobs(id)': JOB,
  'review_runs(job_id)->jobs(id)': JOB,
  'story_alternative_runs(job_id)->jobs(id)': JOB,
  'usage_events(job_id)->jobs(id)': JOB,
  'writing_profile_runs(job_id)->jobs(id)': JOB,
  'context_switches(checkpoint_id)->job_checkpoints(id)': `${JOB} (checkpoint of the same job)`,
  'outline_impact_resolutions(outline_revision_id,node_id)->outline_nodes(outline_revision_id,node_id)': SIBLING,
  'outline_node_approvals(outline_revision_id,content_hash)->outline_revisions(id,content_hash)': SIBLING,
  'outline_node_approvals(outline_revision_id,node_id)->outline_nodes(outline_revision_id,node_id)': SIBLING,
  'outline_node_paragraphs(outline_revision_id,node_id)->outline_nodes(outline_revision_id,node_id)': SIBLING,
  'outline_nodes(outline_revision_id,parent_node_id)->outline_nodes(outline_revision_id,node_id)': SIBLING,
  'paragraph_proposals(outline_revision_id,node_id)->outline_nodes(outline_revision_id,node_id)': SIBLING,
  'pdf_anchors(extraction_id,asset_revision_id)->pdf_extractions(id,asset_revision_id)': SIBLING,
  'literature_candidates(search_id)->literature_searches(id)': 'written by the search for its own paper only',
  'curation_assessments(candidate_id)->literature_candidates(id)': `${JOB}; the run's searches are checked to be the paper's (tests/security/sweep.int.test.ts targeted, curation)`,
  'paragraph_proposals(applied_revision_id)->document_revisions(id)': 'set by apply to the revision it made in the proposal\'s own document (FK with paper_id on document_id/base_revision_id)',
  'story_alternatives(adopted_story_revision_id)->story_revisions(id)': 'set by adopt to the story revision it made in the same paper',
  'review_runs(revision_id)->document_revisions(id)': 'request-provided; checked against the paper\'s document (tests/security/sweep.int.test.ts targeted, review)',
  'scientific_check_runs(revision_id)->document_revisions(id)': 'request-provided; checked against the paper\'s document (tests/security/sweep.int.test.ts targeted, scientific check)',
  'story_alternative_runs(base_story_revision_id)->story_revisions(id)': 'request-provided; must be the paper\'s approved story (tests/security/sweep.int.test.ts targeted, story alternatives)',
  'writing_profile_revisions(parent_revision_id)->writing_profile_revisions(id)': 'request-provided; must equal the paper\'s latest profile revision (packages/domain/src/writing-profile, CONFLICT otherwise)',
};

let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 2 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
});
afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('TST-059A: the database refuses cross-paper references', () => {
  test('every key between paper-scoped tables carries paper_id, or is a reviewed exception', async () => {
    const { rows } = await pool.query<{ src: string; dst: string; cols: string[]; refcols: string[] }>(`
      SELECT src.relname AS src, dst.relname AS dst,
        (SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, n) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols,
        (SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, n) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS refcols
      FROM pg_constraint con JOIN pg_class src ON src.oid = con.conrelid JOIN pg_class dst ON dst.oid = con.confrelid
      WHERE con.contype = 'f' AND dst.relname <> 'paper_projects'
        AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = con.conrelid AND attname = 'paper_id' AND NOT attisdropped)
        AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = con.confrelid AND attname = 'paper_id' AND NOT attisdropped)`);
    expect(rows.length).toBeGreaterThan(80);
    const unscoped = rows.filter((r) => !(r.cols.includes('paper_id') && r.refcols.includes('paper_id'))).map((r) => `${r.src}(${r.cols.join(',')})->${r.dst}(${r.refcols.join(',')})`).sort();
    expect(unscoped.filter((k) => !EXCEPTIONS[k]), 'a new key without paper_id: add paper_id, or review it here').toEqual([]);
    expect(Object.keys(EXCEPTIONS).filter((k) => !unscoped.includes(k)).sort(), 'an exception that no longer exists: remove it').toEqual([]);
  });

  // re-review M1': ids kept in array columns have no foreign key; each is listed with who writes it and where
  // the paper is checked (and the test that shows it). Arrays that hold no record ids are listed as such.
  test('every array column is a reviewed id list (with its paper check) or holds no record ids', async () => {
    const { rows } = await pool.query<{ k: string }>(`SELECT c.table_name || '.' || c.column_name AS k FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.data_type = 'ARRAY' ORDER BY 1`);
    const cols = rows.map((r) => r.k);
    const classified = { ...ID_ARRAYS, ...NOT_IDS };
    expect(cols.filter((k) => !classified[k]), 'a new array column: list it in ID_ARRAYS (with its paper check) or NOT_IDS').toEqual([]);
    expect(Object.keys(classified).filter((k) => !cols.includes(k)).sort(), 'a listed column that no longer exists: remove it').toEqual([]);
  });
});

