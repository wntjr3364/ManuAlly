// Curation suggestions and the owner's decisions (PW-033). Suggestions come from a curation run
// (apps/worker/src/curation); the only write here is the owner's decision. Accepting puts the work in
// the owner's library (PW-032) and the paper's references with the chosen use; rejecting records it.
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '../shared/db.ts';
import { ingestCandidateIn, noticesForDoi } from '../literature/index.ts';
import { enqueueJob } from '../jobs/index.ts';

export const USE_ROLES = ['scientific', 'writing', 'both'] as const;
export type UseRole = (typeof USE_ROLES)[number];

export interface CurationView {
  runs: { id: string; assessor: string; assessor_label: string | null; created_at: string; status: 'done' }[];
  assessments: {
    id: string; run_id: string; candidate_id: string; title: string; doi: string | null; year: number | null; container: string | null; role: string; topic_fit: string; article_type_fit: string;
    style_fit: string; read_depth: string; reasons: string; exclusion_reason: string | null; warnings: string[]; decision: string; decided_use_role: string | null;
  }[];
}

// the latest run of the paper and its assessments (older runs stay stored)
export async function curationView(db: Queryable, paperId: string): Promise<CurationView> {
  const runs = (await db.query<CurationView['runs'][number]>("SELECT id, assessor, assessor_label, created_at, 'done' AS status FROM curation_runs WHERE paper_id = $1 ORDER BY created_at DESC, id LIMIT 20", [paperId])).rows;
  if (!runs.length) return { runs, assessments: [] };
  const assessments = (await db.query<CurationView['assessments'][number]>(
    `SELECT a.id, a.run_id, a.candidate_id, c.title, c.doi, c.year, c.container, a.role, a.topic_fit, a.article_type_fit, a.style_fit, a.read_depth, a.reasons,
            a.exclusion_reason, a.warnings, a.decision, a.decided_use_role
     FROM curation_assessments a JOIN literature_candidates c ON c.id = a.candidate_id WHERE a.paper_id = $1 AND a.run_id = $2 ORDER BY c.rank`, [paperId, runs[0]!.id])).rows;
  return { runs, assessments };
}

export async function decideAssessment(pool: TxPool, a: { paperId: string; ownerId: string; assessmentId: string; decision: unknown; useRole?: unknown }) {
  if (!UUID_RE.test(a.assessmentId)) throw new DomainError('NOT_FOUND', 'assessment not found');
  if (a.decision !== 'accepted' && a.decision !== 'rejected') throw new DomainError('INVALID', 'decision must be accepted or rejected', 'decision');
  if (a.decision === 'accepted' && !USE_ROLES.includes(a.useRole as UseRole)) throw new DomainError('INVALID', `use_role must be one of ${USE_ROLES.join(', ')}`, 'use_role');
  // one transaction: the decision is taken (row locked, still pending) before anything reaches the
  // library, so a decision that loses a race leaves no trace
  return inTransaction(pool, async (tx) => {
    const row = (await tx.query<{ candidate_id: string; decision: string; warnings: string[]; doi: string | null }>(
      `SELECT a.candidate_id, a.decision, a.warnings, c.doi FROM curation_assessments a JOIN literature_candidates c ON c.id = a.candidate_id
       WHERE a.id = $1 AND a.paper_id = $2 FOR UPDATE OF a`, [a.assessmentId, a.paperId])).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', 'assessment not found');
    if (row.decision !== 'pending') throw new DomainError('CONFLICT', `already ${row.decision}`);
    // the work's status now, not only when the run was made: the library may have learned of a notice since
    const now = new Set((await noticesForDoi(tx, a.ownerId, row.doi)).map((n) => n.kind));
    const retracted = row.warnings.includes('retracted') || now.has('retracted');
    // a retracted work is never adopted as scientific support (it may still be kept as a writing reference)
    if (a.decision === 'accepted' && retracted && a.useRole !== 'writing') {
      throw new DomainError('INVALID', 'a retracted work cannot be adopted as scientific support', 'use_role');
    }
    await tx.query(
      "UPDATE curation_assessments SET decision = $3, decided_use_role = $4, decided_by = $5, decided_at = clock_timestamp() WHERE id = $1 AND paper_id = $2 AND decision = 'pending'",
      [a.assessmentId, a.paperId, a.decision, a.decision === 'accepted' ? a.useRole : null, a.ownerId]);
    if (a.decision !== 'accepted') return { decision: a.decision, reference_id: null, project_use_role: null, warnings: [] as string[] };
    const referenceId = (await ingestCandidateIn(tx, { ownerId: a.ownerId, candidateId: row.candidate_id })).reference_id;
    await tx.query(
      `INSERT INTO project_references (paper_id, reference_id, owner_id, use_role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (paper_id, reference_id) DO NOTHING`, [a.paperId, referenceId, a.ownerId, a.useRole]);
    // a work already in the paper keeps its use; the answer says which use the paper holds
    const projectUseRole = (await tx.query<{ use_role: string }>('SELECT use_role FROM project_references WHERE paper_id = $1 AND reference_id = $2', [a.paperId, referenceId])).rows[0]!.use_role;
    const warnings: string[] = [];
    if (retracted && projectUseRole !== 'writing') warnings.push('retracted_work_used_as_scientific');
    if (row.warnings.includes('notice_record') && projectUseRole !== 'writing') warnings.push('notice_record_used_as_scientific');
    if (now.has('correction') && !row.warnings.includes('corrected')) warnings.push('corrected');
    if (now.has('expression_of_concern') && !row.warnings.includes('expression_of_concern')) warnings.push('expression_of_concern');
    return { decision: a.decision, reference_id: referenceId, project_use_role: projectUseRole, warnings };
  });
}

// The paper's successful searches (newest first) that a curation run can look at.
export async function listSearches(db: Queryable, paperId: string) {
  return (await db.query<{ id: string; source: string; query: string; observed_at: string; candidates: number }>(
    `SELECT s.id, s.source, s.query, s.observed_at, (SELECT count(*)::int FROM literature_candidates c WHERE c.search_id = s.id) AS candidates
     FROM literature_searches s WHERE s.paper_id = $1 AND s.status = 'ok' ORDER BY s.observed_at DESC, s.id LIMIT 50`, [paperId])).rows;
}

// Asks for a curation run over the given searches (an AI job; the worker assesses).
export async function requestCuration(pool: TxPool, a: { paperId: string; ownerId: string; searchIds: unknown; idempotencyKey: unknown }) {
  if (!Array.isArray(a.searchIds) || !a.searchIds.length || a.searchIds.length > 20 || !a.searchIds.every((x) => typeof x === 'string' && UUID_RE.test(x))) {
    throw new DomainError('INVALID', 'search_ids must be 1–20 search ids', 'search_ids');
  }
  const ok = (await pool.query("SELECT count(*)::int AS n FROM literature_searches WHERE paper_id = $1 AND id = ANY($2::uuid[]) AND status = 'ok'", [a.paperId, a.searchIds])).rows[0] as { n: number };
  if (ok.n !== new Set(a.searchIds).size) throw new DomainError('NOT_FOUND', 'a search is not found in this paper');
  return enqueueJob(pool, { paperId: a.paperId, ownerId: a.ownerId, intent: 'literature_search', idempotencyKey: a.idempotencyKey, payload: { kind: 'curate', search_ids: [...new Set(a.searchIds as string[])] } });
}
