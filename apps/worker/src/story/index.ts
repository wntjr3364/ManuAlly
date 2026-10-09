// Story alternatives (PW-039, spec 03 "Storyline", 06). A generator (a provider, or the MOCK one) sees
// the brief and the current story as the user wrote them, and the paper's settled material only:
// verified facts and approved claims that pass the PW-037 gates. It answers with 1–5 alternatives: a question, a main message,
// the order of presentation, the evidence each rests on (by id), competing explanations, limitations,
// what evidence is missing, and claims it would suggest. The answer is checked strictly (unknown or
// unsettled evidence, extra fields — a brief, an approval — fail the run; nothing partial is stored),
// then the system adds what it can establish without trusting the generator:
// - every number an alternative states (title, question, message, order, explanations, limitations)
//   must be in the evidence it links or in the user's own brief/story; otherwise the alternative is
//   blocked from adoption ("number_not_in_evidence:<n>") — the AI does not put results into the story
//   that the data do not hold;
// - no supporting link → warning "no_supporting_evidence"; a contradicting link is flagged; the same
//   message as the current story is noted.
// Suggested claims stay text; nothing here creates, approves or changes a claim, a fact or the story.
import { createHash } from 'node:crypto';
import { UUID_RE, type Queryable, type TxPool } from '@pw/domain/shared/db.ts';
import type { Job } from '@pw/domain/jobs/index.ts';
import { getStoryRevision } from '@pw/domain/outlines/index.ts';
import { settledMaterial } from '@pw/search/retrieval/index.ts';
import type { AlternativeContent, AlternativeEvidence } from '@pw/domain/story-ai/index.ts';
import { JobOutcomeError, type JobHandler } from '../queue/index.ts';

export interface StoryInput {
  brief: Record<string, string | string[]>;
  story: Record<string, string | string[]>;
  facts: { id: string; text: string }[];
  claims: { id: string; kind: string; text: string }[];
}
export interface StoryGenerator { id: 'mock' | 'claude_agent' | 'codex'; label: string | null; propose(input: StoryInput): Promise<unknown> }
export interface CheckedAlternative { content: AlternativeContent; warnings: string[]; blocked_reasons: string[] }

class Rejected extends Error {}
const ROLES = ['supports', 'contradicts', 'context'] as const;
const KEYS = ['title', 'question', 'main_message', 'presentation_order', 'evidence_links', 'competing_explanations', 'limitations', 'evidence_gaps', 'claim_suggestions'];
const MAX_ALTERNATIVES = 5;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, what: string, min: number, max: number): string => {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw new Rejected(`${what} must be text of ${min}–${max} characters`);
  return v.trim();
};
const list = (v: unknown, what: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 10) throw new Rejected(`${what} must be a list of at most 10 items`);
  return v.map((x, i) => text(x, `${what}[${i}]`, 1, 500));
};

// Numbers as written in scientific prose (PW-039 review MAJOR). A number counts wherever it states a
// quantity: glued to a unit ("50mM", "24h", "9x", "10µg"), with a decimal comma or thousands separator
// ("2,4" → 2.4, "1,200" → 1200), as a range ("2-9", "2–9" → 2 and 9), in scientific notation ("1e-3",
// "10^-6", "10⁻⁶", "3 × 10⁵"), as a percentage, a vulgar fraction ("½") or a word ("two"…"hundred",
// "tenfold", "two-fold", "twice", "double", "half"). What is not a quantity is skipped: names with
// digits ("ABC1", "H2O"), ordinals ("3rd"), single-letter labels ("2D", "5A") and figure/table numbers
// ("Figure 2"). The sign counts where it is one ("−0.5"), not where it is a hyphen ("day-3" → 3).
const SUPER: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+' };
const FRACTIONS: Record<string, number> = { '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75, '⅕': 0.2, '⅛': 0.125 };
const WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000, million: 1e6, billion: 1e9, twice: 2, double: 2, doubled: 2, doubling: 2, triple: 3, tripled: 3, quadruple: 4, quadrupled: 4, half: 0.5, halved: 0.5, quarter: 0.25,
};
const TENS = new Set(['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']);
const WORD_RE = new RegExp(`(?<![\\p{L}])(${Object.keys(WORDS).join('|')})(?:-?fold)?(?![\\p{L}])`, 'giu');
export function numbersIn(raw: string): number[] {
  // superscripts → ^n; unicode minus → -; a middle dot between digits is a decimal point
  const s = raw.replace(/(\d)([⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+)/g, (_m, d: string, sup: string) => `${d}^${[...sup].map((c) => SUPER[c]).join('')}`)
    .replace(/[−–—]/g, (c) => (c === '−' ? '-' : '–')).replace(/(\d)·(\d)/g, '$1.$2');
  const out: number[] = [];
  const re = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)(?:[eE]([-+]?\d+))?/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const start = m.index;
    const before = s[start - 1] ?? '';
    const before2 = s[start - 2] ?? '';
    // a name (ABC1, H2O) — but an x/× right before a number is a multiplier ("x2"; re-review nit)
    if (/[\p{L}_]/u.test(before) && !(/[x×]/i.test(before) && !/[\p{L}\p{N}]/u.test(before2))) continue;
    if (before === '.' && /\d/.test(before2)) continue;
    if (/(?:fig(?:ure)?s?\.?|tables?|panels?|supplementary|suppl\.?|ref\.?|eq\.?|equation)\s*$/i.test(s.slice(Math.max(0, start - 16), start))) continue;
    const tok = m[1]!;
    let value = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(tok) ? Number(tok.replace(/,/g, '')) : Number(tok.replace(',', '.'));
    if (m[2]) value *= 10 ** Number(m[2]);
    let end = start + m[0].length;
    const rest = s.slice(end);
    // a sign is a sign where it does not join two words or numbers ("day-3", "2-9" are not negative)
    if ((before === '-' || before === '+') && !/[\p{L}\p{N}]/u.test(before2) && before === '-') value = -value;
    const pow = /^\^([-+]?\d+)/.exec(rest);
    if (pow) { value = value ** Number(pow[1]); end += pow[0].length; re.lastIndex = end; }
    const times = /^\s*[×xX*]\s*10(?:\^([-+]?\d+)|[eE]([-+]?\d+))/.exec(s.slice(end));
    if (times) { value *= 10 ** Number(times[1] ?? times[2]); end += times[0].length; re.lastIndex = end; }
    const after = s.slice(end);
    if (/^(st|nd|rd|th)(?![\p{L}])/iu.test(after)) continue; // an ordinal
    // a dimension label (2D, 3D); other glued capitals are units (5M, 37C, 10K) and count (re-review);
    // panel letters follow "Fig."/"panel", which are skipped above
    if (/^D(?![\p{L}\p{N}])/u.test(after) && (value === 2 || value === 3)) continue;
    out.push(value);
  }
  for (const [c, v] of Object.entries(FRACTIONS)) if (s.includes(c)) out.push(v);
  for (let m = WORD_RE.exec(s); m; m = WORD_RE.exec(s)) {
    const w = m[1]!.toLowerCase();
    // a compound: twenty-five → 25 (re-review nit)
    const unit = TENS.has(w) ? /^-(one|two|three|four|five|six|seven|eight|nine)(?![\p{L}])/iu.exec(s.slice(m.index + m[0].length)) : null;
    if (unit) { out.push(WORDS[w]! + (unit[1]!.toLowerCase() === 'one' ? 1 : WORDS[unit[1]!.toLowerCase()]!)); WORD_RE.lastIndex = m.index + m[0].length + unit[0].length; continue; }
    out.push(WORDS[w]!);
  }
  return out.map((n) => (Number.isInteger(n) ? n : Number(n.toPrecision(12))));
}

// the text values the user wrote (ids in evidence_links are not text)
function ownText(input: StoryInput): string {
  const vals: string[] = [];
  for (const [part, rec] of [['brief', input.brief], ['story', input.story]] as const) {
    for (const [k, v] of Object.entries(rec)) {
      if (part === 'story' && k === 'evidence_links') continue;
      vals.push(...(Array.isArray(v) ? v : [v]).map(String));
    }
  }
  return vals.join('\n');
}

export function checkAlternatives(raw: unknown, input: StoryInput): CheckedAlternative[] {
  if (!obj(raw) || Object.keys(raw).some((k) => k !== 'alternatives') || !Array.isArray(raw.alternatives)) throw new Rejected('the answer must be { alternatives: [...] } (nothing else: the brief and approvals are not the generator\'s)');
  if (!raw.alternatives.length || raw.alternatives.length > MAX_ALTERNATIVES) throw new Rejected(`the answer must hold 1–${MAX_ALTERNATIVES} alternatives`);
  const facts = new Map(input.facts.map((f) => [f.id, f.text]));
  const claims = new Map(input.claims.map((c) => [c.id, c.text]));
  const ownNumbers = new Set(numbersIn(ownText(input)));
  const baseMessage = typeof input.story.main_message === 'string' ? input.story.main_message.trim().toLowerCase() : null;
  return raw.alternatives.map((x, i): CheckedAlternative => {
    if (!obj(x)) throw new Rejected(`alternative ${i} is not an object`);
    const extra = Object.keys(x).filter((k) => !KEYS.includes(k));
    if (extra.length) throw new Rejected(`alternative ${i} has fields that are not allowed: ${extra.join(', ').slice(0, 100)}`);
    if (!Array.isArray(x.evidence_links) || x.evidence_links.length > 30) throw new Rejected(`alternative ${i} evidence_links must be a list of at most 30 links`);
    const seen = new Set<string>();
    const evidence: AlternativeEvidence[] = x.evidence_links.map((l, j) => {
      if (!obj(l) || Object.keys(l).some((k) => !['kind', 'id', 'role'].includes(k))) throw new Rejected(`alternative ${i} evidence link ${j} must be { kind, id, role }`);
      if (!ROLES.includes(l.role as (typeof ROLES)[number])) throw new Rejected(`alternative ${i} evidence link ${j} role must be one of ${ROLES.join(', ')}`);
      const id = typeof l.id === 'string' ? l.id.toLowerCase() : '';
      const known = l.kind === 'fact' ? facts.get(id) : l.kind === 'claim' ? claims.get(id) : undefined;
      // only this paper's verified facts and approved claims (what the generator was shown)
      if (known === undefined) throw new Rejected(`alternative ${i} links evidence that is not a verified fact or approved claim of this paper`);
      if (seen.has(`${l.kind}:${id}`)) throw new Rejected(`alternative ${i} links the same evidence twice`);
      seen.add(`${l.kind}:${id}`);
      return { kind: l.kind as 'fact' | 'claim', id, role: l.role as AlternativeEvidence['role'], text: known };
    });
    const content: AlternativeContent = {
      title: text(x.title, `alternative ${i} title`, 3, 200),
      question: text(x.question, `alternative ${i} question`, 3, 1000),
      main_message: text(x.main_message, `alternative ${i} main_message`, 3, 1000),
      presentation_order: list(x.presentation_order, `alternative ${i} presentation_order`),
      evidence,
      competing_explanations: list(x.competing_explanations, `alternative ${i} competing_explanations`),
      limitations: list(x.limitations, `alternative ${i} limitations`),
      evidence_gaps: list(x.evidence_gaps, `alternative ${i} evidence_gaps`),
      claim_suggestions: list(x.claim_suggestions, `alternative ${i} claim_suggestions`),
    };
    // system rules
    // numbers may come from the evidence the story will record (not context links, which adoption
    // drops — review MINOR 1) or from the user's own words
    const allowed = new Set([...ownNumbers, ...numbersIn(evidence.filter((e) => e.role !== 'context').map((e) => e.text).join('\n'))]);
    const stated = numbersIn([content.title, content.question, content.main_message, ...content.presentation_order, ...content.competing_explanations, ...content.limitations].join('\n'));
    const blocked = [...new Set(stated.filter((n) => !allowed.has(n)))].map((n) => `number_not_in_evidence:${n}`);
    const warnings: string[] = [];
    // suggestions and gaps are not adopted, but they are AI-stated numbers in front of the user (nit)
    for (const n of new Set(numbersIn([...content.claim_suggestions, ...content.evidence_gaps].join('\n')).filter((x) => !allowed.has(x)))) warnings.push(`suggestion_number_not_in_evidence:${n}`);
    if (!evidence.some((e) => e.role === 'supports')) warnings.push('no_supporting_evidence');
    if (evidence.some((e) => e.role === 'contradicts')) warnings.push('contradicting_evidence_linked');
    if (baseMessage && content.main_message.toLowerCase() === baseMessage) warnings.push('same_as_current_story');
    return { content, warnings, blocked_reasons: blocked };
  });
}

// The paper's settled material, as text the generator can read
function factText(f: { entity: string; metric: string; value_text: string; unit: string; group_label: string; comparison: string; n: number | null; statistics: { kind: string; value_text: string }[] | null }) {
  const stats = (f.statistics ?? []).map((s) => `${s.kind}=${s.value_text}`).join(', ');
  return `${f.entity} · ${f.metric} = ${f.value_text}${f.unit ? ` ${f.unit}` : ''}${f.group_label ? `; group: ${f.group_label}` : ''}${f.comparison ? `; compared with: ${f.comparison}` : ''}${f.n ? `; n=${f.n}` : ''}${stats ? `; ${stats}` : ''}`;
}

async function loadInput(db: Queryable, job: Job, provider: string): Promise<{ input: StoryInput; baseId: string; inputHash: string }> {
  const p = job.payload as { base_story_revision_id?: unknown };
  if (Object.keys(p ?? {}).some((k) => k !== 'base_story_revision_id') || typeof p.base_story_revision_id !== 'string' || !UUID_RE.test(p.base_story_revision_id)) {
    throw new JobOutcomeError('story payload must be { base_story_revision_id }', 'FAILED');
  }
  const base = await getStoryRevision(db, job.paper_id, p.base_story_revision_id);
  if (!base) throw new JobOutcomeError('the base story revision is not this paper\'s', 'FAILED');
  // only material that is settled and may go to this provider (review MINOR 3: the PW-037 gates)
  const settled = await settledMaterial(db, job.paper_id, provider);
  const facts = (await db.query<Parameters<typeof factText>[0] & { id: string }>(
    `SELECT f.id, f.entity, f.metric, f.value_text, f.unit, f.group_label, f.comparison, f.n,
            (SELECT json_agg(json_build_object('kind', s.kind, 'value_text', s.value_text) ORDER BY s.kind) FROM fact_statistics s WHERE s.fact_id = f.id) AS statistics
     FROM fact_records f WHERE f.paper_id = $1 AND f.verification_state = 'VERIFIED' AND f.id = ANY($2::uuid[]) ORDER BY f.created_at, f.id LIMIT 200`, [job.paper_id, [...settled.factIds]])).rows;
  const claims = (await db.query<{ id: string; kind: string; text: string }>(
    "SELECT id, kind, text FROM claims WHERE paper_id = $1 AND approval_state = 'APPROVED' AND id = ANY($2::uuid[]) ORDER BY created_at, id LIMIT 200", [job.paper_id, [...settled.claimIds]])).rows;
  const input: StoryInput = { brief: base.brief, story: base.story, facts: facts.map((f) => ({ id: f.id, text: factText(f) })), claims };
  return { input, baseId: base.id, inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
}

// MOCK: deterministic alternatives built only from the given material, labelled as such
export function createMockStoryGenerator(): StoryGenerator {
  return {
    id: 'mock',
    label: 'MOCK',
    async propose(input) {
      const question = typeof input.story.question === 'string' && input.story.question.trim() ? input.story.question : String(input.brief.purpose);
      const current = typeof input.story.main_message === 'string' && input.story.main_message.trim() ? input.story.main_message : null;
      const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
      const near = (s: string, t: string) => [...words(s)].filter((w) => words(t).has(w)).length;
      const facts = input.facts;
      const alts: unknown[] = [];
      if (current && facts.length) {
        const ranked = [...facts].sort((a, b) => near(b.text, current) - near(a.text, current));
        alts.push({
          title: '[MOCK] 지금 방향 유지', question, main_message: current,
          presentation_order: ranked.map((f) => f.text.split(' · ')[0]!),
          evidence_links: ranked.map((f, i) => ({ kind: 'fact', id: f.id, role: i === 0 ? 'supports' : 'context' })),
          competing_explanations: ['[MOCK] 같은 변화가 다른 스트레스 경로에서 올 가능성'],
          limitations: Array.isArray(input.story.limitations) ? input.story.limitations : [],
          evidence_gaps: ['[MOCK] 메시지를 직접 받치는 독립 자료가 하나뿐인지 확인'],
          claim_suggestions: [],
        });
      }
      if (facts.length) {
        const f = facts[0]!;
        alts.push({
          title: '[MOCK] 가장 직접적인 관측 하나로 좁힌 안', question, main_message: `[MOCK] ${f.text.split('; ')[0]} (${f.text.split('; ').slice(1).join('; ')})`,
          presentation_order: [f.text.split(' · ')[0]!], evidence_links: [{ kind: 'fact', id: f.id, role: 'supports' }],
          competing_explanations: [], limitations: ['[MOCK] 다른 조건의 자료는 아직 이 메시지를 받치지 않음'], evidence_gaps: [], claim_suggestions: [],
        });
      }
      if (input.claims.length) {
        const c = input.claims[0]!;
        alts.push({
          title: '[MOCK] 승인된 주장을 중심으로', question, main_message: c.text,
          presentation_order: [c.text.slice(0, 80)], evidence_links: [{ kind: 'claim', id: c.id, role: 'supports' }],
          competing_explanations: [], limitations: ['[MOCK] 주장 하나에 기대는 이야기'], evidence_gaps: ['[MOCK] 주장을 받치는 사실 기록을 연결'], claim_suggestions: [],
        });
      }
      if (!alts.length) {
        alts.push({ title: '[MOCK] 근거가 아직 없음', question, main_message: current ?? String(input.brief.purpose), presentation_order: [], evidence_links: [], competing_explanations: [], limitations: [], evidence_gaps: ['[MOCK] 검증된 사실이나 승인된 주장이 없음'], claim_suggestions: [] });
      }
      return { alternatives: alts };
    },
  };
}

export function storyHandlers(pool: TxPool, generator: StoryGenerator): Record<'propose_story', JobHandler> {
  return {
    propose_story: async (job) => {
      const { input, baseId, inputHash } = await loadInput(pool, job, generator.id);
      // a real provider sees paper material only where the paper allows it (spec 09)
      if (generator.id !== 'mock') {
        const p = (await pool.query<{ external_send_policy: string; data_classification: string; allowed_providers: string[] }>('SELECT external_send_policy, data_classification, allowed_providers FROM paper_projects WHERE id = $1', [job.paper_id])).rows[0]!;
        if (p.data_classification === 'sensitive' || p.external_send_policy !== 'allow_selected' || !p.allowed_providers.includes(generator.id)) {
          throw new JobOutcomeError('this paper does not allow sending its material to this provider', 'WAITING_USER');
        }
      }
      let checked: CheckedAlternative[];
      try {
        checked = checkAlternatives(await generator.propose(input), input);
      } catch (e) {
        if (e instanceof Rejected) throw new JobOutcomeError(`generator answer rejected: ${e.message}`.slice(0, 1000), 'FAILED');
        throw e;
      }
      const result: Record<string, unknown> = { kind: 'story_alternatives', generator: generator.id, count: checked.length, blocked: checked.filter((c) => c.blocked_reasons.length).length };
      return {
        result,
        // stored only with the job's completion (fenced): a cancelled or taken-over run leaves nothing
        apply: async (tx) => {
          const run = (await tx.query<{ id: string }>('INSERT INTO story_alternative_runs (paper_id, job_id, base_story_revision_id, generator, generator_label, input_hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [job.paper_id, job.id, baseId, generator.id, generator.label, inputHash])).rows[0]!;
          for (const [i, c] of checked.entries()) {
            await tx.query('INSERT INTO story_alternatives (run_id, paper_id, position, content, warnings, blocked_reasons) VALUES ($1, $2, $3, $4, $5, $6)',
              [run.id, job.paper_id, i + 1, JSON.stringify(c.content), c.warnings, c.blocked_reasons]);
          }
          result.run_id = run.id;
        },
      };
    },
  };
}
