// PW-045 — runs the synthetic scientific hard cases (evals/SCIENTIFIC_CASES.json) through the product's
// own deterministic layers and records, for each case, what the product did:
// - gate:    the PW-043 scientific gate on the text (FAILED → BLOCK, UNKNOWN → NEEDS_EVIDENCE, else ALLOW)
// - writer:  the PW-042 answer reader (refused → BLOCK)
// - guard:   the PW-017 proposal guard against the original (a failed check → BLOCK)
// - profile: the PW-041 source check (a rule from an unread section is not stored → NEEDS_EVIDENCE)
// - copy:    the PW-041 copied-wording check (→ WARN, a similarity warning, not a plagiarism verdict)
// - prose:   the prose signals a Writer proposal carries as warnings (→ WARN)
// - not_deterministic: no deterministic layer decides it; reported as not_run with who decides.
// A result is "match", a "known_deviation" declared in the case (only ever stricter), "stricter"
// (undeclared but safe: needs review of the fixture), or "unsafe" (the product allowed more than the
// case expects) — the last is a failure of the suite.
import fs from 'node:fs';
import path from 'node:path';
import { schema } from '../../packages/editor-core/src/index.ts';
import { proseSignals, scientificGate, type GateClaim, type GateFact, type GateReference } from '../../packages/domain/src/scientific-checks/index.ts';
import { checkAgainstSources, copies, copyIndex, type ProfileContent, type ReadSource, type SectionName } from '../../packages/domain/src/writing-profile/index.ts';
import { checkReplacement } from '../../packages/domain/src/proposals/guard.ts';
import { AnswerRefused, parseWriterAnswer, type ParagraphContract } from '../../packages/contracts/src/writing/index.ts';
import { numbersIn } from '../../apps/worker/src/story/index.ts';

export type Expected = 'ALLOW' | 'WARN' | 'NEEDS_EVIDENCE' | 'BLOCK';
export const STRICTNESS: Record<Expected, number> = { ALLOW: 0, WARN: 1, NEEDS_EVIDENCE: 2, BLOCK: 3 };
interface ProfileSource { reference_id: string; read_depth: ReadSource['read_depth']; sections_read: ReadSource['sections_read']; text: string }
export interface RunSpec {
  layer: string; text?: string; cite?: string; facts?: (Partial<GateFact> & { id: string })[]; references?: GateReference[]; claims?: GateClaim[];
  mode?: string; answer?: unknown; intent?: 'grammar' | 'concise' | 'rewrite'; before?: unknown[]; after?: unknown[];
  sources?: (ProfileSource | string)[]; rule?: { section: SectionName; text: string; source_section: SectionName }; section?: string; reason?: string; decided_by?: string;
}
export interface HardCase { id: string; name: string; candidate: string; expected: Expected; run: RunSpec; known_deviation?: { actual: Expected; rationale: string } }
export interface CaseResult {
  id: string; name: string; layer: string; expected: Expected; actual: Expected | null;
  status: 'match' | 'known_deviation' | 'stricter' | 'unsafe' | 'not_run'; detail: string;
  // the candidate as an AI proposal: whether the owner could still apply it, and which layer stops it
  // (a gate UNKNOWN is shown but does not stop an AI proposal; review NIT)
  applicable_as_ai_proposal: boolean | null; stopped_by: string | null;
}

export const loadCases = (file = path.resolve('evals/SCIENTIFIC_CASES.json')) => JSON.parse(fs.readFileSync(file, 'utf8')) as { synthetic: boolean; status: string; cases: HardCase[] };

const fact = (f: Partial<GateFact> & { id: string }): GateFact => ({ evidence_id: `e-${f.id}`, evidence_label: `evidence ${f.id}`, locator: null, entity: '', metric: '', value_text: '', unit: '', group_label: '', comparison: '', n: null, statistics: [], ...f });

// the Writer's own number check (PW-042): every number of an AI paragraph from the contract's facts and claims
const factText = (f: Partial<GateFact>) => `${f.entity} · ${f.metric} = ${f.value_text}${f.unit ? ` ${f.unit}` : ''}${f.n ? `; n=${f.n}` : ''}${(f.statistics ?? []).map((x) => `; ${x.kind}=${x.value_text}`).join('')}`;
const strayNumbers = (text: string, facts: Partial<GateFact>[], claims: GateClaim[]) => {
  const allowed = new Set(numbersIn([...facts.map(factText), ...claims.map((c) => c.text)].join('\n')));
  return [...new Set(numbersIn(text).filter((n) => !allowed.has(n)))];
};

function decide(c: HardCase): { actual: Expected | null; detail: string; applicable: boolean | null; stoppedBy: string | null } {
  const r = c.run;
  switch (r.layer) {
    case 'gate': {
      const content: unknown[] = [{ type: 'text', text: r.text! }];
      if (r.cite) content.push({ type: 'citation', attrs: { referenceId: r.cite, locator: null } });
      const g = scientificGate({ paragraph: { content: content as never }, facts: (r.facts ?? []).map(fact), references: r.references ?? [], claims: r.claims ?? [] });
      const stray = strayNumbers(r.text!, r.facts ?? [], r.claims ?? []);
      const fromGate: Expected = g.status === 'FAILED' ? 'BLOCK' : g.status === 'UNKNOWN' ? 'NEEDS_EVIDENCE' : 'ALLOW';
      // an AI candidate meets both the gate and the Writer's number check: the stricter decides
      const actual: Expected = stray.length && STRICTNESS[fromGate] < STRICTNESS.NEEDS_EVIDENCE ? 'NEEDS_EVIDENCE' : fromGate;
      const detail = [g.findings.filter((f) => f.verdict !== 'pass').map((f) => `${f.check}:${f.verdict}:${f.reason ?? ''}`).join(', ') || g.status, stray.length ? `numbers not in the contract: ${stray.join(', ')}` : ''].filter(Boolean).join('; ');
      const stoppedBy = g.status === 'FAILED' ? 'scientific gate (PW-043)' : stray.length ? 'Writer number check (PW-042)' : null;
      return { actual, detail, applicable: !stoppedBy, stoppedBy };
    }
    case 'writer': {
      const contract = { mandatory_claims: [], exact_facts: [], citable_references: [], target_length: { min_words: null, max_words: 80 }, operation: { mode: r.mode, document_id: '', base_revision_id: '', after_block_id: null, block_id: null, original: null } } as unknown as ParagraphContract;
      try {
        parseWriterAnswer(r.answer, contract);
        return { actual: 'ALLOW', detail: 'answer accepted', applicable: true, stoppedBy: null };
      } catch (e) {
        if (e instanceof AnswerRefused) return { actual: 'BLOCK', detail: e.message, applicable: false, stoppedBy: 'Writer answer reader (PW-042)' };
        throw e;
      }
    }
    case 'guard': {
      const nodes = (items: unknown[]) => schema.nodeFromJSON({ type: 'paragraph', attrs: { id: null }, content: items });
      const kids = (n: ReturnType<typeof nodes>) => { const out: (typeof n)[] = []; n.forEach((x) => out.push(x)); return out; };
      const checks = checkReplacement(kids(nodes(r.before!)), kids(nodes(r.after!)), r.intent!);
      const failed = checks.filter((x) => x.result === 'fail');
      return { actual: failed.length ? 'BLOCK' : 'ALLOW', detail: failed.map((x) => x.check).join(', ') || 'all checks pass', applicable: !failed.length, stoppedBy: failed.length ? 'proposal guard (PW-017)' : null };
    }
    case 'profile': {
      const sources: ReadSource[] = (r.sources as ProfileSource[]).map((s) => ({ reference_id: s.reference_id, title: '', read_depth: s.read_depth, sections_read: s.sections_read, withheld: null, asset_revision_id: null, sha256: null, extractor: null, sections: s.sections_read.map((x) => ({ section: x, text: s.text })) }));
      const content: ProfileContent = {
        article_type: 'research_article', target_audience: '', preferred_english_variant: 'unspecified', concision_preference: 'concise', claim_strength_policy: '', terminology: [],
        section_roles: [{ section: r.rule!.section, role: 'interpret', principles: [{ text: r.rule!.text, sources: [{ reference_id: sources[0]!.reference_id, section: r.rule!.source_section }] }], counterexamples: [] }],
        rhetoric_patterns: [], anti_examples: [], accepted_examples: [],
      };
      const out = checkAgainstSources(content, sources, { requireSource: true });
      return out.removed.length ? { actual: 'NEEDS_EVIDENCE', detail: out.removed.map((x) => x.reason).join(', '), applicable: false, stoppedBy: 'profile source check (PW-041)' } : { actual: 'ALLOW', detail: 'rule kept', applicable: true, stoppedBy: null };
    }
    case 'copy':
      return copies(r.text!, copyIndex(r.sources as string[])) ? { actual: 'WARN', detail: 'copied_from_source', applicable: true, stoppedBy: null } : { actual: 'ALLOW', detail: 'no copied run', applicable: true, stoppedBy: null };
    case 'prose': {
      const w = proseSignals(r.text!, r.section ?? null);
      return { actual: w.length ? 'WARN' : 'ALLOW', detail: w.join(', ') || 'no signal', applicable: true, stoppedBy: null };
    }
    case 'not_deterministic':
      return { actual: null, detail: `not_run: ${r.reason} — decided by ${r.decided_by}`, applicable: null, stoppedBy: null };
    default:
      throw new Error(`${c.id}: unknown layer ${r.layer}`);
  }
}

export function runCase(c: HardCase): CaseResult {
  const { actual, detail, applicable, stoppedBy } = decide(c);
  const base = { id: c.id, name: c.name, layer: c.run.layer, expected: c.expected, actual, detail, applicable_as_ai_proposal: applicable, stopped_by: stoppedBy };
  if (actual === null) return { ...base, status: 'not_run' };
  if (actual === c.expected) return { ...base, status: 'match' };
  if (STRICTNESS[actual] < STRICTNESS[c.expected]) return { ...base, status: 'unsafe' };
  if (c.known_deviation && c.known_deviation.actual === actual) return { ...base, status: 'known_deviation' };
  return { ...base, status: 'stricter' };
}

export function runSuite(cases = loadCases().cases) {
  const results = cases.map(runCase);
  const count = (s: CaseResult['status']) => results.filter((r) => r.status === s).length;
  return {
    results,
    summary: { total: results.length, match: count('match'), known_deviation: count('known_deviation'), stricter: count('stricter'), unsafe: count('unsafe'), not_run: count('not_run') },
  };
}
