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
const NEGATION = /\b(not|no|never|neither|nor|none|without|absence|absent)\b|n't\b/i;
const DECREASE = /\b(decrease[sd]?|lower|reduced|down-?regulated|diminished|fell|fall(?:s|en|ing)?|dropped|declined?|fewer|less (?:often|frequent(?:ly)?|likely))\b/i;
const INCREASE = /\b(increase[sd]?|higher|greater|elevated|up-?regulated|enhanced|rose|more (?:often|frequent(?:ly)?|likely))\b/i;
const NULL_SPIN = /\b(tend(?:ed|s)? to|trend(?:ed|ing)?|marginal(?:ly)?|approach(?:ed|ing) significance)\b/i;
// verb uses only: "well-watered controls" (noun) must not match
const CAUSAL = /\b(prove[sn]?|proving|establish(?:es|ed|ing)?|demonstrat(?:e|es|ed) that|controls?\s+(?:the\s+)?(?:drought|growth|tolerance|expression|response)|causes?|caused|master regulator|required for|essential for|necessary for|confers?|directly regulat(?:e|es|ed)|drives?)\b/i;
const CITABLE_DEPTHS = new Set(['FULLTEXT_PARSED', 'SOURCE_CHECKED']);

// For facts with labelled groups: the i-th group label mentioned must be paired with that group's value.
function groupBindingErrors(caseId, text, fact) {
  if (!fact.groups || fact.groups.length < 2) return [];
  // earliest mention of each group by label or alias (whole words; short aliases are case-sensitive)
  const firstMention = (g) => {
    let best = -1;
    for (const name of [g.label, ...(g.aliases || [])]) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp(`(?<![\\w-])${esc}(?![\\w-])`, name.length <= 3 ? '' : 'i').exec(text);
      if (m && (best < 0 || m.index < best)) best = m.index;
    }
    return best;
  };
  const labels = fact.groups.map((g) => ({ g, at: firstMention(g) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at);
  const tokens = resultNumbers(text).map(normalize);
  const values = fact.groups.map((g) => ({ g, at: tokens.indexOf(normalize(String(g.value))) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at);
  if (labels.length < 2 || values.length < 2) return [];
  return labels.some((l, i) => values[i] && values[i].g !== l.g)
    ? [`${caseId}: group values are attached to the wrong groups for ${fact.id}`]
    : [];
}

export function validateBaseline({ papers, cases, sciMap }) {
  const errors = [];
  const paperById = new Map(papers.map((p) => [p.id, p]));
  const articleTypes = new Set();

  for (const paper of papers) {
    if (paper.synthetic !== true) errors.push(`${paper.id}: fixture must be marked synthetic`);
    articleTypes.add(paper.article_type);
    for (const fact of paper.facts) {
      for (const g of fact.groups || []) {
        const m = /^(\d+)\/(\d+)$/.exec(g.count || '');
        if (m && Math.abs((Number(m[1]) / Number(m[2])) * 100 - g.value) > 0.05) errors.push(`${fact.id}: group ${g.label} value ${g.value}% inconsistent with count ${g.count}`);
        if (m && fact.n && Number(m[2]) !== fact.n) errors.push(`${fact.id}: group ${g.label} denominator ${m[2]} inconsistent with n ${fact.n}`);
      }
      if (fact.source_locator?.startsWith('ev-') && !paper.evidence.some((e) => e.id === fact.source_locator)) errors.push(`${fact.id}: unknown evidence ${fact.source_locator}`);
    }
    const claimIds = new Set(paper.claims.map((c) => c.id));
    const evidenceIds = new Set(paper.evidence.map((e) => e.id));
    for (const node of paper.outline.nodes) {
      if (!paper.outline.sections.includes(node.section)) errors.push(`${paper.id}/${node.id}: unknown section ${node.section}`);
      for (const c of node.claim_ids) if (!claimIds.has(c)) errors.push(`${paper.id}/${node.id}: unknown claim ${c}`);
      for (const e of node.evidence_ids) if (!evidenceIds.has(e)) errors.push(`${paper.id}/${node.id}: unknown evidence ${e}`);
    }
    for (const ref of paper.references) {
      if (!DEPTHS.includes(ref.source_depth)) errors.push(`${ref.id}: invalid source_depth ${ref.source_depth}`);
      if (ref.source_depth === 'METADATA_ONLY' && (ref.sections_read || []).length) errors.push(`${ref.id}: METADATA_ONLY reference cannot have sections_read`);
      if (ref.source_depth === 'ABSTRACT_ONLY' && (ref.sections_read || []).some((x) => x !== 'Abstract')) errors.push(`${ref.id}: ABSTRACT_ONLY reference can only have read the Abstract`);
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
    const refById = new Map(paper.references.map((r) => [r.id, r]));
    for (const m of c.text.matchAll(/\[@([^\]\s;]+)\]/g)) {
      const ref = refById.get(m[1]);
      if (!ref) { errors.push(`${c.id}: cites ${m[1]}, which is not in the library`); continue; }
      if (ref.status === 'retracted') errors.push(`${c.id}: cites retracted reference ${ref.id}`);
      if (!CITABLE_DEPTHS.has(ref.source_depth)) errors.push(`${c.id}: cites ${ref.id} read only to ${ref.source_depth}; gold claims need full-text support`);
      if (!['scientific', 'both'].includes(ref.use_role)) errors.push(`${c.id}: cites ${ref.id}, a ${ref.use_role}-only reference, as scientific support`);
    }
    for (const fid of c.fact_ids) {
      const fact = factById.get(fid);
      if (!fact) continue;
      errors.push(...groupBindingErrors(c.id, c.text, fact));
      if (fact.direction === 'none' && !NEGATION.test(c.text)) errors.push(`${c.id}: ${fid} is a null result but the text states an effect`);
      if (fact.direction === 'none' && NULL_SPIN.test(c.text)) errors.push(`${c.id}: ${fid} is a null result but the text spins it as a trend ("${c.text.match(NULL_SPIN)[0]}")`);
      if (fact.direction === 'increase' && DECREASE.test(c.text) && !INCREASE.test(c.text)) errors.push(`${c.id}: ${fid} is an increase but the text states a decrease`);
      if (fact.direction === 'decrease' && INCREASE.test(c.text) && !DECREASE.test(c.text)) errors.push(`${c.id}: ${fid} is a decrease but the text states an increase`);
    }
    // stated p and n must be the declared facts' own values, not any number that appears in a fact
    const declared = c.fact_ids.map((fid) => factById.get(fid)).filter(Boolean);
    const ps = new Set(declared.map((f) => f.statistic?.p).filter((v) => v !== undefined).map((v) => normalize(String(v))));
    const ns = new Set(declared.map((f) => f.n).filter((v) => v !== null && v !== undefined).map(String));
    for (const m of c.text.matchAll(/\bp\s*[=<>≤≥]\s*(\d*\.?\d+)/gi)) if (!ps.has(normalize(m[1]))) errors.push(`${c.id}: states p = ${m[1]}, declared facts have p ${[...ps].join(', ') || 'none'}`);
    for (const m of c.text.matchAll(/\bn\s*=\s*(\d+)/gi)) if (!ns.has(m[1])) errors.push(`${c.id}: states n = ${m[1]}, declared facts have n ${[...ns].join(', ') || 'none'}`);
    const node = paper.outline.nodes.find((n) => n.id === c.outline_node_id);
    if (node && !/causal/i.test(node.allowed_interpretation) && CAUSAL.test(c.text)) errors.push(`${c.id}: causal/proof language ("${c.text.match(CAUSAL)[0]}") exceeds the node's allowed interpretation (${node.allowed_interpretation})`);
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
