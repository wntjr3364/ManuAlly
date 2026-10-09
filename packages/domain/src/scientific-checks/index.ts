// The deterministic scientific gate (PW-043, spec 06 "검증 층" A). It reads one paragraph and checks,
// without any model, what it states against the paper's records:
// - every quantity against the verified facts: the same value, the same unit, the right group (not
//   the comparison group), and — when several facts share the value — the one the sentence names;
// - every p/q statement against the fact's statistics (a q-value written as p, or the reverse, fails;
//   a threshold must hold), every "n =" against the fact's n;
// - every citation against the paper's references (missing or retracted fails);
// - protected atoms (math, figure references) against the original paragraph, when there is one;
// - every given approved claim: the sentence stating it keeps its negation and direction.
// A finding is pass (with the fact or reference and its evidence locator), fail (with the reason) or
// unknown. Anything it cannot map exactly — no fact with that value, a rounded value, a missing unit,
// an unstated group, two facts it cannot tell apart — is unknown, never verified (spec 06 A: "정확한
// mapping이 불가능하면 UNKNOWN이지 통과 아님"). English-centred heuristics; the limits are in the report.

export const GATE_VERSION = 'pw-sci-gate-1';

export interface GateFact {
  id: string; evidence_id: string; evidence_label: string; locator: unknown;
  entity: string; metric: string; value_text: string; unit: string; group_label: string; comparison: string; n: number | null;
  statistics: { kind: string; value_text: string }[];
}
export interface GateReference { id: string; label: string; retracted: boolean }
export interface GateClaim { id: string; text: string }
type Inline = { type: string; text?: string; attrs?: Record<string, unknown> };
export interface GateInput {
  paragraph: { content?: Inline[] };
  facts: GateFact[];
  references: GateReference[];
  claims: GateClaim[];
  // the paragraph before an edit: its protected atoms must be kept
  original?: { content?: Inline[] } | null;
  // checks a caller already runs itself
  skip?: 'citation'[];
}
export type Verdict = 'pass' | 'fail' | 'unknown';
export interface Finding {
  check: 'quantity' | 'statistic' | 'sample_size' | 'citation' | 'protected_span' | 'claim';
  verdict: Verdict; text: string; reason?: string;
  fact_id?: string; evidence_id?: string; evidence_label?: string; locator?: unknown; candidates?: string[]; statistic?: string;
  reference_id?: string; label?: string; claim_id?: string;
  // written as approximate ("~2.4", "about 2.4"): the value matches, the text claims less precision
  approximate?: boolean;
}
export interface GateResult { version: string; status: 'VERIFIED' | 'FAILED' | 'UNKNOWN' | 'NOT_APPLICABLE'; findings: Finding[] }

// ---- reading the paragraph ---------------------------------------------------------------------------
const ATOM = '\uFFFC';
const proseOf = (p: { content?: Inline[] }) => (p.content ?? []).map((n) => (n.type === 'text' ? n.text ?? '' : ATOM)).join('');
const ABBREV = /(?:\b(?:Fig|Figs|al|e\.g|i\.e|vs|ca|approx|Eq|Ref|Suppl|No|resp))\.$/;
function sentencesOf(prose: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of prose.matchAll(/[.!?](?=\s+[^\s])/g)) {
    const end = m.index! + 1;
    if (ABBREV.test(prose.slice(Math.max(0, end - 6), end))) continue;
    out.push(prose.slice(start, end));
    start = end;
  }
  out.push(prose.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

// a number as written: thousands groups ("2,400") are one number; a sign counts only where it is one
const NUMBER = /(?<![\p{L}\p{N}_.,])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(?:[eE]|[×x]\s*10\^?)\s*([-−]?\d+))?/gu;
const UNIT = /^(?:\s*-\s*|\s*)(%|fold|[×x](?![\p{L}])|[µμu]M|mM|nM|pM|mg\/kg|mg\/mL|mg\/L|mg|[µμ]g|ng|kg|g|mL|[µμ]L|L|°C|h|min|s|d|days?|weeks?|bp|kb|kDa|cm|mm|[µμ]m|nm|M)(?![\p{L}\p{N}])/u;
// "2.4 ± 0.3-fold", "2–3-fold", "2 to 3 h": the unit after the pair belongs to the first number too
const PAIR_AFTER = /^\s*(?:±|\+\/-|[–-]|to)\s*\d+(?:\.\d+)?/;
const SPREAD_BEFORE = /(?:±|\+\/-)\s*$/;
const APPROX_BEFORE = /(?:[~≈∼]|\b(?:about|approximately|approx\.?|nearly|roughly|around|circa|ca\.?|almost))\s*$/i;
const NOT_A_QUANTITY_BEFORE = /(?:fig(?:ure)?s?\.?|tables?|panels?|eqs?\.?|equations?|ref\.?|suppl(?:ementary)?\.?|chapters?|sections?|sect\.?|days?\s+of|lines?)\s*$/i;
const LABEL_BEFORE = /(?:^|[^\p{L}\p{N}])(p|q|fdr|padj|p\.adj|adj(?:usted)?\.?\s*p|n)(?:[- ]?values?)?\s*(<=|>=|[<>≤≥=])\s*$/iu;
const normUnit = (u: string) => {
  const s = u.replace(/^[\s-]+/, '').replace(/μ/g, 'µ').trim();
  if (/^(fold|[×x])$/.test(s)) return 'fold';
  if (/^days?$/.test(s)) return 'd';
  if (/^weeks?$/.test(s)) return 'week';
  return s.replace(/^u(?=[MgLm]$)/, 'µ');
};
const numberOf = (raw: string) => {
  const s = raw.trim().replace(/−/g, '-').replace(/,(?=\d{3}(?!\d))/g, '');
  if (!/^-?\d+(?:\.\d+)?(?:\s*(?:[eE]|[×x]\s*10\^?)\s*-?\d+)?$/.test(s)) return NaN;
  const e = /(?:[eE]|[×x]\s*10\^?)\s*(-?\d+)$/.exec(s);
  const base = Number(s.replace(/(?:[eE]|[×x]\s*10\^?)\s*-?\d+$/, '').trim());
  return e ? base * 10 ** Number(e[1]) : base;
};

interface Mention {
  kind: 'quantity' | 'statistic' | 'sample_size' | 'dispersion' | 'unreadable';
  text: string; value: number; unit: string; label: 'p' | 'q' | 'n' | null; comparator: string; sentence: number; approximate: boolean;
}
function mentionsOf(sentences: string[]): Mention[] {
  const out: Mention[] = [];
  sentences.forEach((s, si) => {
    for (const m of s.matchAll(NUMBER)) {
      const before = s.slice(0, m.index!);
      const rest = s.slice(m.index! + m[0].length);
      if (NOT_A_QUANTITY_BEFORE.test(before)) continue;
      // "2,4": a decimal comma or a list — cannot be read as one number (review MINOR 1)
      if (/^,\d/.test(rest) && !m[1]!.includes(',')) {
        out.push({ kind: 'unreadable', text: m[0] + /^,\d+/.exec(rest)![0], value: NaN, unit: '', label: null, comparator: '=', sentence: si, approximate: false });
        continue;
      }
      // a minus sign: "−1.5", "(-2)", "= -0.3" — not the hyphen of "day-3" or a range "2-3"
      const signed = /[-−]$/.test(before) && !/[\p{L}\p{N}]/u.test(before.slice(-2, -1));
      const value = (signed ? -1 : 1) * numberOf(m[0]);
      const pair = PAIR_AFTER.exec(rest);
      const unit = UNIT.exec(pair ? rest.slice(pair[0].length) : rest);
      // a label glued to a number ("2A", "3rd", "5'") is not a quantity
      if (!unit && !pair && /^[\p{L}'′]/u.test(rest)) continue;
      const approximate = APPROX_BEFORE.test(signed ? before.slice(0, -1) : before);
      const label = LABEL_BEFORE.exec(before);
      if (label) {
        const l = label[1]!.toLowerCase().replace(/\s+/g, '');
        const kind = l === 'n' ? 'n' : l === 'p' ? 'p' : 'q';
        // the mention starts at the label itself (not the character before it)
        const start = before.length - label[0].length + /^[^\p{L}\p{N}]*/u.exec(label[0])![0].length;
        out.push({ kind: kind === 'n' ? 'sample_size' : 'statistic', text: s.slice(start, m.index! + m[0].length).trim(), value, unit: '', label: kind, comparator: label[2]!.replace('<=', '≤').replace('>=', '≥'), sentence: si, approximate });
        continue;
      }
      if (SPREAD_BEFORE.test(before)) {
        out.push({ kind: 'dispersion', text: `± ${m[0]}`, value, unit: '', label: null, comparator: '=', sentence: si, approximate });
        continue;
      }
      // a bare year is not a quantity
      if (!unit && !pair && /^(?:19|20)\d{2}$/.test(m[0])) continue;
      const text = `${signed ? before.slice(-1) : ''}${m[0]}${pair ? pair[0] : ''}${unit ? unit[0] : ''}`.trim();
      out.push({ kind: 'quantity', text, value, unit: unit ? normUnit(unit[1]!) : '', label: null, comparator: '=', sentence: si, approximate });
    }
  });
  return out;
}

// ---- words -------------------------------------------------------------------------------------------
const STOP = new Set(['the', 'and', 'for', 'with', 'was', 'were', 'are', 'its', 'this', 'that', 'than', 'under', 'into', 'from', 'after', 'over', 'had', 'has', 'have', 'both', 'all', 'our', 'their', 'which', 'when', 'compared', 'between', 'within', 'during', 'not']);
const NEGATION = /\b(not|no|never|neither|nor|none|without|cannot|absence|absent|lack(?:ed|s|ing)?|fail(?:ed|s)? to)\b|n't\b/gi;
const DIRECTION = /\b(increase[sd]?|increasing|rose|rise[sn]?|rising|higher|greater|elevated|up-?regulated|enhanced|induced|gain(?:ed|s)?|decrease[sd]?|decreasing|fell|fall(?:s|en|ing)?|dropped|declined?|lower|reduced|down-?regulated|diminished|repressed|lost|positive(?:ly)?|negative(?:ly)?)\b/gi;
const directionSign = (w: string) => (/^(increas|rose|rise|rising|higher|greater|elevated|up|enhanced|induced|gain|positive)/i.test(w) ? '+' : '-');
const stem = (w: string) => (w.length > 4 && w.endsWith('ed') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const wordsOf = (s: string) => new Set((s.toLowerCase().replace(NEGATION, ' ').replace(DIRECTION, ' ').match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)).map(stem));
const labelRe = (label: string) => {
  const l = label.trim().toLowerCase().replace(/\s+/g, ' ');
  return l ? new RegExp(`(?<![\\p{L}\\p{N}])${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}s?(?![\\p{L}\\p{N}])`, 'giu') : null;
};
const labelAt = (text: string, label: string) => { const re = labelRe(label); const m = re ? re.exec(text) : null; return m ? m.index : -1; };
const withoutLabels = (text: string, labels: string[]) => labels.reduce((t, l) => { const re = labelRe(l); return re ? t.replace(re, ' ') : t; }, text);
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((w) => b.has(w)).length;
// identifiers such as gene or line names ("ABC1", "abc2", "WRKY33"): letters and digits together
const ID_TOKEN = /(?<![\p{L}\p{N}])(?=[\p{L}\p{N}]*\p{L})(?=[\p{L}\p{N}]*\p{N})[\p{L}\p{N}]{2,}(?![\p{L}\p{N}])/gu;
const NOT_IDS = new Set(['log2', 'log10', 'ln2', 'h2o', 'co2', 'o2', 'n2']);
const idTokens = (s: string) => new Set((s.toLowerCase().replace(/(?:fig(?:ure)?s?\.?|tables?|panels?|suppl\w*\.?)\s*[a-z]?\d+[a-z]?/gi, ' ').match(ID_TOKEN) ?? []).filter((t) => !NOT_IDS.has(t)));
// Comparative words between the group and its comparison: "X than Y", "X compared with Y", "X vs Y"
const COMPARATIVE = /\b(?:than|compared\s+(?:with|to)|relative\s+to|versus|vs\.?|over)(?![\p{L}])/giu;

// ---- the gate ----------------------------------------------------------------------------------------
export function scientificGate(input: GateInput): GateResult {
  const prose = proseOf(input.paragraph);
  const sentences = sentencesOf(prose);
  const findings: Finding[] = [];
  const mentions = mentionsOf(sentences);
  const located = (f: GateFact) => ({ fact_id: f.id, evidence_id: f.evidence_id, evidence_label: f.evidence_label, locator: f.locator });
  // the facts each sentence was matched to (statistics and n read from them)
  const matched = new Map<number, GateFact[]>();

  for (const m of mentions.filter((x) => x.kind === 'unreadable')) findings.push({ check: 'quantity', verdict: 'unknown', text: m.text, reason: 'ambiguous_number' });

  for (const m of mentions.filter((x) => x.kind === 'quantity')) {
    const s = sentences[m.sentence]!;
    const sw = wordsOf(s);
    // the same value; a fact holding the opposite sign is a candidate only to fail (review MAJOR)
    const exact = input.facts.filter((f) => numberOf(f.value_text) === m.value);
    const flipped = m.value !== 0 ? input.facts.filter((f) => numberOf(f.value_text) === -m.value) : [];
    const candidates = [...exact, ...flipped];
    if (!candidates.length) { findings.push({ check: 'quantity', verdict: 'unknown', text: m.text, reason: 'no_matching_fact' }); continue; }
    const judged = candidates.map((f) => {
      const fu = normUnit(f.unit ?? '');
      let hard: string | null = flipped.includes(f) ? 'sign_mismatch' : null;
      let soft: string | null = null;
      if (!hard && m.unit && m.unit !== fu) hard = 'unit_mismatch';
      else if (!hard && !m.unit && fu) soft = 'unit_not_stated';
      // the entity: its identifiers must be named in this sentence (outside the group names); another
      // identifier instead is another entity; plain names may be in the paragraph
      if (!hard) {
        const own = idTokens(f.entity);
        const rest = withoutLabels(s, [f.group_label, f.comparison]);
        const named = idTokens(withoutLabels(rest, [f.metric]));
        if (own.size) {
          if (![...own].every((t) => named.has(t))) {
            if ([...named].some((t) => !own.has(t))) hard = 'entity_mismatch';
            else soft ??= 'entity_not_stated';
          }
        } else if (![...wordsOf(f.entity)].every((w) => wordsOf(withoutLabels(prose, [f.group_label, f.comparison])).has(w))) soft ??= 'entity_not_stated';
      }
      // the group: named, and on the right side of a comparison when both are named
      if (!hard && f.group_label.trim()) {
        const g = labelAt(s, f.group_label);
        const c = f.comparison.trim() ? labelAt(s, f.comparison) : -1;
        if (g < 0 && c >= 0) hard = 'group_mismatch';
        else if (g >= 0 && c >= 0) {
          const between = [...s.matchAll(COMPARATIVE)].map((x) => x.index!).find((k) => k > Math.min(g, c) && k < Math.max(g, c));
          if (between === undefined) soft ??= 'comparison_order_unclear';
          else if (c < g) hard = 'group_mismatch';
        } else if (g < 0 && labelAt(prose, f.group_label) < 0) soft ??= 'group_not_stated';
      }
      return { f, hard, soft, score: overlap(wordsOf(`${f.entity} ${f.metric}`), sw) };
    });
    const best = <T extends { score: number }>(xs: T[]) => { const top = Math.max(...xs.map((x) => x.score)); return xs.filter((x) => x.score === top); };
    const ok = judged.filter((j) => !j.hard && !j.soft);
    const soft = judged.filter((j) => !j.hard && j.soft);
    const approx = m.approximate ? { approximate: true } : {};
    if (ok.length) {
      const top = best(ok);
      if (top.length === 1) {
        findings.push({ check: 'quantity', verdict: 'pass', text: m.text, ...located(top[0]!.f), ...approx });
        matched.set(m.sentence, [...(matched.get(m.sentence) ?? []), top[0]!.f]);
      } else findings.push({ check: 'quantity', verdict: 'unknown', text: m.text, reason: 'ambiguous', candidates: top.map((j) => j.f.id).sort() });
    } else if (soft.length) {
      const top = best(soft);
      if (top.length === 1) findings.push({ check: 'quantity', verdict: 'unknown', text: m.text, reason: top[0]!.soft!, candidates: [top[0]!.f.id] });
      else findings.push({ check: 'quantity', verdict: 'unknown', text: m.text, reason: 'ambiguous', candidates: top.map((j) => j.f.id).sort() });
    } else {
      const top = best(judged)[0]!;
      findings.push({ check: 'quantity', verdict: 'fail', text: m.text, reason: top.hard!, candidates: judged.map((j) => j.f.id).sort() });
    }
  }

  // p/q, n and ± spreads: read only from the facts this sentence was matched to (review MAJOR: never
  // from a fact matched elsewhere in the paragraph)
  for (const m of mentions.filter((x) => x.kind === 'statistic' || x.kind === 'sample_size' || x.kind === 'dispersion')) {
    const facts = matched.get(m.sentence) ?? [];
    const kind = m.kind === 'sample_size' ? 'sample_size' : 'statistic';
    if (!facts.length) { findings.push({ check: kind, verdict: 'unknown', text: m.text, reason: 'no_matched_fact' }); continue; }
    if (m.kind === 'dispersion') {
      const spreads = facts.flatMap((f) => f.statistics.filter((x) => x.kind === 'sd' || x.kind === 'se').map((x) => ({ f, x })));
      const hit = spreads.find(({ x }) => numberOf(x.value_text) === m.value);
      if (hit) findings.push({ check: 'statistic', verdict: 'pass', text: m.text, statistic: hit.x.kind, ...located(hit.f) });
      else if (spreads.length) findings.push({ check: 'statistic', verdict: 'fail', text: m.text, reason: 'value_mismatch', ...located(spreads[0]!.f) });
      else findings.push({ check: 'statistic', verdict: 'unknown', text: m.text, reason: 'dispersion_not_recorded' });
      continue;
    }
    if (m.kind === 'sample_size') {
      const same = facts.find((f) => f.n === m.value);
      if (same) findings.push({ check: 'sample_size', verdict: 'pass', text: m.text, ...located(same) });
      else if (facts.some((f) => f.n !== null)) findings.push({ check: 'sample_size', verdict: 'fail', text: m.text, reason: 'n_mismatch', candidates: facts.map((f) => f.id) });
      else findings.push({ check: 'sample_size', verdict: 'unknown', text: m.text, reason: 'no_n_recorded' });
      continue;
    }
    const family = (k: string) => (k === 'p_value' ? 'p' : k === 'q_value' || k === 'adjusted_p_value' ? 'q' : null);
    let out: Finding | null = null;
    for (const f of facts) {
      const same = f.statistics.filter((x) => family(x.kind) === m.label);
      const other = f.statistics.filter((x) => family(x.kind) !== null && family(x.kind) !== m.label);
      const v = (x: { value_text: string }) => numberOf(x.value_text);
      let r: Finding;
      if (m.comparator === '=') {
        const hit = same.find((x) => v(x) === m.value);
        if (hit) r = { check: 'statistic', verdict: 'pass', text: m.text, statistic: hit.kind, ...located(f) };
        else if (other.some((x) => v(x) === m.value)) r = { check: 'statistic', verdict: 'fail', text: m.text, reason: 'p_q_mismatch', ...located(f) };
        else if (same.length) r = { check: 'statistic', verdict: 'fail', text: m.text, reason: 'value_mismatch', ...located(f) };
        else r = { check: 'statistic', verdict: 'unknown', text: m.text, reason: 'no_statistic', ...located(f) };
      } else {
        const holds = (x: number) => (m.comparator === '<' ? x < m.value : m.comparator === '≤' ? x <= m.value : m.comparator === '>' ? x > m.value : x >= m.value);
        const hit = same.find((x) => holds(v(x)));
        if (hit) r = { check: 'statistic', verdict: 'pass', text: m.text, statistic: hit.kind, reason: 'threshold', ...located(f) };
        else if (same.length) r = { check: 'statistic', verdict: 'fail', text: m.text, reason: 'threshold_not_met', ...located(f) };
        else r = { check: 'statistic', verdict: 'unknown', text: m.text, reason: 'no_statistic', ...located(f) };
      }
      if (r.verdict === 'pass') { out = r; break; }
      if (!out || (out.verdict === 'unknown' && r.verdict === 'fail')) out = r;
    }
    findings.push(out!);
  }

  if (!input.skip?.includes('citation')) {
    for (const n of input.paragraph.content ?? []) {
      if (n.type !== 'citation') continue;
      const id = String(n.attrs?.referenceId ?? '');
      const ref = input.references.find((r) => r.id === id);
      const locator = (n.attrs?.locator as string | null) ?? null;
      if (!ref) findings.push({ check: 'citation', verdict: 'fail', text: id, reason: 'citation_not_found', reference_id: id });
      else if (ref.retracted) findings.push({ check: 'citation', verdict: 'fail', text: ref.label, reason: 'citation_retracted', reference_id: id, label: ref.label });
      else findings.push({ check: 'citation', verdict: 'pass', text: ref.label, reference_id: id, label: ref.label, locator });
    }
  }

  if (input.original) {
    const atoms = (p: { content?: Inline[] }) => JSON.stringify((p.content ?? []).filter((n) => n.type === 'math_inline' || n.type === 'figure_ref').map((n) => [n.type, n.attrs ?? {}]));
    const same = atoms(input.original) === atoms(input.paragraph);
    findings.push(same ? { check: 'protected_span', verdict: 'pass', text: 'math/figure atoms' } : { check: 'protected_span', verdict: 'fail', text: 'math/figure atoms', reason: 'protected_span_changed' });
  }

  for (const c of input.claims) {
    const cw = wordsOf(c.text);
    if (!cw.size) continue;
    const scored = sentences.map((s) => ({ s, score: overlap(cw, wordsOf(s)) / cw.size }));
    const top = scored.reduce((a, b) => (b.score > a.score ? b : a), { s: '', score: 0 });
    if (top.score < 0.6) { findings.push({ check: 'claim', verdict: 'unknown', text: c.text, reason: 'claim_not_found', claim_id: c.id }); continue; }
    const neg = (s: string) => (s.match(NEGATION) ?? []).length % 2;
    const dirs = (s: string) => new Set((s.match(DIRECTION) ?? []).map(directionSign));
    const cd = dirs(c.text);
    const sd = dirs(top.s);
    if (neg(c.text) !== neg(top.s)) findings.push({ check: 'claim', verdict: 'fail', text: top.s, reason: 'negation_changed', claim_id: c.id });
    else if (cd.size && sd.size && ![...cd].some((d) => sd.has(d))) findings.push({ check: 'claim', verdict: 'fail', text: top.s, reason: 'direction_changed', claim_id: c.id });
    else findings.push({ check: 'claim', verdict: 'pass', text: top.s, claim_id: c.id });
  }

  const status = findings.some((f) => f.verdict === 'fail') ? 'FAILED' : findings.some((f) => f.verdict === 'unknown') ? 'UNKNOWN' : findings.length ? 'VERIFIED' : 'NOT_APPLICABLE';
  return { version: GATE_VERSION, status, findings };
}
