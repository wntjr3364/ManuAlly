// PW-005: validates the synthetic writing baseline so that the gold set cannot contain
// results, references or reading depth that do not exist. It does not judge prose quality.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', f), 'utf8'));

export const REQUIRED_CATEGORIES = ['numbers', 'negation', 'citation', 'verbosity', 'report_style', 'claim_strength', 'invented_detail'];
const EXPECTED = new Set(['ALLOW', 'BLOCK', 'WARN', 'NEEDS_EVIDENCE']);
const DEPTHS = ['METADATA_ONLY', 'ABSTRACT_ONLY', 'FULLTEXT_PARTIAL', 'FULLTEXT_PARSED', 'SOURCE_CHECKED'];
const STYLE_DEPTHS = new Set(['FULLTEXT_PARSED', 'SOURCE_CHECKED']);

export function loadBaseline() {
  return {
    papers: [read('paper-bio.json'), read('paper-software.json')],
    cases: read('paragraph-cases.json').cases,
    sciMap: read('sci-map.json'),
  };
}

// Numbers that state results. Figure/table labels and digits inside identifiers (ABC1, S1) are not results.
export function resultNumbers(text) {
  const cleaned = text.replace(/\b(?:Figure|Fig\.|Table|Supplementary Table)\s+S?\d+[A-Za-z]?/g, ' ');
  return [...cleaned.matchAll(/(?<![A-Za-z0-9.])\d+(?:\.\d+)*/g)].map((m) => m[0]);
}

function numbersInValue(value, out = new Set()) {
  if (value === null || value === undefined) return out;
  if (typeof value === 'number') out.add(String(value));
  else if (typeof value === 'string') for (const n of resultNumbers(value)) out.add(n);
  else if (Array.isArray(value)) value.forEach((v) => numbersInValue(v, out));
  else if (typeof value === 'object') Object.values(value).forEach((v) => numbersInValue(v, out));
  return out;
}

const normalize = (n) => (n.split('.').length === 2 ? String(Number(n)) : n);

export function validateBaseline({ papers, cases, sciMap }) {
  const errors = [];
  const paperById = new Map(papers.map((p) => [p.id, p]));
  const articleTypes = new Set();

  for (const paper of papers) {
    if (paper.synthetic !== true) errors.push(`${paper.id}: fixture must be marked synthetic`);
    articleTypes.add(paper.article_type);
    const claimIds = new Set(paper.claims.map((c) => c.id));
    const evidenceIds = new Set(paper.evidence.map((e) => e.id));
    for (const node of paper.outline.nodes) {
      if (!paper.outline.sections.includes(node.section)) errors.push(`${paper.id}/${node.id}: unknown section ${node.section}`);
      for (const c of node.claim_ids) if (!claimIds.has(c)) errors.push(`${paper.id}/${node.id}: unknown claim ${c}`);
      for (const e of node.evidence_ids) if (!evidenceIds.has(e)) errors.push(`${paper.id}/${node.id}: unknown evidence ${e}`);
    }
    for (const ref of paper.references) {
      if (!DEPTHS.includes(ref.source_depth)) errors.push(`${ref.id}: invalid source_depth ${ref.source_depth}`);
      if (ref.style_verification === 'fulltext_style_verified') {
        if (!STYLE_DEPTHS.has(ref.source_depth)) errors.push(`${ref.id}: style verification requires full text, but source_depth is ${ref.source_depth}`);
        if (!ref.style_sections?.length) errors.push(`${ref.id}: style verification without any analysed section`);
        for (const s of ref.style_sections || []) if (!(ref.sections_read || []).includes(s)) errors.push(`${ref.id}: style claimed for ${s}, but ${s} was not read`);
      } else if (ref.style_verification !== 'none') {
        errors.push(`${ref.id}: invalid style_verification ${ref.style_verification}`);
      }
    }
  }
  if (articleTypes.size < 2) errors.push('baseline must cover at least two article types');

  const seen = new Set();
  for (const c of cases) {
    if (seen.has(c.id)) errors.push(`${c.id}: duplicate case id`);
    seen.add(c.id);
    const paper = paperById.get(c.paper_id);
    if (!paper) { errors.push(`${c.id}: unknown paper ${c.paper_id}`); continue; }
    if (!EXPECTED.has(c.expected)) errors.push(`${c.id}: invalid expected ${c.expected}`);
    if (!REQUIRED_CATEGORIES.includes(c.category)) errors.push(`${c.id}: unknown category ${c.category}`);
    if (!paper.outline.nodes.some((n) => n.id === c.outline_node_id)) errors.push(`${c.id}: unknown outline node ${c.outline_node_id}`);
    if (!c.reason) errors.push(`${c.id}: missing reason`);
    if (c.expected !== 'ALLOW') continue;

    // Gold paragraphs: every fact must exist and be verified; every citation must exist;
    // every result number must come from the declared verified facts.
    const factById = new Map(paper.facts.map((f) => [f.id, f]));
    const allowed = new Set();
    for (const fid of c.fact_ids) {
      const fact = factById.get(fid);
      if (!fact) { errors.push(`${c.id}: unknown fact ${fid}`); continue; }
      if (fact.verification_state !== 'verified') errors.push(`${c.id}: fact ${fid} is ${fact.verification_state}, gold text needs verified facts`);
      for (const n of numbersInValue(fact)) allowed.add(normalize(n));
    }
    const refIds = new Set(paper.references.map((r) => r.id));
    for (const m of c.text.matchAll(/\[@([^\]\s;]+)\]/g)) if (!refIds.has(m[1])) errors.push(`${c.id}: cites ${m[1]}, which is not in the library`);
    for (const n of resultNumbers(c.text.replace(/\[@[^\]]+\]/g, ''))) {
      if (!allowed.has(normalize(n))) errors.push(`${c.id}: gold text states ${n}, which no declared verified fact contains`);
    }
  }

  for (const [sci, cat] of Object.entries(sciMap)) {
    if (!REQUIRED_CATEGORIES.includes(cat) && cat !== 'other') errors.push(`${sci}: unknown category ${cat}`);
  }
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const errors = validateBaseline(loadBaseline());
  console.log(JSON.stringify({ status: errors.length ? 'FAIL' : 'PASS', errors }, null, 2));
  process.exitCode = errors.length ? 1 : 0;
}
