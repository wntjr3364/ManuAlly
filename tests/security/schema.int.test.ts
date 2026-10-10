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
});
