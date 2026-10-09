// WritingProfile proposals (PW-041, spec 06). A generator (a provider, or the MOCK one) sees, for each
// writing reference the owner chose, which sections were actually read and their text — only text the
// system may use and, for an external AI, may send — plus the owner's feedback and the current profile.
// It answers { profile }. The answer is checked strictly (unknown fields, a journal rule, a source
// outside the request fail the run; nothing partial is stored); then every rule and example is checked
// against what was read: from an unread section, from a section other than the one it describes, with
// no source, or copying a run of words from a source → removed and listed with the reason. The result
// is a DRAFT; approving it is the owner's act.
import { createHash } from 'node:crypto';
import { UUID_RE, type TxPool } from '@pw/domain/shared/db.ts';
import type { Job } from '@pw/domain/jobs/index.ts';
import {
  ProfileRejected, activeProfile, checkAgainstSources, insertProfileRevision, parseProfileContent, readWritingSources, sourceRecord,
  type ProfileContent, type ReadDepth, type SectionName,
} from '@pw/domain/writing-profile/index.ts';
import { JobOutcomeError, type JobHandler } from '../queue/index.ts';

export interface ProfileInput {
  article_type: string;
  sources: { reference_id: string; title: string; read_depth: ReadDepth; sections_read: SectionName[]; withheld: string | null; sections: { section: SectionName; text: string }[] }[];
  feedback: string[];
  // the approved profile, without the owner's journal rule (that is not the generator's to change)
  current_profile: Omit<ProfileContent, 'journal_rule_snapshot'> | null;
}
export interface ProfileGenerator { id: 'mock' | 'claude_agent' | 'codex'; label: string | null; propose(input: ProfileInput): Promise<unknown> }

// MOCK: a deterministic profile built from the sections that were read, labelled as such. Its wording
// is generic; it never quotes a source.
const ROLE: Partial<Record<SectionName, [string, string, string]>> = {
  Introduction: ['좁혀 가며 질문을 세운다', '배경에서 지식의 빈틈으로, 빈틈에서 이 논문의 질문으로 좁혀 간다', '교과서식 배경 설명을 길게 늘어놓는다'],
  Methods: ['수행한 절차만 재현 가능하게 적는다', '수행이 확인된 조건·반복수·버전만 적는다', '하지 않은 실험이나 모르는 버전을 채워 넣는다'],
  Results: ['관찰과 수치를 그림에 묶는다', '문단마다 관찰 하나를 그림·표와 함께 먼저 말한다', '결과마다 해석을 길게 붙인다'],
  'Results and Discussion': ['관찰 뒤에 범위를 지킨 해석을 붙인다', '관찰을 먼저 말하고 해석은 그 범위 안에서 덧붙인다', '관찰과 해석을 구별하지 않는다'],
  Discussion: ['의미와 한계를 비교 속에서 말한다', '핵심 발견을 다시 짧게 밝힌 뒤 선행연구와 비교하고 한계를 적는다', '결과를 순서대로 되풀이하기만 한다'],
  Conclusion: ['확정된 결과에서만 맺는다', '본문에서 확정된 결과만으로 짧게 맺는다', '본문에 없는 새 주장을 덧붙인다'],
  Abstract: ['본문과 같은 수치·결론을 압축한다', '질문·방법·핵심 결과·결론을 본문 수치 그대로 압축한다', '본문에 없는 수치를 넣는다'],
};
export function createMockProfileGenerator(): ProfileGenerator {
  return {
    id: 'mock',
    label: 'MOCK',
    async propose(input) {
      const bySection = new Map<SectionName, { reference_id: string; section: SectionName }[]>();
      for (const s of input.sources) for (const sec of s.sections_read) bySection.set(sec, [...(bySection.get(sec) ?? []), { reference_id: s.reference_id, section: sec }]);
      const section_roles = [...bySection.entries()].filter(([sec]) => ROLE[sec]).map(([sec, sources]) => {
        const [role, principle, counter] = ROLE[sec]!;
        return { section: sec, role: `[MOCK] ${role}`, principles: [{ text: `[MOCK] ${principle}`, sources }], counterexamples: [{ text: `[MOCK] ${counter}`, sources }] };
      });
      const cur = input.current_profile;
      return {
        profile: {
          article_type: cur?.article_type ?? input.article_type,
          target_audience: cur?.target_audience ?? '',
          preferred_english_variant: cur?.preferred_english_variant ?? 'unspecified',
          concision_preference: cur?.concision_preference ?? 'concise',
          claim_strength_policy: cur?.claim_strength_policy ?? '[MOCK] 관찰은 그대로, 해석은 해석이라고 밝혀 쓴다.',
          terminology: cur?.terminology ?? [],
          section_roles,
          rhetoric_patterns: [],
          anti_examples: [],
          accepted_examples: [],
        },
      };
    },
  };
}

async function loadInput(pool: TxPool, job: Job, provider: string) {
  const p = (job.payload ?? {}) as { reference_ids?: unknown };
  if (Object.keys(p).some((k) => k !== 'reference_ids') || !Array.isArray(p.reference_ids) || !p.reference_ids.length || p.reference_ids.some((x) => typeof x !== 'string' || !UUID_RE.test(x))) {
    throw new JobOutcomeError('profile payload must be { reference_ids }', 'FAILED');
  }
  let sources;
  try {
    sources = await readWritingSources(pool, job.paper_id, p.reference_ids as string[], provider);
  } catch (e) {
    throw new JobOutcomeError(`cannot read the sources: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500), 'FAILED');
  }
  const paper = (await pool.query<{ article_type: string; owner_id: string }>('SELECT article_type, owner_id FROM paper_projects WHERE id = $1', [job.paper_id])).rows[0]!;
  const feedback = (await pool.query<{ text: string }>('SELECT text FROM writing_profile_feedback WHERE paper_id = $1 ORDER BY created_at, id LIMIT 50', [job.paper_id])).rows.map((r) => r.text);
  const active = await activeProfile(pool, job.paper_id);
  const { journal_rule_snapshot: journalRule, ...current } = active?.content ?? ({} as ProfileContent);
  const input: ProfileInput = {
    article_type: paper.article_type,
    sources: sources.map((s) => ({ reference_id: s.reference_id, title: s.title, read_depth: s.read_depth, sections_read: s.sections_read, withheld: s.withheld, sections: s.sections })),
    feedback,
    current_profile: active ? current : null,
  };
  return { input, sources, journalRule, ownerId: paper.owner_id, inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
}

export function profileHandlers(pool: TxPool, generator: ProfileGenerator): Record<'propose_profile', JobHandler> {
  return {
    propose_profile: async (job) => {
      // a real provider sees paper material only where the paper allows it (spec 09); checked before reading
      if (generator.id !== 'mock') {
        const p = (await pool.query<{ external_send_policy: string; data_classification: string; allowed_providers: string[] }>('SELECT external_send_policy, data_classification, allowed_providers FROM paper_projects WHERE id = $1', [job.paper_id])).rows[0]!;
        if (p.data_classification === 'sensitive' || p.external_send_policy !== 'allow_selected' || !p.allowed_providers.includes(generator.id)) {
          throw new JobOutcomeError('this paper does not allow sending its material to this provider', 'WAITING_USER');
        }
      }
      const { input, sources, journalRule, ownerId, inputHash } = await loadInput(pool, job, generator.id);
      let checked: ReturnType<typeof checkAgainstSources>;
      try {
        const answer = await generator.propose(input);
        if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).some((k) => k !== 'profile')) throw new ProfileRejected('the answer must be { profile }');
        checked = checkAgainstSources(parseProfileContent((answer as { profile: unknown }).profile, false), sources, { requireSource: true });
      } catch (e) {
        if (e instanceof ProfileRejected) throw new JobOutcomeError(`generator answer rejected: ${e.message}`.slice(0, 1000), 'FAILED');
        throw e;
      }
      // the owner's journal rule carries over unchanged
      const content: ProfileContent = journalRule ? { ...checked.content, journal_rule_snapshot: journalRule } : checked.content;
      const result: Record<string, unknown> = { kind: 'writing_profile', generator: generator.id, removed: checked.removed.length };
      return {
        result,
        // stored only with the job's completion (fenced): a cancelled or taken-over run leaves nothing
        apply: async (tx) => {
          await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`writing-profile:${job.paper_id}`]);
          const run = (await tx.query<{ id: string }>('INSERT INTO writing_profile_runs (paper_id, job_id, generator, generator_label, input_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [job.paper_id, job.id, generator.id, generator.label, inputHash])).rows[0]!;
          const parent = (await tx.query<{ id: string }>('SELECT id FROM writing_profile_revisions WHERE paper_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [job.paper_id])).rows[0]?.id ?? null;
          const rev = await insertProfileRevision(tx, { paperId: job.paper_id, ownerId, parentId: parent, runId: run.id, content, sources: sources.map(sourceRecord), removed: checked.removed });
          result.run_id = run.id;
          result.revision_id = rev.id;
        },
      };
    },
  };
}
