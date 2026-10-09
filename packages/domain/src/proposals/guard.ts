// Server checks on a proposed replacement for a selection (spec 04 "citation과 수치·단위가 선택에
// 포함되면 보존 규칙을 먼저 적용"). Ported from the PW-003 conservative guard. A failed check makes the
// proposal CHECK_FAILED: it is shown with the reason and can never be applied.
// Heuristic and English-centred: the known bypasses are listed in RFC-003 (group-label swaps, claim
// strength, unlisted units, other languages). The user's diff review stays the last defence.
import { canonicalJson, type parseDocument } from '@pw/editor-core';

type PMNode = ReturnType<typeof parseDocument>;

export type CheckResult = { check: string; result: 'pass' | 'fail' | 'unknown' | 'not_applicable'; details?: string };
export type ProposalIntent = 'grammar' | 'concise' | 'rewrite';

const UNIT = String.raw`%|[µμ]M|mM|nM|pM|M|[µμ]m|nm|mm|cm|km|kDa|Da|bp|kb|Mb|mg\/kg|mg\/g|mg\/L|mg|[µμ]g|ng|g|kg|mL|[µμ]L|L|°C|h|min|s|days?|weeks?|months?|years?|fold|×`;
const QUANTITY_RE = new RegExp(String.raw`(?:([<>≤≥=])\s*)?([-−]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[-−]?\d+(?:\.\d+)*)(?:\s*-?\s*(${UNIT})(?![A-Za-z]))?`, 'g');
const SPELLED: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twice: 2, half: 0.5, double: 2, triple: 3 };
const SPELLED_RE = new RegExp(String.raw`\b(${Object.keys(SPELLED).join('|')})(?:-?(fold))?\b`, 'gi');
const COMPARATOR_WORD_RE = /\b(below|less than|lower than|above|more than|greater than|exceed(?:s|ed|ing)?)\b/gi;
const comparatorSign = (w: string) => (/^(below|less|lower)/i.test(w) ? '<' : '>');
const NEGATION_RE = /\b(not|no|never|neither|nor|none|without|cannot|absence|absent|lack(?:ed|s|ing)?|fail(?:ed|s)? to)\b|n't\b/gi;
const DIRECTION_RE = /\b(increase[sd]?|increasing|rose|rise[sn]?|rising|higher|greater|elevated|up-?regulated|enhanced|gain(?:ed|s)?|decrease[sd]?|decreasing|fell|fall(?:s|en|ing)?|dropped|declined?|lower|reduced|down-?regulated|diminished|lost|positive(?:ly)?|negative(?:ly)?)\b/gi;
const directionSign = (w: string) => (/^(increas|rose|rise|rising|higher|greater|elevated|up|enhanced|gain|positive)/i.test(w) ? '+' : '-');

interface Facts { quantities: string[]; marked: string[]; citations: { id: string; locator: string | null; anchor: string }[]; otherAtoms: string[]; negations: string[]; directions: string[] }

function facts(nodes: readonly PMNode[]): Facts {
  const f: Facts = { quantities: [], marked: [], citations: [], otherAtoms: [], negations: [], directions: [] };
  let prose = '';
  for (const n of nodes) {
    if (n.isText) {
      const text = n.text ?? '';
      const marks = n.marks.map((m) => m.type.name).sort();
      // quantities are read per run, so 10 + superscript 5 differs from plain 105
      const found: [number, string][] = [];
      for (const m of text.matchAll(QUANTITY_RE)) found.push([m.index!, `${m[1] ?? ''}${m[2]!.replace('−', '-').replaceAll(',', '')}${m[3] ? ` ${m[3].replace('μ', 'µ')}` : ''}`]);
      for (const m of text.matchAll(SPELLED_RE)) found.push([m.index!, `${SPELLED[m[1]!.toLowerCase()]}${m[2] ? ' fold' : ''}`]);
      for (const m of text.matchAll(COMPARATOR_WORD_RE)) found.push([m.index!, comparatorSign(m[1]!)]);
      found.sort((x, y) => x[0] - y[0]).forEach(([, q]) => f.quantities.push(q));
      if (marks.length) f.marked.push(`${marks.join('+')}:${text}`);
      prose += text;
    } else if (n.type.name === 'citation') {
      const words = prose.match(/[\p{L}\p{N}]+(?=[^\p{L}\p{N}]*$)/u);
      f.citations.push({ id: n.attrs.referenceId as string, locator: (n.attrs.locator as string | null) ?? null, anchor: words ? words[0]!.toLowerCase() : '' });
      prose += ' ';
    } else {
      f.otherAtoms.push(canonicalJson(n.toJSON()));
      prose += ' ';
    }
  }
  f.negations = [...prose.matchAll(NEGATION_RE)].map((m) => (m[1] ?? 'not').toLowerCase().replace(/^lack.*/, 'lack').replace(/^fail.*/, 'fail'));
  f.directions = [...prose.matchAll(DIRECTION_RE)].map((m) => directionSign(m[1]!));
  return f;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameBag = (a: string[], b: string[]) => same([...a].sort(), [...b].sort());
const check = (name: string, ok: boolean, details: string): CheckResult => (ok ? { check: name, result: 'pass' } : { check: name, result: 'fail', details });

// Every check, in a fixed order. Conservative edits (grammar, concise) keep negations and directions
// in order; an academic rewrite may reorder clauses but not add, drop or flip them.
export function checkReplacement(before: readonly PMNode[], after: readonly PMNode[], intent: ProposalIntent): CheckResult[] {
  const b = facts(before);
  const a = facts(after);
  const ordered = intent !== 'rewrite';
  return [
    check('protected_atoms', same(b.otherAtoms, a.otherAtoms), 'math/figure atoms must be kept in order (preserve_atom)'),
    check('citations', same(b.citations.map((c) => [c.id, c.locator]), a.citations.map((c) => [c.id, c.locator])), 'citations and locators must be kept exactly, in order'),
    check('citation_positions', same(b.citations.map((c) => c.anchor), a.citations.map((c) => c.anchor)), 'each citation must stay after the same word'),
    check('formatted_runs', same(b.marked, a.marked), `formatted runs changed: ${b.marked.join(' | ')} → ${a.marked.join(' | ')}`),
    check('numbers', same(b.quantities, a.quantities), `quantities ${b.quantities.join(', ') || '∅'} became ${a.quantities.join(', ') || '∅'}`),
    check('negations', ordered ? same(b.negations, a.negations) : sameBag(b.negations, a.negations), `negations ${b.negations.join(',') || '∅'} became ${a.negations.join(',') || '∅'}`),
    check('directions', ordered ? same(b.directions, a.directions) : sameBag(b.directions, a.directions), `direction words ${b.directions.join('') || '∅'} became ${a.directions.join('') || '∅'}`),
  ];
}
