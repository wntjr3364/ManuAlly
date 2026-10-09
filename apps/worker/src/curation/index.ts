// Literature curation runs (PW-033, spec 05 "논문을 AI가 선정하는 방식", 06).
// An assessor (a provider, or the MOCK one) looks at a paper's brief and its search candidates and
// suggests, per candidate: a use (scientific / writing / both / exclude), topic and article-type fit,
// style fit, reasons and — when excluded — why. The run's answer is checked strictly and then made
// safe by system rules the assessor cannot override:
// - read depth is what the system knows (search candidates: METADATA_ONLY), never the assessor's claim;
// - writing style needs the text: without a full text the style fit is "unknown" (a citation count or a
//   journal name is not evidence of good writing);
// - a retracted work is never suggested as scientific support;
// - an answer that names unknown candidates, misses one, uses unknown values or carries extra fields
//   fails the run; nothing partial is stored.
// Suggestions are stored under the job's fencing token; adopting one is the owner's decision (API).
import { createHash } from 'node:crypto';
import { UUID_RE, type Queryable, type TxPool } from '@pw/domain/shared/db.ts';
import type { Job } from '@pw/domain/jobs/index.ts';
import { getStory } from '@pw/domain/outlines/index.ts';
import { JobOutcomeError, type JobHandler } from '../queue/index.ts';

export interface CandidateInput {
  id: string; title: string; authors: { family: string; given?: string }[]; year: number | null; container: string | null; work_type: string | null;
  is_preprint: boolean; update_notice: { type: string } | null; read_depth: ReadDepth;
}
export interface AssessorInput { brief: { purpose: string; audience: string | null }; question: string | null; main_message: string | null; candidates: CandidateInput[] }
export interface CurationAssessor { id: 'mock' | 'claude_agent' | 'codex'; label: string | null; assess(input: AssessorInput): Promise<unknown> }

const ROLES = ['scientific', 'writing', 'both', 'exclude'] as const;
const FITS = ['high', 'medium', 'low', 'unknown'] as const;
const STYLES = ['good', 'fair', 'poor', 'unknown'] as const;
type ReadDepth = 'METADATA_ONLY' | 'ABSTRACT_ONLY' | 'FULLTEXT_PARTIAL' | 'FULLTEXT_PARSED' | 'SOURCE_CHECKED';
const STYLE_NEEDS: ReadDepth[] = ['FULLTEXT_PARTIAL', 'FULLTEXT_PARSED', 'SOURCE_CHECKED'];
const KEYS = ['candidate_id', 'role', 'topic_fit', 'article_type_fit', 'style_fit', 'reasons', 'exclusion_reason'];
const RETRACTED = ['retracted_publication', 'retraction'];

export interface Assessment {
  candidate_id: string; role: (typeof ROLES)[number]; topic_fit: (typeof FITS)[number]; article_type_fit: (typeof FITS)[number]; style_fit: (typeof STYLES)[number];
  read_depth: ReadDepth; reasons: string; exclusion_reason: string | null; warnings: string[];
}

class Rejected extends Error {}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T => { if (!list.includes(v as T)) throw new Rejected(`${what} must be one of ${list.join(', ')}`); return v as T; };

// strict check of the assessor's answer, then the system rules
export function checkAssessments(raw: unknown, input: AssessorInput): Assessment[] {
  if (!obj(raw) || Object.keys(raw).some((k) => k !== 'assessments') || !Array.isArray(raw.assessments)) throw new Rejected('the answer must be { assessments: [...] }');
  const byId = new Map(input.candidates.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const out = raw.assessments.map((x, i) => {
    if (!obj(x)) throw new Rejected(`assessment ${i} is not an object`);
    const extra = Object.keys(x).filter((k) => !KEYS.includes(k));
    if (extra.length) throw new Rejected(`assessment ${i} has fields that are not allowed: ${extra.join(', ').slice(0, 100)}`);
    const id = String(x.candidate_id);
    const cand = byId.get(id);
    if (!cand) throw new Rejected(`assessment ${i} names a candidate that is not in this run`);
    if (seen.has(id)) throw new Rejected(`candidate ${id} is assessed twice`);
    seen.add(id);
    let role = oneOf(x.role, ROLES, `assessment ${i} role`);
    const topic = oneOf(x.topic_fit, FITS, `assessment ${i} topic_fit`);
    const type = oneOf(x.article_type_fit, FITS, `assessment ${i} article_type_fit`);
    let style = oneOf(x.style_fit, STYLES, `assessment ${i} style_fit`);
    if (typeof x.reasons !== 'string' || x.reasons.trim().length < 5 || x.reasons.length > 1000) throw new Rejected(`assessment ${i} needs reasons (5–1000 characters)`);
    let exclusion: string | null = x.exclusion_reason === undefined || x.exclusion_reason === null ? null : String(x.exclusion_reason);
    if (exclusion !== null && (exclusion.trim().length < 3 || exclusion.length > 500)) throw new Rejected(`assessment ${i} exclusion_reason must be 3–500 characters`);
    if (role === 'exclude' && !exclusion) throw new Rejected(`assessment ${i} excludes without saying why`);
    const warnings: string[] = [];
    // system rules
    if (!STYLE_NEEDS.includes(cand.read_depth) && style !== 'unknown') { style = 'unknown'; warnings.push('style_needs_full_text'); }
    if (cand.update_notice && RETRACTED.includes(cand.update_notice.type)) {
      warnings.push('retracted');
      if (role !== 'exclude') { role = 'exclude'; exclusion = '철회된 논문 — 과학적 근거로 쓰지 않음'; warnings.push('role_overridden'); }
    }
    if (cand.is_preprint) warnings.push('preprint');
    return { candidate_id: id, role, topic_fit: topic, article_type_fit: type, style_fit: style, read_depth: cand.read_depth, reasons: x.reasons.trim(), exclusion_reason: role === 'exclude' ? exclusion : null, warnings };
  });
  if (seen.size !== input.candidates.length) throw new Rejected('the answer does not assess every candidate');
  return out;
}

// Deterministic stand-in (labelled MOCK): word overlap with the brief decides topic fit; it also makes
// the classic mistake of calling a "highly cited" work well written, which the system rules undo.
export function createMockAssessor(): CurationAssessor {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  return {
    id: 'mock',
    label: 'MOCK',
    async assess(input) {
      const brief = words(`${input.brief.purpose} ${input.question ?? ''} ${input.main_message ?? ''}`);
      return {
        assessments: input.candidates.map((c) => {
          const overlap = [...words(c.title)].filter((w) => brief.has(w)).length;
          const topic = overlap >= 2 ? 'high' : overlap === 1 ? 'medium' : 'low';
          const cited = /highly cited/i.test(c.title);
          const role = topic === 'low' ? 'exclude' : cited ? 'writing' : 'scientific';
          return {
            candidate_id: c.id, role, topic_fit: topic, article_type_fit: c.work_type === 'journal-article' ? 'high' : 'medium',
            style_fit: cited ? 'good' : 'unknown',
            reasons: `[MOCK] 제목이 개요 목적과 겹치는 낱말 ${overlap}개${cited ? '; 인용이 많음' : ''}`,
            ...(role === 'exclude' ? { exclusion_reason: '[MOCK] 연구 주제와 관련이 낮음' } : {}),
          };
        }),
      };
    },
  };
}

const PAYLOAD_KEYS = ['kind', 'search_ids'];
async function loadInput(db: Queryable, job: Job): Promise<{ input: AssessorInput; searchIds: string[]; briefHash: string }> {
  const p = job.payload as { kind?: unknown; search_ids?: unknown };
  if (p.kind !== 'curate' || Object.keys(p).some((k) => !PAYLOAD_KEYS.includes(k)) || !Array.isArray(p.search_ids) || !p.search_ids.length || p.search_ids.length > 20 || !p.search_ids.every((x) => typeof x === 'string' && UUID_RE.test(x))) {
    throw new JobOutcomeError('curation payload must be { kind: "curate", search_ids: [1–20 ids] }', 'FAILED');
  }
  const searchIds = [...new Set(p.search_ids as string[])];
  const ok = (await db.query<{ id: string }>("SELECT id FROM literature_searches WHERE paper_id = $1 AND id = ANY($2::uuid[]) AND status = 'ok'", [job.paper_id, searchIds])).rows;
  if (ok.length !== searchIds.length) throw new JobOutcomeError('a search is not this paper\'s or did not succeed', 'FAILED');
  const story = await getStory(db, job.paper_id);
  const s = story.active ?? story.latest;
  if (!s || typeof s.brief.purpose !== 'string') throw new JobOutcomeError('curation needs the paper brief (purpose) first', 'WAITING_USER');
  const cands = (await db.query<Omit<CandidateInput, 'read_depth'>>(
    `SELECT DISTINCT ON (coalesce(c.doi, c.source || ':' || c.source_record_id)) c.id, c.title, c.authors, c.year, c.container, c.work_type, c.is_preprint, c.update_notice
     FROM literature_candidates c WHERE c.paper_id = $1 AND c.search_id = ANY($2::uuid[]) ORDER BY coalesce(c.doi, c.source || ':' || c.source_record_id), c.rank LIMIT 100`, [job.paper_id, searchIds])).rows;
  const input: AssessorInput = {
    brief: { purpose: s.brief.purpose as string, audience: typeof s.brief.audience === 'string' ? s.brief.audience : null },
    question: typeof s.story.question === 'string' ? s.story.question : null,
    main_message: typeof s.story.main_message === 'string' ? s.story.main_message : null,
    // search candidates are metadata only: nothing has been read yet (PDF/full text arrives in PW-034/035)
    candidates: cands.map((c) => ({ ...c, read_depth: 'METADATA_ONLY' as const })),
  };
  return { input, searchIds, briefHash: createHash('sha256').update(JSON.stringify(input.brief) + (input.question ?? '') + (input.main_message ?? '')).digest('hex') };
}

export function curationHandlers(pool: TxPool, assessor: CurationAssessor): Record<'literature_search', JobHandler> {
  const curate: JobHandler = async (job) => {
    const { input, searchIds, briefHash } = await loadInput(pool, job);
    if (!input.candidates.length) throw new JobOutcomeError('the searches found no candidates to assess', 'FAILED');
    let assessments: Assessment[];
    try {
      assessments = checkAssessments(await assessor.assess(input), input);
    } catch (e) {
      if (e instanceof Rejected) throw new JobOutcomeError(`assessor answer rejected: ${e.message}`.slice(0, 1000), 'FAILED');
      throw e;
    }
    const result: Record<string, unknown> = { kind: 'curation', assessor: assessor.id, count: assessments.length };
    return {
      result,
      // stored only with the job's completion (fenced): a cancelled or taken-over run leaves nothing
      apply: async (tx) => {
        const run = (await tx.query<{ id: string }>('INSERT INTO curation_runs (paper_id, job_id, assessor, assessor_label, search_ids, brief_hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [job.paper_id, job.id, assessor.id, assessor.label, searchIds, briefHash])).rows[0]!;
        for (const a of assessments) {
          await tx.query(
            `INSERT INTO curation_assessments (run_id, paper_id, candidate_id, role, topic_fit, article_type_fit, style_fit, read_depth, reasons, exclusion_reason, warnings)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [run.id, job.paper_id, a.candidate_id, a.role, a.topic_fit, a.article_type_fit, a.style_fit, a.read_depth, a.reasons, a.exclusion_reason, a.warnings]);
        }
        result.run_id = run.id;
      },
    };
  };
  return { literature_search: curate };
}


