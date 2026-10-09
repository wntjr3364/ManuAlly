// Story alternatives for the owner (PW-039, spec 03 "Storyline"): request a run (an AI job), see the
// checked alternatives, and adopt one. Adopting is the owner's single decision: it creates a new DRAFT
// story revision from the alternative — the brief (the paper's purpose, audience, what to avoid) and
// the novelty stay as the user wrote them — and records what it became. Approving that draft is the
// existing, separate approval (PW-010). An alternative the system blocked (a number the evidence does
// not hold) cannot be adopted; suggested claims are never turned into claims.
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '../shared/db.ts';
import { enqueueJob } from '../jobs/index.ts';
import { createStoryRevisionIn, getStoryRevision } from '../outlines/index.ts';

export interface AlternativeEvidence { kind: 'fact' | 'claim'; id: string; role: 'supports' | 'contradicts' | 'context'; text: string }
export interface AlternativeContent {
  title: string; question: string; main_message: string; presentation_order: string[]; evidence: AlternativeEvidence[];
  competing_explanations: string[]; limitations: string[]; evidence_gaps: string[]; claim_suggestions: string[];
}

export async function requestStoryAlternatives(pool: TxPool, a: { paperId: string; ownerId: string; baseStoryRevisionId: unknown; idempotencyKey: unknown }) {
  if (typeof a.baseStoryRevisionId !== 'string' || !UUID_RE.test(a.baseStoryRevisionId)) throw new DomainError('INVALID', 'base_story_revision_id must name a story revision of this paper', 'base_story_revision_id');
  const base = await getStoryRevision(pool, a.paperId, a.baseStoryRevisionId.toLowerCase());
  if (!base) throw new DomainError('NOT_FOUND', 'story revision not found');
  if (typeof base.brief.purpose !== 'string' || !base.brief.purpose.trim()) throw new DomainError('INVALID', 'the brief needs a purpose before alternatives can be proposed', 'brief.purpose');
  return enqueueJob(pool, { paperId: a.paperId, ownerId: a.ownerId, intent: 'propose_story', idempotencyKey: a.idempotencyKey, payload: { base_story_revision_id: base.id } });
}

export async function storyAlternativesView(db: Queryable, paperId: string) {
  const runs = (await db.query<{ id: string; job_id: string; base_story_revision_id: string; generator: string; generator_label: string | null; created_at: string }>(
    'SELECT id, job_id, base_story_revision_id, generator, generator_label AS label, created_at FROM story_alternative_runs WHERE paper_id = $1 ORDER BY created_at DESC, id DESC LIMIT 10', [paperId])).rows;
  const alts = runs.length ? (await db.query<{ id: string; run_id: string; position: number; content: AlternativeContent; warnings: string[]; blocked_reasons: string[]; adopted_story_revision_id: string | null; adopted_at: string | null }>(
    'SELECT id, run_id, position, content, warnings, blocked_reasons, adopted_story_revision_id, adopted_at FROM story_alternatives WHERE paper_id = $1 AND run_id = ANY($2::uuid[]) ORDER BY position', [paperId, runs.map((r) => r.id)])).rows : [];
  return {
    runs: runs.map((r) => ({
      ...r,
      alternatives: alts.filter((x) => x.run_id === r.id).map(({ content, run_id: _run, ...x }) => ({ ...x, ...content })),
    })),
  };
}

export async function adoptStoryAlternative(pool: TxPool, a: { paperId: string; ownerId: string; alternativeId: string; body: unknown }) {
  const b = (a.body ?? {}) as Record<string, unknown>;
  if (b.intent !== 'adopt_story_alternative') throw new DomainError('INVALID', 'adopting needs the explicit intent "adopt_story_alternative"', 'intent');
  if (Object.keys(b).some((k) => !['intent', 'parent_revision_id'].includes(k))) throw new DomainError('INVALID', 'unknown fields', 'body');
  if (!UUID_RE.test(a.alternativeId)) throw new DomainError('NOT_FOUND', 'alternative not found');
  return inTransaction(pool, async (tx) => {
    const alt = (await tx.query<{ id: string; content: AlternativeContent; blocked_reasons: string[]; adopted_at: string | null; base_story_revision_id: string }>(
      `SELECT x.id, x.content, x.blocked_reasons, x.adopted_at, r.base_story_revision_id FROM story_alternatives x JOIN story_alternative_runs r ON r.id = x.run_id
       WHERE x.id = $1 AND x.paper_id = $2 FOR UPDATE OF x`, [a.alternativeId.toLowerCase(), a.paperId])).rows[0];
    if (!alt) throw new DomainError('NOT_FOUND', 'alternative not found');
    if (alt.adopted_at) throw new DomainError('CONFLICT', 'this alternative was already adopted');
    // made from an older story: adopting it would bring back that version's brief and novelty (review MINOR 2)
    if (typeof b.parent_revision_id === 'string' && b.parent_revision_id.toLowerCase() !== alt.base_story_revision_id) {
      throw new DomainError('CONFLICT', 'this alternative was made from an older story version; ask for new alternatives on the current story');
    }
    if (alt.blocked_reasons.length) throw new DomainError('INVALID', `this alternative cannot be adopted: ${alt.blocked_reasons.join(', ')} (a number its text states is not in the evidence it links or in your story)`, 'alternative');
    const base = (await getStoryRevision(tx, a.paperId, alt.base_story_revision_id))!;
    const c = alt.content;
    const story = {
      question: c.question,
      main_message: c.main_message,
      // the novelty is the user's statement; an alternative does not change it
      ...(typeof base.story.novelty === 'string' ? { novelty: base.story.novelty } : {}),
      evidence_links: c.evidence.filter((e) => e.role !== 'context').map((e) => `${e.kind}:${e.id}`),
      competing_explanations: c.competing_explanations,
      presentation_order: c.presentation_order,
      limitations: c.limitations,
    };
    const rev = await createStoryRevisionIn(tx, { paperId: a.paperId, ownerId: a.ownerId, parent: b.parent_revision_id, brief: base.brief, story });
    await tx.query('UPDATE story_alternatives SET adopted_story_revision_id = $2, adopted_by = $3, adopted_at = clock_timestamp() WHERE id = $1', [alt.id, rev.id, a.ownerId]);
    return rev;
  });
}
