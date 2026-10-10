// The Writer (PW-042, spec 06 "ParagraphContract", "수정 모드", "검증 층" A). For a pinned request it
// re-checks the draft gate, builds the ParagraphContract of the node — only what the PW-037/040 gates
// let this provider see — hands it to the writer (a provider, or the MOCK one), and stores the answer
// as a paragraph proposal; nothing in the manuscript changes here.
// The answer is read strictly (contracts/writing): unknown fields, a claim or fact not in the contract,
// a citation that is not one of this paper's references (RFC-008), a written bibliography, or more
// than one paragraph refuse the run and nothing is stored. Then the deterministic checks:
// - a new paragraph: every number must come from the contract's exact facts or approved claims; every
//   mandatory claim must be declared as carried; no term the profile says to avoid;
// - a correction or rewrite: the PW-017 guard against the original paragraph (numbers, negations,
//   directions, citations, protected atoms) — conservative keeps the order, a rewrite may reorder —
//   and the avoided terms.
// A failed check stores the proposal as CHECK_FAILED: shown with the reason, never applicable.
import { createHash } from 'node:crypto';
import { DomainError, UUID_RE, type Queryable, type TxPool } from '@pw/domain/shared/db.ts';
import type { Job } from '@pw/domain/jobs/index.ts';
import { canonicalJson } from '@pw/domain/revisions/index.ts';
import { checkDraftGate } from '@pw/domain/outlines/index.ts';
import { activeProfile } from '@pw/domain/writing-profile/index.ts';
import { listReferences } from '@pw/domain/references/index.ts';
import { checkReplacement } from '@pw/domain/proposals/guard.ts';
import { blockText, buildParagraph, documentAt, insertParagraphProposalIn, paragraphItems, placeHolds, type WriterMode } from '@pw/domain/writer/index.ts';
import { noticesOf } from '@pw/domain/literature/index.ts';
import { sectionKey } from '@pw/domain/manuscript-structure/index.ts';
import { proseSignals, scientificGate, type Finding } from '@pw/domain/scientific-checks/index.ts';
import { gateFacts } from '@pw/domain/scientific-checks/records.ts';
import { nodeScopeFor } from '@pw/search/retrieval/index.ts';
import { AnswerRefused, CONTRACT_VERSION, parseWriterAnswer, wordsIn, type ParagraphContract, type ParagraphItem } from '@pw/contracts/writing';
import { numbersIn } from '../story/index.ts';
import { JobOutcomeError, type JobHandler } from '../queue/index.ts';

export interface Writer { id: 'mock' | 'claude_agent' | 'codex'; label: string | null; write(contract: ParagraphContract): Promise<unknown> }
type Check = { check: string; result: 'pass' | 'fail' | 'unknown' | 'not_applicable'; details?: string; finding?: Finding };
interface Payload { mode: WriterMode; outline_revision_id: string; node_id: string; document_id: string; base_revision_id: string; after_block_id: string | null; after_block_hash: string | null; block_id: string | null; expected_block_hash: string | null; section_heading_id: string | null; section_heading_hash: string | null; instruction: string }

const CONTEXT_CHARS = 1500;
const MAX_CITABLE = 200;
const clip = (s: string) => (s.length > CONTEXT_CHARS ? `${s.slice(0, CONTEXT_CHARS)}…` : s);
function factText(f: { entity: string; metric: string; value_text: string; unit: string; group_label: string; comparison: string; n: number | null }, stats: { kind: string; value_text: string }[]) {
  const s = stats.map((x) => `${x.kind}=${x.value_text}`).join(', ');
  return `${f.entity} · ${f.metric} = ${f.value_text}${f.unit ? ` ${f.unit}` : ''}${f.group_label ? `; group: ${f.group_label}` : ''}${f.comparison ? `; compared with: ${f.comparison}` : ''}${f.n ? `; n=${f.n}` : ''}${s ? `; ${s}` : ''}`;
}

function payloadOf(job: Job): Payload {
  const p = job.payload as Record<string, unknown>;
  const uuid = (v: unknown) => typeof v === 'string' && UUID_RE.test(v);
  if (!['draft', 'conservative', 'rewrite'].includes(p.mode as string) || !uuid(p.outline_revision_id) || !uuid(p.node_id) || !uuid(p.document_id) || !uuid(p.base_revision_id)
    || (p.after_block_id !== null && !uuid(p.after_block_id)) || (p.after_block_id !== null) !== (typeof p.after_block_hash === 'string') || (p.block_id !== null && !uuid(p.block_id)) || typeof p.instruction !== 'string') {
    throw new JobOutcomeError('writer payload is malformed', 'FAILED');
  }
  // the section heading of a default-placed draft (PW-046; absent in older jobs and in corrections)
  const sectionHeadingId = p.section_heading_id ?? null;
  const sectionHeadingHash = p.section_heading_hash ?? null;
  if ((sectionHeadingId !== null && (!uuid(sectionHeadingId) || p.mode !== 'draft' || p.after_block_id === null)) || (sectionHeadingId === null) !== (sectionHeadingHash === null) || (sectionHeadingHash !== null && typeof sectionHeadingHash !== 'string')) {
    throw new JobOutcomeError('writer payload is malformed', 'FAILED');
  }
  return { ...p, section_heading_id: sectionHeadingId, section_heading_hash: sectionHeadingHash } as unknown as Payload;
}

async function buildContract(db: Queryable, job: Job, p: Payload, provider: string, storyRevisionId: string) {
  const scope = await nodeScopeFor(db, { paperId: job.paper_id, outlineRevisionId: p.outline_revision_id, nodeId: p.node_id, provider });
  const stats = (await db.query<{ fact_id: string; kind: string; value_text: string }>('SELECT fact_id, kind, value_text FROM fact_statistics WHERE fact_id = ANY($1::uuid[]) ORDER BY kind', [scope.facts.map((f) => f.id)])).rows;
  const doc = await documentAt(db, job.paper_id, p.document_id, p.base_revision_id);
  if (!doc) throw new JobOutcomeError('the base revision is not this paper\'s', 'FAILED');
  const blocks: ReturnType<typeof doc.child>[] = [];
  doc.forEach((n) => blocks.push(n));
  const at = blocks.findIndex((n) => n.attrs.id === (p.block_id ?? p.after_block_id));
  if ((p.block_id ?? p.after_block_id) && at < 0) throw new JobOutcomeError('the block is not in the base revision', 'FAILED');
  // the paragraph before and after the place it goes (or the one it replaces)
  const before = p.block_id ? blocks[at - 1] : p.after_block_id ? blocks[at] : blocks[blocks.length - 1];
  const after = p.block_id ? blocks[at + 1] : p.after_block_id ? blocks[at + 1] : undefined;
  const original = p.block_id ? blocks[at]! : null;
  const profile = await activeProfile(db, job.paper_id);
  const pc = profile?.content;
  // the profile's roles for this plan's section, names compared as the manuscript compares them (PW-046)
  const role = pc?.section_roles.filter((r) => sectionKey(r.section) === sectionKey(scope.node.section)) ?? [];
  const evidenceRefs = new Set((await db.query<{ reference_id: string }>('SELECT reference_id FROM evidence_records WHERE paper_id = $1 AND id = ANY($2::uuid[]) AND reference_id IS NOT NULL', [job.paper_id, scope.evidence.map((e) => e.id)])).rows.map((r) => r.reference_id));
  const all = await listReferences(db, job.paper_id);
  const refs = all.slice(0, MAX_CITABLE);
  // works the owner's library knows as retracted (own flag or a notice about them)
  const owner = (await db.query<{ owner_id: string }>('SELECT owner_id FROM paper_projects WHERE id = $1', [job.paper_id])).rows[0]!.owner_id;
  const retracted = new Set<string>();
  for (const r of refs) if ((await noticesOf(db, owner, r.id)).some((n) => n.kind === 'retracted')) retracted.add(r.id);
  const contract: ParagraphContract = {
    contract_version: CONTRACT_VERSION,
    paper_id: job.paper_id,
    story_revision_id: storyRevisionId,
    outline_revision_id: scope.outline_revision_id,
    node_id: scope.node.node_id,
    section: scope.node.section,
    role: scope.node.role,
    purpose: scope.node.paragraph_goal,
    allowed_interpretation: scope.node.allowed_interpretation,
    prohibited_inferences: scope.node.exclusions,
    transition: scope.node.transition,
    mandatory_claims: scope.claims,
    exact_facts: scope.facts.map((f) => ({ id: f.id, evidence_id: f.evidence_id, text: factText(f, stats.filter((s) => s.fact_id === f.id)) })),
    evidence: scope.evidence,
    excluded: scope.excluded,
    context: { previous: scope.neighbours.previous, next: scope.neighbours.next, preceding_text: clip(blockText(before ?? null)), following_text: clip(blockText(after ?? null)) },
    style: {
      profile_revision_id: profile?.id ?? null,
      english_variant: pc?.preferred_english_variant ?? 'unspecified',
      concision: pc?.concision_preference ?? 'concise',
      claim_strength_policy: pc?.claim_strength_policy ?? '',
      terminology: pc?.terminology ?? [],
      section_principles: role.flatMap((r) => r.principles.map((x) => x.text)),
      section_counterexamples: role.flatMap((r) => r.counterexamples.map((x) => x.text)),
      journal_rule: pc?.journal_rule_snapshot?.text ?? null,
    },
    target_length: { min_words: scope.node.word_budget_min, max_words: scope.node.word_budget_max },
    operation: { mode: p.mode, document_id: p.document_id, base_revision_id: p.base_revision_id, after_block_id: p.after_block_id, block_id: p.block_id, original: original ? (paragraphItems(original) as ParagraphItem[]) : null },
    citable_references: refs.map((r) => ({ reference_id: r.id, label: `${r.authors[0]?.family ?? '?'}${r.authors.length > 1 ? ' et al.' : ''} ${r.year ?? 'n.d.'}: ${r.title}`.slice(0, 300), linked_to_node: evidenceRefs.has(r.id), retracted: retracted.has(r.id) })),
    citable_references_truncated: all.length > MAX_CITABLE,
    instruction: p.instruction,
    transmission: { provider, withheld: scope.excluded.length },
  };
  return { contract, original };
}

const citedIn = (paragraph: ReturnType<typeof buildParagraph>) => { const ids: string[] = []; paragraph.forEach((n) => { if (n.type.name === 'citation') ids.push(n.attrs.referenceId as string); }); return ids; };

// the deterministic checks of an answer (layer A); none of them needs the writer's word for anything
function checksOf(contract: ParagraphContract, paragraph: ReturnType<typeof buildParagraph>, original: ReturnType<typeof buildParagraph> | null, claimIds: string[]): Check[] {
  const text = blockText(paragraph);
  const checks: Check[] = [];
  if (contract.operation.mode === 'draft') {
    // every number from the contract's exact facts or approved claims (the AI does not bring results)
    const allowed = new Set(numbersIn([...contract.exact_facts.map((f) => f.text), ...contract.mandatory_claims.map((c) => c.text)].join('\n')));
    const stray = [...new Set(numbersIn(text).filter((n) => !allowed.has(n)))];
    if (stray.length) for (const n of stray) checks.push({ check: 'number_not_in_contract', result: 'fail', details: String(n) });
    else checks.push({ check: 'number_not_in_contract', result: 'pass' });
    const missing = contract.mandatory_claims.filter((c) => !claimIds.includes(c.id));
    if (missing.length) for (const c of missing) checks.push({ check: 'mandatory_claim', result: 'fail', details: c.id });
    else checks.push({ check: 'mandatory_claim', result: 'pass' });
    // a work the library knows as retracted is not cited by the writer (review MINOR 2)
    const bad = [...new Set(citedIn(paragraph).filter((id) => contract.citable_references.find((r) => r.reference_id === id)?.retracted))];
    if (bad.length) for (const id of bad) checks.push({ check: 'citation_retracted', result: 'fail', details: id });
    else checks.push({ check: 'citation_retracted', result: 'pass' });
  } else {
    const kids = (n: typeof paragraph) => { const out: (typeof paragraph)[] = []; n.forEach((c) => out.push(c)); return out; };
    checks.push(...(checkReplacement(kids(original!), kids(paragraph), contract.operation.mode === 'conservative' ? 'grammar' : 'rewrite') as Check[]));
  }
  const avoided = contract.style.terminology.flatMap((t) => t.avoid).filter((term) => new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(text));
  if (avoided.length) for (const t of avoided) checks.push({ check: 'avoided_term', result: 'fail', details: t });
  else checks.push({ check: 'avoided_term', result: 'pass' });
  return checks;
}

// MOCK: a deterministic paragraph from the contract only (its claims and facts), labelled as such;
// corrections only tidy spacing and the final full stop.
export function createMockWriter(): Writer {
  return {
    id: 'mock',
    label: 'MOCK',
    async write(c) {
      if (c.operation.mode !== 'draft') {
        // accepted review findings (PW-044) arrive as '- [category] "quote": reason → alternative'
        const swaps = [...c.instruction.matchAll(/^- \[[^\]]+\] "(.+?)": .*? → (.+)$/gm)].map((m) => [m[1]!, m[2]!] as const);
        const items = (c.operation.original ?? []).map((i) => (i.type === 'text' ? { ...i, text: swaps.reduce((t, [q, alt]) => t.replace(q, alt), i.text).replace(/\s{2,}/g, ' ') } : i));
        const last = items[items.length - 1];
        if (last?.type === 'text' && !/[.!?]\s*$/.test(last.text)) items[items.length - 1] = { ...last, text: `${last.text.trimEnd()}.` };
        return { status: 'draft', paragraph: items, claim_ids: [], fact_ids: [] };
      }
      if (!c.mandatory_claims.length && !c.exact_facts.length) return { status: 'needs_evidence', missing: ['[MOCK] 이 문단 계획에 승인된 주장이나 검증된 사실이 없습니다'] };
      const claims = c.mandatory_claims.map((x) => x.text.trim().replace(/[.!?]$/, '')).join('; ');
      const facts = c.exact_facts.map((f) => f.text.replace(/ · /g, ', ')).join('; ');
      const cite = c.citable_references.find((r) => r.linked_to_node);
      const paragraph: ParagraphItem[] = [{ type: 'text', text: `[MOCK] ${claims || c.purpose}${facts ? ` (${facts})` : ''}` }];
      if (cite) paragraph.push({ type: 'text', text: ' ' }, { type: 'citation', reference_id: cite.reference_id });
      paragraph.push({ type: 'text', text: '.' });
      return { status: 'draft', paragraph, claim_ids: c.mandatory_claims.map((x) => x.id), fact_ids: c.exact_facts.map((f) => f.id) };
    },
  };
}

export function writerHandlers(pool: TxPool, writer: Writer): Record<'draft_paragraph', JobHandler> {
  return {
    draft_paragraph: async (job) => {
      const p = payloadOf(job);
      // the gate again at run time: an approval or impact may have changed since the request
      let gate;
      try {
        gate = await checkDraftGate(pool, job.paper_id, { instruction: p.instruction.trim() || `${p.mode} paragraph`, node_id: p.node_id, outline_revision_id: p.outline_revision_id });
      } catch (e) {
        if (e instanceof DomainError) throw new JobOutcomeError(`draft gate: ${e.message} ${JSON.stringify(e.details)}`.slice(0, 1000), 'FAILED');
        throw e;
      }
      // a real provider sees paper material only where the paper allows it (spec 09); checked before reading
      if (writer.id !== 'mock') {
        const pp = (await pool.query<{ external_send_policy: string; data_classification: string; allowed_providers: string[] }>('SELECT external_send_policy, data_classification, allowed_providers FROM paper_projects WHERE id = $1', [job.paper_id])).rows[0]!;
        if (pp.data_classification === 'sensitive' || pp.external_send_policy !== 'allow_selected' || !pp.allowed_providers.includes(writer.id)) {
          throw new JobOutcomeError('this paper does not allow sending its material to this provider', 'WAITING_USER');
        }
      }
      const { contract, original } = await buildContract(pool, job, p, writer.id, gate.story_revision_id!);
      const contractHash = createHash('sha256').update(canonicalJson(contract)).digest('hex');
      let answer;
      let paragraph = null;
      try {
        answer = parseWriterAnswer(await writer.write(contract), contract);
        if (answer.status === 'draft') paragraph = buildParagraph(answer.paragraph, original);
      } catch (e) {
        if (e instanceof AnswerRefused || (e instanceof DomainError && e.code === 'INVALID')) throw new JobOutcomeError(`writer answer refused: ${e.message}`.slice(0, 1000), 'FAILED');
        throw e;
      }
      const base = {
        paper_id: job.paper_id, job_id: job.id, document_id: p.document_id, base_revision_id: p.base_revision_id, outline_revision_id: p.outline_revision_id, node_id: p.node_id,
        mode: p.mode, after_block_id: p.after_block_id, after_block_hash: p.after_block_hash, block_id: p.block_id, expected_block_hash: p.expected_block_hash, section_heading_id: p.section_heading_id, section_heading_hash: p.section_heading_hash, contract: contract as unknown as Record<string, unknown>, contract_hash: contractHash,
        generator: writer.id, generator_label: writer.label,
      };
      let row: Parameters<typeof insertParagraphProposalIn>[1];
      if (answer.status === 'needs_evidence') {
        row = { ...base, paragraph: null, missing: answer.missing, checks: [], warnings: [], claim_ids: [], fact_ids: [], status: 'NEEDS_EVIDENCE', status_reason: null };
      } else {
        const checks = checksOf(contract, paragraph!, original, answer.claim_ids);
        // the deterministic scientific gate (PW-043) on the contract's facts and claims: a failure blocks
        // applying; an unknown is shown and never counted as verified (citations are checked above)
        const gate = scientificGate({
          paragraph: paragraph!.toJSON(), facts: await gateFacts(pool, job.paper_id, contract.exact_facts.map((f) => f.id)),
          references: contract.citable_references.map((r) => ({ id: r.reference_id, label: r.label, retracted: r.retracted })),
          claims: contract.mandatory_claims, original: original ? original.toJSON() : null, skip: ['citation'],
        });
        for (const f of gate.findings) checks.push({ check: 'scientific', result: f.verdict, details: `${f.check}${f.reason ? `:${f.reason}` : ''}: ${f.text}`.slice(0, 300), finding: f });
        const warnings: string[] = [];
        const words = wordsIn(answer.paragraph);
        if (contract.target_length.max_words && words > contract.target_length.max_words) warnings.push('longer_than_target');
        if (contract.target_length.min_words && words < contract.target_length.min_words) warnings.push('shorter_than_target');
        // an enumerated list where prose is asked for (PW-045 SCI-018); Methods may enumerate
        if (p.mode === 'draft') warnings.push(...proseSignals(blockText(paragraph!), contract.section));
        // a citation none of the plan's evidence comes from: shown for the owner to judge (review MINOR 2)
        if (p.mode === 'draft' && citedIn(paragraph!).some((id) => !contract.citable_references.find((r) => r.reference_id === id)?.linked_to_node)) warnings.push('citation_not_linked_to_node');
        const unchanged = original && canonicalJson(original.toJSON()) === canonicalJson(paragraph!.toJSON());
        const failed = checks.filter((c) => c.result === 'fail');
        const json = paragraph!.toJSON() as Record<string, unknown>;
        row = {
          ...base, paragraph: unchanged ? null : { ...json, attrs: { id: null } }, missing: [], checks, warnings, claim_ids: answer.claim_ids, fact_ids: answer.fact_ids,
          status: unchanged ? 'NO_CHANGE' : failed.length ? 'CHECK_FAILED' : 'PENDING',
          status_reason: failed.length ? failed.map((c) => `${c.check}${c.details ? `: ${c.details}` : ''}`).join('; ').slice(0, 2000) : null,
        };
      }
      const result: Record<string, unknown> = { kind: 'paragraph_proposal', generator: writer.id, status: row.status };
      return {
        result,
        // stored only with the job's completion (fenced): a cancelled or taken-over run leaves nothing
        apply: async (tx) => {
          const head = (await tx.query<{ head_revision_id: string }>('SELECT head_revision_id FROM documents WHERE paper_id = $1 AND id = $2', [job.paper_id, p.document_id])).rows[0]!.head_revision_id;
          // a late answer whose own place changed meanwhile is kept, but STALE (edits elsewhere do not count)
          const late = head !== p.base_revision_id && ['PENDING', 'CHECK_FAILED'].includes(row.status) && !(await placeHolds((await documentAt(tx, job.paper_id, p.document_id, head))!, row));
          const stored = await insertParagraphProposalIn(tx, late ? { ...row, status: 'STALE', status_reason: 'the manuscript changed while the paragraph was written' } : row);
          result.proposal_id = stored.id;
          result.status = stored.status;
        },
      };
    },
  };
}
