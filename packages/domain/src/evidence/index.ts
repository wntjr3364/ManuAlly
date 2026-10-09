// Claims, evidence records and fact records (spec 02 "과학 근거", spec 05 "Evidence와 Fact").
// Everything starts as a candidate/draft. Only the paper owner, through an explicit verify/approve
// action that names the exact content hash, moves it on; requests can never carry a verifier.
// A fact keeps the source's exact number text (the DB checks it parses to the stored number), its unit,
// groups, n and statistics; p, adjusted p and q are different statistic kinds and are never
// inferred from loose labels or merged.
import { randomUUID } from 'node:crypto';
import { DomainError, UUID_RE, inTransaction, storable, type Queryable, type TxPool } from '../shared/db.ts';
import { contentHash } from '../revisions/index.ts';

export const EVIDENCE_KINDS = ['experiment', 'figure_panel', 'table_cell', 'literature_excerpt', 'method_record'] as const;
export const CLAIM_KINDS = ['observation', 'interpretation', 'hypothesis', 'background'] as const;
export const LINK_RELATIONS = ['supports', 'contradicts', 'unclear', 'needs_check'] as const;
export const EXTRACTION_METHODS = ['manual_entry', 'table_import', 'figure_reading', 'ai_extraction'] as const;
export const ORIGINS = ['user', 'import', 'ai_extraction'] as const;
export type Origin = (typeof ORIGINS)[number];
// Exact names only. "p", "q", "FDR", "padj" … are refused rather than mapped: a mapping guess is
// exactly how a q-value turns into a p-value.
export const STAT_KINDS = ['p_value', 'adjusted_p_value', 'q_value', 'test_statistic', 'df', 'effect_size', 'sd', 'se', 'ci_lower', 'ci_upper', 'ci_level'] as const;
export type StatKind = (typeof STAT_KINDS)[number];
const PROBABILITY_KINDS: StatKind[] = ['p_value', 'adjusted_p_value', 'q_value'];
// metrics that compare two groups: a control/comparison group is required before verification
// (conservative: a false match only asks for the comparison group)
const RELATIVE_METRICS = /(fold|fc|ratio|diff|change|odds|hazard|relative|delta|\bvs\b|versus)/i;
// a decimal number as printed in a source; the exponent is bounded so PostgreSQL numeric holds it
// same shape as the DB CHECK on value_text (a trailing '.' like '2.' is refused by both)
const NUMBER = /^([+-]?)(\d+(?:\.\d+)?|\.\d+)(?:[eE]([+-]?\d{1,3}))?$/;
const MAX_EXPONENT = 300;

function isNumberText(s: string): boolean {
  const m = NUMBER.exec(s);
  return !!m && Math.abs(Number(m[3] ?? 0)) <= MAX_EXPONENT;
}
// exact decimal comparison with 0 and 1 (floats would round 1.00000000000000000001 to 1)
function isProbability(s: string): boolean {
  const m = NUMBER.exec(s)!;
  const [whole, frac = ''] = m[2]!.split('.');
  let digits = `${whole}${frac}`.replace(/^0+/, '');
  if (!digits) return true; // zero, with any sign
  if (m[1] === '-') return false;
  digits = digits.replace(/0+$/, '');
  // value = 0.d1d2… × 10^magnitude, where magnitude counts digits before the decimal point
  const lead = `${whole}${frac}`.length - `${whole}${frac}`.replace(/^0+/, '').length;
  const magnitude = (whole?.length ?? 0) - lead + Number(m[3] ?? 0);
  if (magnitude < 1) return true; // below 1
  return magnitude === 1 && digits === '1'; // exactly 1
}
// reviewer/state fields are set by the server only
const SERVER_FIELDS = ['verified_by', 'verified_at', 'verification_state', 'extraction_state', 'approved_by', 'approved_at', 'approval_state', 'origin', 'status', 'closed_at', 'value'];

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const invalid = (message: string, field: string, details?: Record<string, unknown>) => new DomainError('INVALID', message, field, { details });
const at = (prefix: string, k: string) => (prefix ? `${prefix}.${k}` : k);

function obj(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(`${field || 'body'} must be an object`, field || 'body');
  return v as Record<string, unknown>;
}
function onlyKeys(o: Record<string, unknown>, allowed: string[], prefix: string) {
  for (const k of SERVER_FIELDS) if (k in o && !allowed.includes(k)) throw invalid(`${at(prefix, k)} is set by the server after review; it cannot be sent`, at(prefix, k));
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw invalid(`${at(prefix, k)} is not a known field`, at(prefix, k));
}
function str(v: unknown, field: string, max: number, { required = false, def = '' } = {}): string {
  if (v === undefined || v === null) {
    if (required) throw invalid(`${field} is required`, field);
    return def;
  }
  if (typeof v !== 'string' || v.length > max || !storable(v)) throw invalid(`${field} must be text up to ${max} characters`, field);
  if (required && !v.trim()) throw invalid(`${field} must not be empty`, field);
  return v;
}
function oneOf<T extends string>(v: unknown, field: string, values: readonly T[]): T {
  if (!values.includes(v as T)) throw invalid(`${field} must be one of ${values.join(', ')}`, field);
  return v as T;
}
function reviewBody(body: unknown, intent: string): string {
  const b = obj(body ?? {}, '');
  onlyKeys(b, ['intent', 'content_hash'], '');
  if (b.intent !== intent) throw invalid(`intent must be "${intent}" (an explicit review action)`, 'intent');
  if (typeof b.content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(b.content_hash)) throw invalid('content_hash of the version you reviewed is required', 'content_hash');
  return b.content_hash;
}
const owner = (tx: Queryable, paperId: string) => tx.query('SELECT 1 FROM paper_projects WHERE id = $1 FOR SHARE', [paperId]);

// ---------- evidence ----------

const LOCATOR_KEYS: Record<(typeof EVIDENCE_KINDS)[number], { required: string[]; optional: string[] }> = {
  table_cell: { required: ['table', 'row', 'column'], optional: ['sheet'] },
  figure_panel: { required: ['panel'], optional: ['figure'] },
  literature_excerpt: { required: ['quote'], optional: ['page_index', 'section', 'anchor_id'] },
  experiment: { required: ['note'], optional: ['protocol', 'run'] },
  method_record: { required: ['note'], optional: ['protocol', 'step'] },
};
function locator(kind: (typeof EVIDENCE_KINDS)[number], v: unknown): Record<string, string | number> {
  const o = obj(v, 'locator');
  const spec = LOCATOR_KEYS[kind];
  for (const k of Object.keys(o)) if (![...spec.required, ...spec.optional].includes(k)) throw invalid(`locator.${k} is not used for ${kind} evidence`, `locator.${k}`);
  const out: Record<string, string | number> = {};
  for (const k of spec.required) out[k] = str(o[k], `locator.${k}`, 2000, { required: true });
  for (const k of spec.optional) {
    if (o[k] === undefined || o[k] === null) continue;
    if (k === 'page_index') {
      if (!Number.isInteger(o[k]) || (o[k] as number) < 0 || (o[k] as number) > 100_000) throw invalid('locator.page_index must be a 0-based page number', 'locator.page_index');
      out[k] = o[k] as number;
    } else out[k] = str(o[k], `locator.${k}`, 2000);
  }
  return out;
}

export interface EvidenceRecord {
  id: string;
  paper_id: string;
  kind: (typeof EVIDENCE_KINDS)[number];
  source_asset_revision_id: string | null;
  reference_id: string | null;
  locator: Record<string, string | number>;
  label: string;
  content_hash: string;
  origin: Origin;
  extraction_state: 'CANDIDATE' | 'VERIFIED' | 'REJECTED' | 'RETRACTED';
  created_by: string;
  created_at: string;
  verified_by: string | null;
  verified_at: string | null;
  closed_at: string | null;
}
const EV_COLS = 'id, paper_id, kind, source_asset_revision_id, reference_id, locator, label, content_hash, origin, extraction_state, created_by, created_at, verified_by, verified_at, closed_at';

export async function createEvidence(pool: TxPool, a: { paperId: string; ownerId: string; origin?: Origin; body: unknown }): Promise<EvidenceRecord> {
  const b = obj(a.body, '');
  onlyKeys(b, ['kind', 'source_asset_revision_id', 'reference_id', 'locator', 'label'], '');
  const kind = oneOf(b.kind, 'kind', EVIDENCE_KINDS);
  const loc = locator(kind, b.locator);
  const label = str(b.label, 'label', 500);
  const asset = b.source_asset_revision_id ?? null;
  const ref = b.reference_id ?? null;
  if (asset !== null && !isUuid(asset)) throw invalid('source_asset_revision_id must be an asset revision id', 'source_asset_revision_id');
  if (ref !== null && !isUuid(ref)) throw invalid('reference_id must be a reference id', 'reference_id');
  if ((kind === 'table_cell' || kind === 'figure_panel') && !asset) throw invalid(`${kind} evidence needs the source_asset_revision_id of the table or figure`, 'source_asset_revision_id');
  if (kind === 'literature_excerpt' && !ref) throw invalid('literature_excerpt evidence needs the reference_id it quotes', 'reference_id');
  const content = { kind, source_asset_revision_id: asset?.toLowerCase() ?? null, reference_id: ref?.toLowerCase() ?? null, locator: loc, label };
  return inTransaction(pool, async (tx) => {
    await owner(tx, a.paperId);
    if (content.source_asset_revision_id && !(await tx.query('SELECT 1 FROM asset_revisions WHERE id = $1 AND paper_id = $2', [content.source_asset_revision_id, a.paperId])).rows[0]) {
      throw new DomainError('NOT_FOUND', 'source asset revision not found in this paper', 'source_asset_revision_id');
    }
    if (content.reference_id && !(await tx.query('SELECT 1 FROM project_references WHERE reference_id = $1 AND paper_id = $2 AND removed_at IS NULL', [content.reference_id, a.paperId])).rows[0]) {
      throw new DomainError('NOT_FOUND', 'reference not found in this paper', 'reference_id');
    }
    // a quote tied to a confirmed PDF location (PW-035) must be that location's text
    if (loc.anchor_id !== undefined) {
      if (!isUuid(loc.anchor_id)) throw invalid('locator.anchor_id must be a confirmed PDF location id', 'locator.anchor_id');
      const an = (await tx.query<{ exact: string; page_index: number }>('SELECT exact, page_index FROM pdf_anchors WHERE paper_id = $1 AND id = $2', [a.paperId, String(loc.anchor_id).toLowerCase()])).rows[0];
      if (!an) throw new DomainError('NOT_FOUND', 'PDF location not found in this paper', 'locator.anchor_id');
      if (an.exact !== loc.quote) throw invalid('locator.quote must be the text of the confirmed PDF location', 'locator.quote');
      if (loc.page_index !== undefined && loc.page_index !== an.page_index) throw invalid('locator.page_index must be the page of the confirmed PDF location', 'locator.page_index');
    }
    const { rows } = await tx.query<EvidenceRecord>(
      `INSERT INTO evidence_records (id, paper_id, kind, source_asset_revision_id, reference_id, locator, label, content_hash, origin, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${EV_COLS}`,
      [randomUUID(), a.paperId, kind, content.source_asset_revision_id, content.reference_id, JSON.stringify(loc), label, contentHash(content), a.origin ?? 'user', a.ownerId],
    );
    return rows[0]!;
  });
}

export async function getEvidence(db: Queryable, paperId: string, id: string): Promise<EvidenceRecord | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query<EvidenceRecord>(`SELECT ${EV_COLS} FROM evidence_records WHERE id = $1 AND paper_id = $2`, [id, paperId]);
  return rows[0] ?? null;
}
export async function listEvidence(db: Queryable, paperId: string): Promise<EvidenceRecord[]> {
  const { rows } = await db.query<EvidenceRecord>(`SELECT ${EV_COLS} FROM evidence_records WHERE paper_id = $1 ORDER BY created_at, id`, [paperId]);
  return rows;
}

// shared verify/reject for evidence and facts
async function review(pool: TxPool, a: {
  table: 'evidence_records' | 'fact_records'; state: 'extraction_state' | 'verification_state'; paperId: string; ownerId: string; id: string;
  hash: string; to: 'VERIFIED' | 'REJECTED'; before?: (tx: Queryable, row: Record<string, unknown>) => Promise<void>;
}): Promise<Record<string, unknown>> {
  if (!isUuid(a.id)) throw new DomainError('NOT_FOUND', 'not found');
  return inTransaction(pool, async (tx) => {
    const { rows } = await tx.query<Record<string, unknown>>(`SELECT * FROM ${a.table} WHERE id = $1 AND paper_id = $2 FOR UPDATE`, [a.id, a.paperId]);
    const row = rows[0];
    if (!row) throw new DomainError('NOT_FOUND', 'not found');
    if (row.content_hash !== a.hash) throw new DomainError('CONFLICT', 'this is not the version you reviewed (content hash differs); reload it');
    if (row[a.state] === a.to) return row;
    if (row[a.state] !== 'CANDIDATE') throw new DomainError('CONFLICT', `already ${String(row[a.state]).toLowerCase()}`);
    if (a.before) await a.before(tx, row);
    const set = a.to === 'VERIFIED' ? `${a.state} = 'VERIFIED', verified_by = $2, verified_at = clock_timestamp()` : `${a.state} = 'REJECTED', closed_at = clock_timestamp()`;
    const done = await tx.query<Record<string, unknown>>(`UPDATE ${a.table} SET ${set} WHERE id = $1 RETURNING *`, a.to === 'VERIFIED' ? [a.id, a.ownerId] : [a.id]);
    return done.rows[0]!;
  });
}

export async function reviewEvidence(pool: TxPool, a: { paperId: string; ownerId: string; id: string; body: unknown; to: 'VERIFIED' | 'REJECTED' }) {
  const hash = reviewBody(a.body, a.to === 'VERIFIED' ? 'verify_evidence' : 'reject_evidence');
  await review(pool, {
    table: 'evidence_records', state: 'extraction_state', paperId: a.paperId, ownerId: a.ownerId, id: a.id, hash, to: a.to,
    before: async (tx, row) => {
      if (a.to !== 'VERIFIED' || !row.reference_id) return;
      const ref = await tx.query('SELECT 1 FROM project_references WHERE paper_id = $1 AND reference_id = $2 AND removed_at IS NULL FOR SHARE', [a.paperId, row.reference_id]);
      if (!ref.rows[0]) throw new DomainError('CONFLICT', 'the quoted reference was removed from this paper; add it back before verifying', 'reference_id');
    },
  });
  return (await getEvidence(pool, a.paperId, a.id))!;
}

// ---------- facts ----------

export interface Statistic { kind: StatKind; value_text: string; test?: string; adjustment?: string }
export interface FactInput {
  evidence_id: string;
  entity: string;
  metric: string;
  value_text: string;
  unit: string;
  group: string;
  comparison: string;
  n: number | null;
  extraction_method: (typeof EXTRACTION_METHODS)[number];
  statistics: Required<Statistic>[];
}

function statistics(v: unknown, prefix: string): Required<Statistic>[] {
  const field = at(prefix, 'statistics');
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > STAT_KINDS.length) throw invalid(`${field} must be a list of at most ${STAT_KINDS.length} statistics`, field);
  const out = v.map((s, i): Required<Statistic> => {
    const f = `${field}[${i}]`;
    const o = obj(s, f);
    onlyKeys(o, ['kind', 'value_text', 'test', 'adjustment'], f);
    if (!STAT_KINDS.includes(o.kind as StatKind)) {
      throw invalid(`${f}.kind must be one of ${STAT_KINDS.join(', ')}; p, adjusted p and q are different statistics, so labels such as "p", "q" or "FDR" are not interpreted`, `${f}.kind`);
    }
    const kind = o.kind as StatKind;
    const valueText = str(o.value_text, `${f}.value_text`, 40, { required: true });
    if (!isNumberText(valueText)) throw invalid(`${f}.value_text must be a number as written in the source (exponent at most ±${MAX_EXPONENT})`, `${f}.value_text`);
    if (PROBABILITY_KINDS.includes(kind) && !isProbability(valueText)) throw invalid(`${f}.value_text: a ${kind} lies between 0 and 1`, `${f}.value_text`);
    const adjustment = str(o.adjustment, `${f}.adjustment`, 200);
    if (kind === 'adjusted_p_value' && !adjustment.trim()) throw invalid(`${f}.adjustment must name the correction method for an adjusted p-value`, `${f}.adjustment`);
    if (kind === 'p_value' && adjustment) throw invalid(`${f}.adjustment: a corrected value is an adjusted_p_value (or q_value), not a raw p_value`, `${f}.adjustment`);
    return { kind, value_text: valueText, test: str(o.test, `${f}.test`, 200), adjustment };
  });
  const kinds = out.map((s) => s.kind);
  const dup = kinds.find((k, i) => kinds.indexOf(k) !== i);
  if (dup) throw invalid(`${field} lists ${dup} twice; one fact has one value per statistic kind`, field);
  return out.sort((x, y) => x.kind.localeCompare(y.kind));
}

// Combining statistics from two sources for the same fact: kinds are never unified, and two
// different values for the same kind are a conflict for the user, not something to pick from.
export function mergeStatistics(a: Statistic[], b: Statistic[]): Statistic[] {
  const out = new Map<StatKind, Statistic>();
  for (const s of [...a, ...b]) {
    if (!STAT_KINDS.includes(s.kind)) throw new DomainError('INVALID', `unknown statistic kind ${JSON.stringify(s.kind)}`, 'statistics');
    const prev = out.get(s.kind);
    if (prev && (prev.value_text !== s.value_text || (prev.test ?? '') !== (s.test ?? '') || (prev.adjustment ?? '') !== (s.adjustment ?? ''))) {
      throw new DomainError('CONFLICT', `conflict: two different ${s.kind} values (${prev.value_text}, ${s.value_text}); the user must choose`, 'statistics');
    }
    out.set(s.kind, s);
  }
  return [...out.values()];
}

// provenance: AI-extracted facts say so, and nothing else may claim to be AI-extracted
function extractionMethod(v: unknown, field: string, origin: Origin): FactInput['extraction_method'] {
  if (v === undefined) return origin === 'ai_extraction' ? 'ai_extraction' : 'manual_entry';
  const m = oneOf(v, field, EXTRACTION_METHODS);
  if ((origin === 'ai_extraction') !== (m === 'ai_extraction')) throw invalid(`${field} ${m} does not match origin ${origin}`, field);
  return m;
}

function factInput(v: unknown, prefix: string, origin: Origin): FactInput {
  const o = obj(v, prefix);
  onlyKeys(o, ['evidence_id', 'entity', 'metric', 'value_text', 'unit', 'group', 'comparison', 'n', 'extraction_method', 'statistics'], prefix);
  if (!isUuid(o.evidence_id)) throw invalid(`${at(prefix, 'evidence_id')} must name the evidence record the value was read from`, at(prefix, 'evidence_id'));
  const valueText = str(o.value_text, at(prefix, 'value_text'), 40, { required: true });
  if (!isNumberText(valueText)) throw invalid(`${at(prefix, 'value_text')} must be a number as written in the source (no words or ranges; exponent at most ±${MAX_EXPONENT})`, at(prefix, 'value_text'));
  if (o.unit === undefined || o.unit === null) throw invalid(`${at(prefix, 'unit')} is required ("" only while it is still unknown)`, at(prefix, 'unit'));
  if (o.n !== undefined && o.n !== null && (!Number.isInteger(o.n) || (o.n as number) < 1 || (o.n as number) > 10_000_000)) throw invalid(`${at(prefix, 'n')} must be a whole number of replicates or null`, at(prefix, 'n'));
  return {
    evidence_id: o.evidence_id.toLowerCase(),
    entity: str(o.entity, at(prefix, 'entity'), 200, { required: true }),
    metric: str(o.metric, at(prefix, 'metric'), 200, { required: true }),
    value_text: valueText,
    unit: str(o.unit, at(prefix, 'unit'), 50),
    group: str(o.group, at(prefix, 'group'), 300),
    comparison: str(o.comparison, at(prefix, 'comparison'), 300),
    n: (o.n as number | undefined) ?? null,
    extraction_method: extractionMethod(o.extraction_method, at(prefix, 'extraction_method'), origin),
    statistics: statistics(o.statistics, prefix),
  };
}

export function factMissing(f: Pick<FactInput, 'unit' | 'group' | 'comparison' | 'n' | 'metric' | 'statistics'>): string[] {
  const missing: string[] = [];
  if (!f.unit.trim()) missing.push('unit');
  if (!f.group.trim()) missing.push('group');
  if (f.n === null) missing.push('n');
  const compares = RELATIVE_METRICS.test(f.metric) || f.statistics.some((s) => PROBABILITY_KINDS.includes(s.kind));
  if (compares && !f.comparison.trim()) missing.push('comparison');
  return missing;
}

export interface FactRecord extends Omit<FactInput, 'statistics'> {
  id: string;
  paper_id: string;
  value: string;
  content_hash: string;
  origin: Origin;
  verification_state: 'CANDIDATE' | 'VERIFIED' | 'REJECTED' | 'RETRACTED';
  created_by: string;
  created_at: string;
  verified_by: string | null;
  verified_at: string | null;
  closed_at: string | null;
  statistics: Required<Statistic>[];
}
const FACT_COLS = 'f.id, f.paper_id, f.evidence_id, f.entity, f.metric, f.value, f.value_text, f.unit, f.group_label AS "group", f.comparison, f.n, f.extraction_method, f.content_hash, f.origin, f.verification_state, f.created_by, f.created_at, f.verified_by, f.verified_at, f.closed_at';
const STATS_JSON = `COALESCE((SELECT json_agg(json_build_object('kind', s.kind, 'value_text', s.value_text, 'test', s.test, 'adjustment', s.adjustment) ORDER BY s.kind)
  FROM fact_statistics s WHERE s.fact_id = f.id), '[]') AS statistics`;

// The single entry point for new facts: manual entry, import and (later) AI extraction.
// All rows are validated before anything is written; one bad row fails the whole batch.
export async function createFactCandidates(pool: TxPool, a: { paperId: string; ownerId: string; origin: Origin; facts: unknown; single?: boolean }): Promise<FactRecord[]> {
  oneOf(a.origin, 'origin', ORIGINS);
  if (!Array.isArray(a.facts) || a.facts.length < 1 || a.facts.length > 500) throw invalid('facts must be a list of 1–500 fact candidates', 'facts');
  const inputs = a.facts.map((f, i) => factInput(f, a.single ? '' : `facts[${i}]`, a.origin));
  return inTransaction(pool, async (tx) => {
    await owner(tx, a.paperId);
    const ids: string[] = [];
    try {
    for (const [i, f] of inputs.entries()) {
      const ev = await tx.query<{ extraction_state: string }>('SELECT extraction_state FROM evidence_records WHERE id = $1 AND paper_id = $2', [f.evidence_id, a.paperId]);
      const field = a.single ? 'evidence_id' : `facts[${i}].evidence_id`;
      if (!ev.rows[0]) throw new DomainError('NOT_FOUND', 'evidence record not found in this paper', field);
      if (['REJECTED', 'RETRACTED'].includes(ev.rows[0].extraction_state)) throw new DomainError('CONFLICT', 'that evidence record was rejected or retracted', field);
      const id = randomUUID();
      await tx.query(
        // the number and its source text are bound separately: a shared parameter would be typed
        // numeric and store the normalised form (2.4E3 -> 2400) as the "source" text
        `INSERT INTO fact_records (id, paper_id, evidence_id, entity, metric, value, value_text, unit, group_label, comparison, n, extraction_method, content_hash, origin, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::text, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [id, a.paperId, f.evidence_id, f.entity, f.metric, f.value_text, f.value_text, f.unit, f.group, f.comparison, f.n, f.extraction_method, contentHash(f), a.origin, a.ownerId],
      );
      for (const s of f.statistics) {
        await tx.query('INSERT INTO fact_statistics (fact_id, paper_id, kind, value, value_text, test, adjustment) VALUES ($1, $2, $3, $4::numeric, $5::text, $6, $7)', [id, a.paperId, s.kind, s.value_text, s.value_text, s.test, s.adjustment]);
      }
      ids.push(id);
    }
    } catch (e) {
      // input the checks above should already have refused; never a 500 for a bad number
      const code = (e as { code?: string }).code;
      if (code === '22003' || code === '23514' || code === '22P02') throw new DomainError('INVALID', 'a value is out of range or inconsistent', 'facts', { cause: e });
      throw e;
    }
    const out: FactRecord[] = [];
    for (const id of ids) out.push((await readFact(tx, a.paperId, id))!);
    return out;
  });
}

async function readFact(db: Queryable, paperId: string, id: string): Promise<FactRecord | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query<FactRecord>(`SELECT ${FACT_COLS}, ${STATS_JSON} FROM fact_records f WHERE f.id = $1 AND f.paper_id = $2`, [id, paperId]);
  return rows[0] ?? null;
}
export async function getFact(db: Queryable, paperId: string, id: string) {
  const f = await readFact(db, paperId, id);
  return f ? { ...f, evidence: await getEvidence(db, paperId, f.evidence_id) } : null;
}
export async function listFacts(db: Queryable, paperId: string): Promise<FactRecord[]> {
  const { rows } = await db.query<FactRecord>(`SELECT ${FACT_COLS}, ${STATS_JSON} FROM fact_records f WHERE f.paper_id = $1 ORDER BY f.created_at, f.id`, [paperId]);
  return rows;
}

export async function reviewFact(pool: TxPool, a: { paperId: string; ownerId: string; id: string; body: unknown; to: 'VERIFIED' | 'REJECTED' }) {
  const hash = reviewBody(a.body, a.to === 'VERIFIED' ? 'verify_fact' : 'reject_fact');
  await review(pool, {
    table: 'fact_records', state: 'verification_state', paperId: a.paperId, ownerId: a.ownerId, id: a.id, hash, to: a.to,
    before: async (tx) => {
      if (a.to !== 'VERIFIED') return;
      const f = (await readFact(tx, a.paperId, a.id))!;
      const ev = await tx.query<{ extraction_state: string }>('SELECT extraction_state FROM evidence_records WHERE id = $1', [f.evidence_id]);
      if (ev.rows[0]?.extraction_state !== 'VERIFIED') throw new DomainError('CONFLICT', 'verify the source evidence record before the fact read from it', 'evidence_id');
      const missing = factMissing(f);
      if (missing.length) throw invalid(`fill these before verifying: ${missing.join(', ')}`, missing[0]!, { missing });
    },
  });
  return (await getFact(pool, a.paperId, a.id))!;
}

// ---------- claims ----------

export interface Claim {
  id: string;
  paper_id: string;
  kind: (typeof CLAIM_KINDS)[number];
  text: string;
  content_hash: string;
  origin: Origin;
  approval_state: 'DRAFT' | 'APPROVED' | 'REJECTED' | 'RETRACTED';
  created_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  closed_at: string | null;
}
const CLAIM_COLS = 'id, paper_id, kind, text, content_hash, origin, approval_state, created_by, created_at, approved_by, approved_at, closed_at';

export async function createClaim(pool: TxPool, a: { paperId: string; ownerId: string; origin?: Origin; body: unknown }): Promise<Claim> {
  const b = obj(a.body, '');
  onlyKeys(b, ['kind', 'text'], '');
  const content = { kind: oneOf(b.kind, 'kind', CLAIM_KINDS), text: str(b.text, 'text', 2000, { required: true }) };
  const { rows } = await pool.query<Claim>(
    `INSERT INTO claims (id, paper_id, kind, text, content_hash, origin, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${CLAIM_COLS}`,
    [randomUUID(), a.paperId, content.kind, content.text, contentHash(content), a.origin ?? 'user', a.ownerId],
  );
  return rows[0]!;
}

async function claimLinks(db: Queryable, claimId: string) {
  const { rows } = await db.query<{ evidence_id: string; relation: string; extraction_state: string }>(
    'SELECT l.evidence_id, l.relation, e.extraction_state FROM claim_evidence_links l JOIN evidence_records e ON e.id = l.evidence_id WHERE l.claim_id = $1 ORDER BY l.created_at',
    [claimId],
  );
  return rows;
}
export async function getClaim(db: Queryable, paperId: string, id: string) {
  if (!isUuid(id)) return null;
  const { rows } = await db.query<Claim>(`SELECT ${CLAIM_COLS} FROM claims WHERE id = $1 AND paper_id = $2`, [id, paperId]);
  return rows[0] ? { ...rows[0], evidence_links: await claimLinks(db, id) } : null;
}
export async function listClaims(db: Queryable, paperId: string): Promise<Claim[]> {
  const { rows } = await db.query<Claim>(`SELECT ${CLAIM_COLS} FROM claims WHERE paper_id = $1 ORDER BY created_at, id`, [paperId]);
  return rows;
}

export async function linkClaimEvidence(pool: TxPool, a: { paperId: string; ownerId: string; claimId: string; body: unknown }) {
  const b = obj(a.body, '');
  onlyKeys(b, ['evidence_id', 'relation'], '');
  const relation = oneOf(b.relation, 'relation', LINK_RELATIONS);
  if (!isUuid(a.claimId) || !(await getClaim(pool, a.paperId, a.claimId))) throw new DomainError('NOT_FOUND', 'claim not found');
  const ev = isUuid(b.evidence_id) ? await getEvidence(pool, a.paperId, b.evidence_id) : null;
  if (!ev) throw new DomainError('NOT_FOUND', 'evidence record not found in this paper', 'evidence_id');
  if (ev.extraction_state === 'REJECTED' || ev.extraction_state === 'RETRACTED') throw new DomainError('CONFLICT', `that evidence record was ${ev.extraction_state.toLowerCase()}`, 'evidence_id');
  const { rows } = await pool.query(
    `INSERT INTO claim_evidence_links (claim_id, paper_id, evidence_id, relation, created_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING RETURNING claim_id, evidence_id, relation, created_at`,
    [a.claimId, a.paperId, ev.id, relation, a.ownerId],
  );
  if (!rows[0]) throw new DomainError('CONFLICT', 'this evidence is already linked to the claim');
  return rows[0];
}

export async function approveClaim(pool: TxPool, a: { paperId: string; ownerId: string; id: string; body: unknown }) {
  const hash = reviewBody(a.body, 'approve_claim');
  if (!isUuid(a.id)) throw new DomainError('NOT_FOUND', 'claim not found');
  return inTransaction(pool, async (tx) => {
    const { rows } = await tx.query<Claim>(`SELECT ${CLAIM_COLS} FROM claims WHERE id = $1 AND paper_id = $2 FOR UPDATE`, [a.id, a.paperId]);
    const c = rows[0];
    if (!c) throw new DomainError('NOT_FOUND', 'claim not found');
    if (c.content_hash !== hash) throw new DomainError('CONFLICT', 'this is not the claim text you reviewed (content hash differs); reload it');
    if (c.approval_state === 'APPROVED') return { ...c, evidence_links: await claimLinks(tx, c.id) };
    if (c.approval_state !== 'DRAFT') throw new DomainError('CONFLICT', `claim is ${c.approval_state.toLowerCase()}`);
    // an observation states what was measured: it needs verified evidence that supports it
    if (c.kind === 'observation') {
      const links = await tx.query('SELECT 1 FROM claim_evidence_links l JOIN evidence_records e ON e.id = l.evidence_id WHERE l.claim_id = $1 AND l.relation = $2 AND e.extraction_state = $3 FOR SHARE OF e', [c.id, 'supports', 'VERIFIED']);
      if (!links.rows[0]) throw invalid('an observation claim needs at least one verified evidence record that supports it', 'evidence_links', { evidence_missing: true });
    }
    const done = await tx.query<Claim>(`UPDATE claims SET approval_state = 'APPROVED', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1 RETURNING ${CLAIM_COLS}`, [c.id, a.ownerId]);
    return { ...done.rows[0]!, evidence_links: await claimLinks(tx, c.id) };
  });
}
