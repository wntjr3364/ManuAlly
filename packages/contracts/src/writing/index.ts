// ParagraphContract and the Writer's answer (PW-042, spec 06 "ParagraphContract"). The contract is what
// a writer (a provider or the MOCK) receives for one paragraph: the approved story/outline/node, its
// purpose, the approved claims it must carry, the exact verified facts, the evidence, the neighbouring
// plans and text, the profile's terminology and style, the target length, the operation and its place
// in the manuscript, and the references it may cite. The answer is one paragraph or "needs evidence".
// Everything here is pure: the server builds the contract and runs the checks that need the database.

export const CONTRACT_VERSION = 'pw-paragraph-contract-1';
export type WriterMode = 'draft' | 'conservative' | 'rewrite';
export const WRITER_MODES: readonly WriterMode[] = ['draft', 'conservative', 'rewrite'];

export type ParagraphItem =
  | { type: 'text'; text: string; marks?: ('bold' | 'italic' | 'subscript' | 'superscript')[] }
  | { type: 'citation'; reference_id: string; locator?: string | null }
  | { type: 'preserve_atom'; atom_index: number };

export interface NeighbourPlan { node_id: string; section: string; role: string; paragraph_goal: string; transition: string }
export interface ParagraphContract {
  contract_version: typeof CONTRACT_VERSION;
  paper_id: string;
  story_revision_id: string;
  outline_revision_id: string;
  node_id: string;
  section: string;
  role: string;
  purpose: string;
  allowed_interpretation: string;
  prohibited_inferences: string[];
  transition: string;
  mandatory_claims: { id: string; kind: string; text: string }[];
  exact_facts: { id: string; evidence_id: string; text: string }[];
  evidence: { id: string; kind: string; label: string; locator: unknown }[];
  // what the gates kept out, and why (the writer may say evidence is missing; it may not use these)
  excluded: { kind: string; id: string; reason: string }[];
  context: { previous: NeighbourPlan | null; next: NeighbourPlan | null; preceding_text: string; following_text: string };
  style: {
    profile_revision_id: string | null; english_variant: string; concision: string; claim_strength_policy: string;
    terminology: { term: string; preferred: string; avoid: string[]; note: string }[];
    section_principles: string[]; section_counterexamples: string[]; journal_rule: string | null;
  };
  target_length: { min_words: number | null; max_words: number | null };
  operation: { mode: WriterMode; document_id: string; base_revision_id: string; after_block_id: string | null; block_id: string | null; original: ParagraphItem[] | null };
  // this paper's references (RFC-008); retracted ones are listed so the writer knows, but citing one fails a check
  citable_references: { reference_id: string; label: string; linked_to_node: boolean; retracted: boolean }[];
  citable_references_truncated: boolean;
  instruction: string;
  transmission: { provider: string; withheld: number };
}

export type WriterAnswer =
  | { status: 'draft'; paragraph: ParagraphItem[]; claim_ids: string[]; fact_ids: string[]; note: string | null }
  | { status: 'needs_evidence'; missing: string[]; note: string | null };

// Why an answer is refused as a whole (nothing is stored).
export type RefusalReason = 'malformed' | 'unknown fields' | 'claim_not_in_contract' | 'fact_not_in_contract' | 'citation_not_in_paper' | 'bibliography_string' | 'bad_locator' | 'scope_exceeded';
export class AnswerRefused extends Error {
  readonly reason: RefusalReason;
  constructor(reason: RefusalReason, message: string) {
    super(`${reason}: ${message}`);
    this.reason = reason;
  }
}

// Bibliography written as text instead of a citation of a reference (RFC-008): author–year, numbered
// brackets, DOIs. Heuristic, on the safe side for scientific prose.
const BIBLIOGRAPHY: RegExp[] = [
  /\(\s*[\p{Lu}][\p{L}'’-]+(?:\s+et\s+al\.?|\s+(?:and|&)\s+[\p{Lu}][\p{L}'’-]+)?,?\s+(?:19|20)\d{2}[a-z]?\s*[;)]/u,
  /\b[\p{Lu}][\p{L}'’-]+\s+et\s+al\.?,?\s*\(?(?:19|20)\d{2}/u,
  /\b[\p{Lu}][\p{L}'’-]+\s+(?:and|&)\s+[\p{Lu}][\p{L}'’-]+\s*\((?:19|20)\d{2}[a-z]?\)/u,
  /\[\s*\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\s*\]/,
  /\bdoi\s*:/i,
  /\b10\.\d{4,9}\/\S+/,
];
export const bibliographyString = (text: string) => BIBLIOGRAPHY.some((re) => re.test(text));
// A citation locator a writer may add: a page, figure, table, supplement, section, chapter or equation
// label with a short number (review MINOR 1: never free text, which the number and bibliography checks
// would not see).
const LOCATOR = /^(?:pp?\.|figs?\.|figures?|tables?|suppl\.|supplementary|sect\.|sections?|ch\.|chapter|eqs?\.|para\.)\s*[A-Z]?\d{1,4}[A-Za-z]?(?:\s*[-–,]\s*[A-Z]?\d{1,4}[A-Za-z]?)?$/i;
export const writerLocator = (v: string) => v.length <= 30 && LOCATOR.test(v.trim());

export const wordsIn = (items: ParagraphItem[]) => items.filter((i) => i.type === 'text').map((i) => (i as { text: string }).text).join(' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
// A paragraph request never becomes a manuscript: one block of prose, at most about twice its budget.
export const hardWordCap = (c: ParagraphContract) => (c.target_length.max_words ? Math.max(2 * c.target_length.max_words, c.target_length.max_words + 40) : 300);

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AnswerRefused('malformed', `${what} must be an object`);
  return v as Record<string, unknown>;
};
const only = (o: Record<string, unknown>, keys: string[], what: string) => {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) throw new AnswerRefused('unknown fields', `${what}: ${extra.join(', ')}`);
};
const ids = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== 'string')) throw new AnswerRefused('malformed', `${what} must be a list of ids`);
  return [...new Set((v as string[]).map((x) => x.toLowerCase()))];
};
const note = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > 1000) throw new AnswerRefused('malformed', 'note must be text up to 1000 characters');
  return v;
};

// Strict reading of an answer against its contract. Shape, ids, citations, bibliography strings and
// scope are refusals; the other checks (numbers, claims, terms, original preservation) make a proposal
// that is shown but cannot be applied.
export function parseWriterAnswer(raw: unknown, c: ParagraphContract): WriterAnswer {
  const o = obj(raw, 'answer');
  if (o.status === 'needs_evidence') {
    only(o, ['status', 'missing', 'note'], 'answer');
    if (!Array.isArray(o.missing) || o.missing.length < 1 || o.missing.length > 10 || o.missing.some((m) => typeof m !== 'string' || !m.trim() || m.length > 300)) {
      throw new AnswerRefused('malformed', 'missing must list 1–10 things, each up to 300 characters');
    }
    return { status: 'needs_evidence', missing: (o.missing as string[]).map((m) => m.trim()), note: note(o.note) };
  }
  if (o.status !== 'draft') throw new AnswerRefused('malformed', 'status must be "draft" or "needs_evidence"');
  only(o, ['status', 'paragraph', 'claim_ids', 'fact_ids', 'note'], 'answer');
  if (!Array.isArray(o.paragraph) || o.paragraph.length < 1 || o.paragraph.length > 200) throw new AnswerRefused('malformed', 'paragraph must be a list of 1–200 items');
  const claims = new Set(c.mandatory_claims.map((x) => x.id));
  const facts = new Set(c.exact_facts.map((x) => x.id));
  const claim_ids = ids(o.claim_ids ?? [], 'claim_ids');
  const fact_ids = ids(o.fact_ids ?? [], 'fact_ids');
  for (const id of claim_ids) if (!claims.has(id)) throw new AnswerRefused('claim_not_in_contract', id);
  for (const id of fact_ids) if (!facts.has(id)) throw new AnswerRefused('fact_not_in_contract', id);
  const citable = new Set(c.citable_references.map((r) => r.reference_id));
  const paragraph = o.paragraph.map((raw, i): ParagraphItem => {
    const it = obj(raw, `paragraph[${i}]`);
    if (it.type === 'text') {
      only(it, ['type', 'text', 'marks'], `paragraph[${i}]`);
      if (typeof it.text !== 'string' || !it.text) throw new AnswerRefused('malformed', `paragraph[${i}].text must be text`);
      // one paragraph: no line breaks, no headings
      if (/[\n\r\u2028\u2029]/.test(it.text) || /^\s*#{1,6}\s/.test(it.text)) throw new AnswerRefused('scope_exceeded', 'the answer must be one paragraph (no line breaks or headings)');
      if (bibliographyString(it.text)) throw new AnswerRefused('bibliography_string', 'cite with a reference of this paper, not with written author–year, numbers or DOIs');
      return it as ParagraphItem;
    }
    if (it.type === 'citation') {
      only(it, ['type', 'reference_id', 'locator'], `paragraph[${i}]`);
      if (typeof it.reference_id !== 'string' || !citable.has(it.reference_id.toLowerCase())) throw new AnswerRefused('citation_not_in_paper', String(it.reference_id));
      // a locator is a short label; one the original paragraph already had for that reference is kept as is
      if (it.locator !== undefined && it.locator !== null) {
        const kept = (c.operation.original ?? []).some((o) => o.type === 'citation' && o.reference_id === (it.reference_id as string).toLowerCase() && o.locator === it.locator);
        if (typeof it.locator !== 'string' || (!kept && !writerLocator(it.locator))) throw new AnswerRefused('bad_locator', 'a citation locator is a page, figure, table or section label such as "p. 12" or "Fig. 2A"');
      }
      return { ...(it as { type: 'citation'; reference_id: string; locator?: string | null }), reference_id: it.reference_id.toLowerCase() };
    }
    if (it.type === 'preserve_atom') {
      if (c.operation.mode === 'draft') throw new AnswerRefused('malformed', 'a new paragraph has no atoms to preserve');
      return it as ParagraphItem;
    }
    throw new AnswerRefused('malformed', `paragraph[${i}] has an unknown type`);
  });
  if (wordsIn(paragraph) > hardWordCap(c)) throw new AnswerRefused('scope_exceeded', `the answer is ${wordsIn(paragraph)} words; this paragraph allows at most ${hardWordCap(c)}`);
  return { status: 'draft', paragraph, claim_ids, fact_ids, note: note(o.note) };
}
