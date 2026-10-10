// The reviewer (PW-044, spec 06 "검증 층" B scientific, C writing). It reads one paragraph of one
// revision with what that paragraph rests on — the approved claims, verified facts and evidence of the
// plan it belongs to (only what the PW-037 gates let this provider see), the deterministic gate's
// findings (PW-043) and the writing profile — and answers { findings }. Each finding must quote an
// exact span of the paragraph and give a reason, the record it rests on, a confidence and maybe an
// alternative. There is no score: an answer with one, or with any other field, fails the run. A
// finding whose span is not in the paragraph exactly once, or whose source the reviewer was not
// given, is dropped and listed. Nothing here changes the manuscript or any record.
// The run notes whether the reviewer is the model that wrote the paragraph ("same_model": not an
// independent check, spec 06).
import { createHash } from 'node:crypto';
import { DomainError, UUID_RE, type Queryable, type TxPool } from '@pw/domain/shared/db.ts';
import type { Job } from '@pw/domain/jobs/index.ts';
import { blockText, documentAt, paragraphHash } from '@pw/domain/writer/index.ts';
import { activeProfile } from '@pw/domain/writing-profile/index.ts';
import { scientificGate } from '@pw/domain/scientific-checks/index.ts';
import { gateFacts, gateReferences } from '@pw/domain/scientific-checks/records.ts';
import { FINDING_CATEGORIES, insertReviewRunIn } from '@pw/domain/scientific-review/index.ts';
import { nodeScopeFor } from '@pw/search/retrieval/index.ts';
import { numbersIn } from '../story/index.ts';
import { sectionKey } from '@pw/domain/manuscript-structure/index.ts';
import { JobOutcomeError, type JobHandler } from '../queue/index.ts';

export interface ReviewInput {
  paragraph_text: string;
  section: string | null;
  purpose: string | null;
  claims: { id: string; kind: string; text: string }[];
  facts: { id: string; text: string }[];
  evidence: { id: string; kind: string; label: string }[];
  // the deterministic gate (PW-043); a finding may rest on one of its entries by index
  gate: { status: string; findings: { index: string; check: string; verdict: string; text: string; reason: string | null }[] };
  style: { profile_revision_id: string | null; claim_strength_policy: string; section_principles: string[]; terminology: { term: string; preferred: string; avoid: string[] }[] };
  categories: typeof FINDING_CATEGORIES;
}
export interface Reviewer { id: 'mock' | 'claude_agent' | 'codex'; label: string | null; review(input: ReviewInput): Promise<unknown> }

class Rejected extends Error {}
const KINDS = ['scientific', 'writing'] as const;
const SOURCES = ['claim', 'fact', 'evidence', 'profile', 'gate'] as const;
const CONFIDENCE = ['low', 'medium', 'high'] as const;
const FINDING_KEYS = ['kind', 'category', 'quote', 'reason', 'source', 'confidence', 'alternative'];
const MAX_FINDINGS = 20;

interface Checked { position: number; kind: string; category: string; quote: string; span_start: number; span_end: number; reason: string; source_kind: string | null; source_id: string | null; confidence: string; alternative: string | null; warnings: string[] }
export function checkFindings(raw: unknown, input: ReviewInput): { findings: Checked[]; dropped: { quote: string; reason: string }[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Rejected('the answer must be { findings }');
  const extra = Object.keys(raw).filter((k) => k !== 'findings');
  if (extra.length) throw new Rejected(`unknown fields: ${extra.join(', ')} (a review has findings, never a score)`);
  const list = (raw as { findings?: unknown }).findings;
  if (!Array.isArray(list) || list.length > MAX_FINDINGS) throw new Rejected(`findings must be a list of at most ${MAX_FINDINGS}`);
  const known = new Set([
    ...input.claims.map((c) => `claim:${c.id}`), ...input.facts.map((f) => `fact:${f.id}`), ...input.evidence.map((e) => `evidence:${e.id}`),
    ...(input.style.profile_revision_id ? [`profile:${input.style.profile_revision_id}`] : []), ...input.gate.findings.map((g) => `gate:${g.index}`),
  ]);
  const evidenceNumbers = new Set(numbersIn([input.paragraph_text, ...input.facts.map((f) => f.text)].join('\n')));
  const findings: Checked[] = [];
  const dropped: { quote: string; reason: string }[] = [];
  list.forEach((v, i) => {
    const at = `findings[${i}]`;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Rejected(`${at} must be an object`);
    const f = v as Record<string, unknown>;
    const bad = Object.keys(f).filter((k) => !FINDING_KEYS.includes(k));
    if (bad.length) throw new Rejected(`${at} has unknown fields: ${bad.join(', ')}`);
    if (!KINDS.includes(f.kind as (typeof KINDS)[number])) throw new Rejected(`${at}.kind must be scientific or writing`);
    const kind = f.kind as (typeof KINDS)[number];
    if (!(FINDING_CATEGORIES[kind] as readonly string[]).includes(f.category as string)) throw new Rejected(`${at}.category must be one of ${FINDING_CATEGORIES[kind].join(', ')}`);
    if (typeof f.quote !== 'string' || !f.quote || f.quote.length > 2000) throw new Rejected(`${at}.quote must be the exact text it is about`);
    if (typeof f.reason !== 'string' || f.reason.trim().length < 10 || f.reason.length > 1000) throw new Rejected(`${at}.reason must say why (10–1000 characters)`);
    if (!CONFIDENCE.includes(f.confidence as (typeof CONFIDENCE)[number])) throw new Rejected(`${at}.confidence must be low, medium or high`);
    if (f.alternative !== undefined && f.alternative !== null && (typeof f.alternative !== 'string' || f.alternative.length > 1000)) throw new Rejected(`${at}.alternative must be text up to 1000 characters or null`);
    let source: { kind: string; id: string } | null = null;
    if (f.source !== undefined && f.source !== null) {
      const s = f.source as Record<string, unknown>;
      if (typeof s !== 'object' || Object.keys(s).some((k) => k !== 'kind' && k !== 'id') || !SOURCES.includes(s.kind as (typeof SOURCES)[number]) || typeof s.id !== 'string') throw new Rejected(`${at}.source must be { kind, id } or null`);
      source = { kind: s.kind as string, id: (s.id as string).toLowerCase() };
    }
    // the span: exactly one place in the paragraph
    const first = input.paragraph_text.indexOf(f.quote);
    if (first < 0) { dropped.push({ quote: f.quote.slice(0, 200), reason: 'span_not_found' }); return; }
    if (input.paragraph_text.indexOf(f.quote, first + 1) >= 0) { dropped.push({ quote: f.quote.slice(0, 200), reason: 'span_ambiguous' }); return; }
    if (source && !known.has(`${source.kind}:${source.id}`)) { dropped.push({ quote: f.quote.slice(0, 200), reason: 'unknown_source' }); return; }
    // a scientific finding rests on a record (review NIT); a writing finding may be about wording alone
    if (!source && kind === 'scientific') { dropped.push({ quote: f.quote.slice(0, 200), reason: 'no_source' }); return; }
    const alternative = typeof f.alternative === 'string' && f.alternative.trim() ? f.alternative.trim() : null;
    const warnings = alternative ? [...new Set(numbersIn(alternative).filter((n) => !evidenceNumbers.has(n)))].map((n) => `alternative_number_not_in_evidence:${n}`) : [];
    findings.push({ position: findings.length + 1, kind, category: f.category as string, quote: f.quote, span_start: first, span_end: first + f.quote.length, reason: f.reason.trim(), source_kind: source?.kind ?? null, source_id: source?.id ?? null, confidence: f.confidence as string, alternative, warnings });
  });
  return { findings, dropped };
}

// MOCK: deterministic findings from the material, labelled as such — causal wording over an
// observation, a deterministic-gate failure, a very long sentence. It flags no word by itself.
const CAUSAL = /\b(?:demonstrates? that|proves? that|proves?|causes?|leads? to|is responsible for)\b[^.;]*/i;
export function createMockReviewer(): Reviewer {
  return {
    id: 'mock',
    label: 'MOCK',
    async review(input) {
      const findings: unknown[] = [];
      const t = input.paragraph_text;
      const observation = input.claims.find((c) => c.kind === 'observation');
      const causal = CAUSAL.exec(t);
      if (causal && observation && t.indexOf(causal[0].trim()) === t.lastIndexOf(causal[0].trim())) {
        const quote = causal[0].trim();
        findings.push({
          kind: 'scientific', category: 'causal_language', quote, confidence: 'medium', source: { kind: 'claim', id: observation.id },
          reason: '[MOCK] The plan rests on an observation; this wording states a cause it does not show.',
          alternative: quote.replace(/demonstrates? that|proves? that/i, 'is consistent with the possibility that').replace(/\bcauses\b/i, 'contributes to').replace(/\bleads? to\b/i, 'is associated with'),
        });
      }
      for (const g of input.gate.findings.filter((x) => x.verdict === 'fail')) {
        if (t.indexOf(g.text) >= 0 && t.indexOf(g.text) === t.lastIndexOf(g.text)) {
          findings.push({ kind: 'scientific', category: 'evidence_mismatch', quote: g.text, confidence: 'high', source: { kind: 'gate', id: g.index }, reason: `[MOCK] The deterministic check failed here (${g.reason ?? g.check}).`, alternative: null });
        }
      }
      for (const s of t.split(/(?<=[.!?])\s+/)) {
        if (s.split(/\s+/).length > 40 && t.indexOf(s) === t.lastIndexOf(s)) findings.push({ kind: 'writing', category: 'length', quote: s, confidence: 'low', source: null, reason: '[MOCK] A very long sentence; consider splitting it at the main clause.', alternative: null });
      }
      return { findings };
    },
  };
}

// Who has written into this paragraph (review MINOR): every applied Writer proposal on the block and
// every applied selection proposal (PW-017) inside it, by their generator. The reviewer being one of
// them → same_model; an AI edit whose generator cannot be told → unknown_authorship (never
// "human_written"); only other generators → different_model.
const ORIGIN = /^worker:(?:provider\.|tool-gateway:)(mock|claude_agent|codex)$/;
export async function authorshipOf(db: Queryable, paperId: string, documentId: string, blockId: string, reviewer: string) {
  const writers = (await db.query<{ generator: string }>(
    "SELECT generator FROM paragraph_proposals WHERE paper_id = $1 AND document_id = $2 AND (new_block_id = $3 OR block_id = $3) AND status = 'APPLIED'", [paperId, documentId, blockId])).rows.map((r) => r.generator);
  const edits = (await db.query<{ origin: string }>(
    `SELECT e.origin FROM edit_proposals e JOIN selection_handles h ON h.id = e.selection_handle_id
     WHERE e.paper_id = $1 AND e.document_id = $2 AND h.block_id = $3 AND e.status = 'APPLIED'`, [paperId, documentId, blockId])).rows.map((r) => ORIGIN.exec(r.origin)?.[1] ?? null);
  const all = [...writers, ...edits];
  if (!all.length) return 'human_written';
  if (all.includes(reviewer)) return 'same_model';
  if (all.includes(null)) return 'unknown_authorship';
  return 'different_model';
}

function payloadOf(job: Job) {
  const p = job.payload as Record<string, unknown>;
  if (Object.keys(p).some((k) => !['document_id', 'revision_id', 'block_id'].includes(k)) || ![p.document_id, p.revision_id, p.block_id].every((v) => typeof v === 'string' && UUID_RE.test(v))) {
    throw new JobOutcomeError('review payload must be { document_id, revision_id, block_id }', 'FAILED');
  }
  return p as { document_id: string; revision_id: string; block_id: string };
}

async function loadInput(db: Queryable, job: Job, p: ReturnType<typeof payloadOf>, provider: string) {
  const doc = await documentAt(db, job.paper_id, p.document_id, p.revision_id);
  let block: NonNullable<typeof doc> | null = null;
  doc?.forEach((n) => { if (n.attrs.id === p.block_id) block = n; });
  if (!block || (block as { type: { name: string } }).type.name !== 'paragraph') throw new JobOutcomeError('the paragraph is not in that revision', 'FAILED');
  const para = block as NonNullable<typeof doc>;
  // the plan it belongs to (active outline), seen through this provider's gates
  const plan = (await db.query<{ outline_revision_id: string; node_id: string }>(
    `SELECT l.outline_revision_id, l.node_id FROM outline_node_paragraphs l JOIN paper_projects pp ON pp.id = l.paper_id AND pp.active_outline_revision_id = l.outline_revision_id
     WHERE l.paper_id = $1 AND l.document_id = $2 AND l.block_id = $3 ORDER BY l.created_at LIMIT 1`, [job.paper_id, p.document_id, p.block_id])).rows[0];
  let scope: Awaited<ReturnType<typeof nodeScopeFor>> | null = null;
  if (plan) {
    try {
      scope = await nodeScopeFor(db, { paperId: job.paper_id, outlineRevisionId: plan.outline_revision_id, nodeId: plan.node_id, provider });
    } catch (e) {
      if (!(e instanceof DomainError)) throw e; // a plan that is no longer approved: reviewed without it
    }
  }
  const facts = scope ? await gateFacts(db, job.paper_id, scope.facts.map((f) => f.id)) : [];
  const gate = scientificGate({ paragraph: para.toJSON(), facts, references: await gateReferences(db, job.paper_id), claims: scope?.claims ?? [] });
  const profile = await activeProfile(db, job.paper_id);
  const section = scope?.node.section ?? null;
  const input: ReviewInput = {
    paragraph_text: blockText(para),
    section,
    purpose: scope?.node.paragraph_goal ?? null,
    claims: scope?.claims ?? [],
    facts: facts.map((f) => ({ id: f.id, text: `${f.entity} · ${f.metric} = ${f.value_text}${f.unit ? ` ${f.unit}` : ''}${f.group_label ? `; group: ${f.group_label}` : ''}${f.comparison ? `; compared with: ${f.comparison}` : ''}${f.n ? `; n=${f.n}` : ''}` })),
    evidence: (scope?.evidence ?? []).map((e) => ({ id: e.id, kind: e.kind, label: e.label })),
    gate: { status: gate.status, findings: gate.findings.map((f, i) => ({ index: String(i), check: f.check, verdict: f.verdict, text: f.text, reason: f.reason ?? null })) },
    style: {
      profile_revision_id: profile?.id ?? null,
      claim_strength_policy: profile?.content.claim_strength_policy ?? '',
      section_principles: (profile?.content.section_roles ?? []).filter((r) => sectionKey(r.section) === sectionKey(section ?? '')).flatMap((r) => r.principles.map((x) => x.text)),
      terminology: (profile?.content.terminology ?? []).map((t) => ({ term: t.term, preferred: t.preferred, avoid: t.avoid })),
    },
    categories: FINDING_CATEGORIES,
  };
  return { input, hash: await paragraphHash(para) };
}

export function reviewerHandlers(pool: TxPool, reviewer: Reviewer): Record<'review', JobHandler> {
  return {
    review: async (job) => {
      const p = payloadOf(job);
      // a real provider sees paper material only where the paper allows it (spec 09); checked before reading
      if (reviewer.id !== 'mock') {
        const pp = (await pool.query<{ external_send_policy: string; data_classification: string; allowed_providers: string[] }>('SELECT external_send_policy, data_classification, allowed_providers FROM paper_projects WHERE id = $1', [job.paper_id])).rows[0]!;
        if (pp.data_classification === 'sensitive' || pp.external_send_policy !== 'allow_selected' || !pp.allowed_providers.includes(reviewer.id)) {
          throw new JobOutcomeError('this paper does not allow sending its material to this provider', 'WAITING_USER');
        }
      }
      const { input, hash } = await loadInput(pool, job, p, reviewer.id);
      let checked: ReturnType<typeof checkFindings>;
      try {
        checked = checkFindings(await reviewer.review(input), input);
      } catch (e) {
        if (e instanceof Rejected) throw new JobOutcomeError(`review answer rejected: ${e.message}`.slice(0, 1000), 'FAILED');
        throw e;
      }
      const independence = await authorshipOf(pool, job.paper_id, p.document_id, p.block_id, reviewer.id);
      const result: Record<string, unknown> = { kind: 'review', generator: reviewer.id, findings: checked.findings.length, dropped: checked.dropped.length, independence };
      return {
        result,
        // stored only with the job's completion (fenced): a cancelled or taken-over run leaves nothing
        apply: async (tx) => {
          result.run_id = await insertReviewRunIn(tx, {
            paper_id: job.paper_id, job_id: job.id, document_id: p.document_id, revision_id: p.revision_id, block_id: p.block_id, block_hash: hash,
            generator: reviewer.id, generator_label: reviewer.label, independence, input_hash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), dropped: checked.dropped,
          }, checked.findings);
        },
      };
    },
  };
}
