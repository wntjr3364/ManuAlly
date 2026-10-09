// Usage ledger and quota observations (PW-029, spec 08 "세 가지 제한을 분리", "Quota normalization",
// "Budget"). Three different things are kept apart:
// - billed usage of runs (tokens, estimated cost), by the scope the provider reported it in: one
//   message, one turn, or the session so far (cumulative). Session reports are turned into deltas so a
//   resumed session or a redelivered report never counts twice; summing different scopes is not done.
// - context occupancy: the input size of the latest single message/turn against the model's window —
//   never the cumulative billed count.
// - account quota: per provider × auth profile × model × bucket, as observed, with its observation time.
// A value the provider did not report is UNKNOWN (null), never 0; a reset time that was not given is
// not invented.
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '../shared/db.ts';

export const PROVIDERS = ['mock', 'claude_agent', 'codex'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const SCOPES = ['message', 'turn', 'session'] as const;
export type UsageScope = (typeof SCOPES)[number];
const FIELDS = ['input_tokens', 'output_tokens', 'cost_usd_estimate', 'context_window'] as const;

export interface UsageData { scope: UsageScope; input_tokens: number | null; output_tokens: number | null; cost_usd_estimate: number | null; context_window: number | null }
export interface QuotaData { status: 'allowed' | 'warning' | 'rejected' | 'unknown'; used_percent: number | null; resets_at: string | null; raw_resets_at: string | null; unknown_reason: string | null }

const bad = (m: string, field?: string) => new DomainError('INVALID', m, field);
const count = (v: unknown, name: string): number | null => {
  if (v === null || v === undefined) return null;
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw bad(`${name} must be a whole number of at least 0, or null when not reported`, name);
  return v as number;
};
const text = (v: unknown, name: string, max: number): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !v.length || v.length > max) throw bad(`${name} must be text up to ${max} characters`, name);
  return v;
};
const when = (v: unknown, name: string): string => {
  if (v === undefined) return new Date().toISOString();
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw bad(`${name} must be a time`, name);
  return new Date(v).toISOString();
};

export interface RecordedUsage { duplicate: boolean; delta: { input_tokens: number | null; output_tokens: number | null; cost_usd: number | null } | null; anomaly: string | null }

export async function recordUsage(pool: TxPool, a: {
  paperId: string; jobId?: string | null; provider: Provider; nativeSessionId?: string | null; model?: string | null; eventKey: string; observedAt?: string; data: unknown;
}): Promise<RecordedUsage> {
  if (!PROVIDERS.includes(a.provider)) throw bad('unknown provider', 'provider');
  if (!UUID_RE.test(a.paperId) || (a.jobId != null && !UUID_RE.test(a.jobId))) throw bad('paper and job must be ids');
  const key = text(a.eventKey, 'event_key', 300)!;
  if (!key) throw bad('an event key is required', 'event_key');
  const d = (a.data ?? {}) as Record<string, unknown>;
  if (!SCOPES.includes(d.scope as UsageScope)) throw bad(`scope must be one of ${SCOPES.join(', ')}`, 'scope');
  const scope = d.scope as UsageScope;
  const input = count(d.input_tokens, 'input_tokens');
  const output = count(d.output_tokens, 'output_tokens');
  const cost = d.cost_usd_estimate === null || d.cost_usd_estimate === undefined ? null : Number(d.cost_usd_estimate);
  if (cost !== null && (!Number.isFinite(cost) || cost < 0)) throw bad('cost_usd_estimate must be at least 0, or null when not reported', 'cost_usd_estimate');
  const window = count(d.context_window, 'context_window');
  if (window === 0) throw bad('context_window must be at least 1', 'context_window');
  const values = { input_tokens: input, output_tokens: output, cost_usd_estimate: cost, context_window: window };
  const unknown = FIELDS.filter((f) => values[f] === null);
  const session = text(a.nativeSessionId, 'native_session_id', 200);
  if (scope === 'session' && !session) throw bad('a cumulative (session) report needs the native session id', 'native_session_id');
  const observed = when(a.observedAt, 'observed_at');

  return inTransaction(pool, async (tx) => {
    // one cumulative baseline per session at a time
    if (scope === 'session') await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`usage:${a.provider}:${session}`]);
    const dup = await tx.query('SELECT 1 FROM usage_events WHERE provider = $1 AND event_key = $2', [a.provider, key]);
    if (dup.rows[0]) return { duplicate: true, delta: null, anomaly: null };
    let delta: RecordedUsage['delta'] = { input_tokens: input, output_tokens: output, cost_usd: cost };
    const flag = { anomaly: null as string | null };
    if (scope === 'session') {
      // baseline: the highest value reported so far in this session (a late, lower report never
      // makes a later one count twice)
      const prev = (await tx.query<{ i: string | null; o: string | null; c: string | null }>(
        `SELECT max(input_tokens) AS i, max(output_tokens) AS o, max(cost_usd_estimate) AS c FROM usage_events
         WHERE provider = $1 AND native_session_id = $2 AND scope = 'session'`, [a.provider, session])).rows[0]!;
      const step = (cur: number | null, p: string | null) => {
        if (cur === null) return null;
        if (p === null) return cur;
        const diff = cur - Number(p);
        if (diff < 0) { flag.anomaly = 'cumulative_decreased'; return 0; }
        return diff;
      };
      delta = { input_tokens: step(input, prev.i), output_tokens: step(output, prev.o), cost_usd: step(cost, prev.c) };
      if (flag.anomaly) delta = { input_tokens: null, output_tokens: null, cost_usd: null };
      if (delta.cost_usd !== null) delta.cost_usd = Math.round(delta.cost_usd * 1e6) / 1e6;
    }
    // a concurrent delivery of the same event (not serialized by the session lock) is a duplicate too
    const ins = await tx.query(
      `INSERT INTO usage_events (paper_id, job_id, provider, native_session_id, model, event_key, scope, input_tokens, output_tokens, cost_usd_estimate, context_window,
         unknown_fields, delta_input_tokens, delta_output_tokens, delta_cost_usd, anomaly, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) ON CONFLICT (provider, event_key) DO NOTHING`,
      [a.paperId, a.jobId ?? null, a.provider, session, text(a.model, 'model', 200), key, scope, input, output, cost, window, unknown,
        scope === 'session' ? delta.input_tokens : null, scope === 'session' ? delta.output_tokens : null, scope === 'session' ? delta.cost_usd : null, flag.anomaly, observed]);
    if (ins.rowCount === 0) return { duplicate: true, delta: null, anomaly: null };
    return { duplicate: false, delta, anomaly: flag.anomaly };
  });
}

export interface Metric { value: number | null; unknown: boolean }
export interface UsageSummary {
  billed: { input_tokens: Metric; output_tokens: Metric; cost_usd_estimate: Metric; anomalies: number };
  context: { window: number | null; last_input_tokens: number | null; used_percent: number | null; basis: 'last_reported_message_or_turn' | 'unknown'; observed_at: string | null };
  by_scope: Record<UsageScope, number>;
}

// Billed totals per session: its cumulative deltas if it reported any, else its turns, else its
// messages — never two scopes added together. A field any counted report left unknown is "unknown"
// (the known part is still shown as a lower bound).
export async function usageSummary(db: Queryable, paperId: string, opts: { jobId?: string } = {}): Promise<UsageSummary> {
  const where = opts.jobId ? 'paper_id = $1 AND job_id = $2' : 'paper_id = $1';
  const params = opts.jobId ? [paperId, opts.jobId] : [paperId];
  const { rows } = await db.query<{ provider: string; native_session_id: string | null; scope: UsageScope; input_tokens: string | null; output_tokens: string | null; cost_usd_estimate: string | null;
    context_window: number | null; delta_input_tokens: string | null; delta_output_tokens: string | null; delta_cost_usd: string | null; anomaly: string | null; observed_at: string; job_id: string | null }>(
    `SELECT provider, native_session_id, scope, input_tokens, output_tokens, cost_usd_estimate, context_window, delta_input_tokens, delta_output_tokens, delta_cost_usd, anomaly, observed_at, job_id
     FROM usage_events WHERE ${where} ORDER BY observed_at, created_at`, params);
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    // reports without a session id are grouped per run (job)
    const g = `${r.provider}:${r.native_session_id ?? `job:${r.job_id ?? 'none'}`}`;
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  const total = { input_tokens: { value: 0, unknown: false }, output_tokens: { value: 0, unknown: false }, cost_usd_estimate: { value: 0, unknown: false } } as Record<'input_tokens' | 'output_tokens' | 'cost_usd_estimate', { value: number; unknown: boolean }>;
  let anomalies = 0;
  const add = (k: keyof typeof total, v: string | null) => { if (v === null) total[k].unknown = true; else total[k].value += Number(v); };
  for (const rs of groups.values()) {
    const sess = rs.filter((r) => r.scope === 'session');
    const counted = sess.length ? sess : rs.filter((r) => r.scope === 'turn').length ? rs.filter((r) => r.scope === 'turn') : rs.filter((r) => r.scope === 'message');
    for (const r of counted) {
      if (r.scope === 'session') {
        if (r.anomaly) { anomalies++; continue; }
        add('input_tokens', r.delta_input_tokens); add('output_tokens', r.delta_output_tokens); add('cost_usd_estimate', r.delta_cost_usd);
      } else {
        add('input_tokens', r.input_tokens); add('output_tokens', r.output_tokens); add('cost_usd_estimate', r.cost_usd_estimate);
      }
    }
  }
  const metric = (m: { value: number; unknown: boolean }, hasRows: boolean): Metric => (hasRows ? { value: Math.round(m.value * 1e6) / 1e6, unknown: m.unknown } : { value: null, unknown: true });
  // context: the latest single message/turn report that gave both its input size and the window
  const last = [...rows].reverse().find((r) => r.scope !== 'session' && r.input_tokens !== null && r.context_window !== null);
  const by_scope = { message: 0, turn: 0, session: 0 };
  for (const r of rows) by_scope[r.scope]++;
  return {
    billed: { input_tokens: metric(total.input_tokens, rows.length > 0), output_tokens: metric(total.output_tokens, rows.length > 0), cost_usd_estimate: metric(total.cost_usd_estimate, rows.length > 0), anomalies },
    context: last
      ? { window: last.context_window, last_input_tokens: Number(last.input_tokens), used_percent: Math.round((Number(last.input_tokens) / last.context_window!) * 1000) / 10, basis: 'last_reported_message_or_turn', observed_at: new Date(last.observed_at).toISOString() }
      : { window: null, last_input_tokens: null, used_percent: null, basis: 'unknown', observed_at: null },
    by_scope,
  };
}

const QUOTA_STATUS = ['allowed', 'warning', 'rejected', 'unknown'] as const;
const ERROR_KINDS = ['auth', 'quota', 'network', 'provider', 'unknown'] as const;

export async function recordQuota(db: Queryable, a: {
  provider: Provider; authProfileId: string; model?: string | null; bucket: string; eventKey: string; observedAt?: string; data: unknown; retryAfterS?: number | null; errorKind?: string | null;
}): Promise<{ duplicate: boolean }> {
  if (!PROVIDERS.includes(a.provider)) throw bad('unknown provider', 'provider');
  if (typeof a.authProfileId !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(a.authProfileId)) throw bad('auth profile id is invalid', 'auth_profile_id');
  const d = (a.data ?? {}) as Record<string, unknown>;
  if (!QUOTA_STATUS.includes(d.status as QuotaData['status'])) throw bad(`status must be one of ${QUOTA_STATUS.join(', ')}`, 'status');
  const used = d.used_percent === null || d.used_percent === undefined ? null : Number(d.used_percent);
  if (used !== null && (!Number.isFinite(used) || used < 0 || used > 100)) throw bad('used_percent must be between 0 and 100, or null', 'used_percent');
  let resets: string | null = null;
  if (d.resets_at !== null && d.resets_at !== undefined) {
    if (typeof d.resets_at !== 'string' || Number.isNaN(Date.parse(d.resets_at))) throw bad('resets_at must be a time, or null when not reported', 'resets_at');
    resets = new Date(d.resets_at).toISOString();
  }
  const reason = text(d.unknown_reason, 'unknown_reason', 500) ?? (resets === null ? 'reset time not reported' : null);
  const retry = a.retryAfterS === undefined || a.retryAfterS === null ? null : count(a.retryAfterS, 'retry_after_s');
  if (a.errorKind != null && !ERROR_KINDS.includes(a.errorKind as (typeof ERROR_KINDS)[number])) throw bad('unknown error kind', 'error_kind');
  // what the provider itself said, or nothing known
  const confidence = d.status === 'unknown' && used === null && resets === null ? 'unknown' : 'provider_reported';
  const r = await db.query(
    `INSERT INTO quota_observations (provider, auth_profile_id, model, bucket, event_key, status, used_percent, resets_at, raw_resets_at, unknown_reason, confidence, retry_after_s, error_kind, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT (provider, event_key) DO NOTHING`,
    [a.provider, a.authProfileId, text(a.model, 'model', 200), text(a.bucket, 'bucket', 100), text(a.eventKey, 'event_key', 300), d.status, used, resets,
      text(d.raw_resets_at, 'raw_resets_at', 100), reason, confidence, retry, a.errorKind ?? null, when(a.observedAt, 'observed_at')]);
  return { duplicate: r.rowCount === 0 };
}

export interface QuotaRow {
  provider: Provider; auth_profile_id: string; model: string | null; bucket: string; status: string; used_percent: number | null; resets_at: string | null;
  unknown_reason: string | null; confidence: string; retry_after_s: number | null; error_kind: string | null; observed_at: string;
}
// The latest observation of each bucket (an observation is what it was at its time, not now).
export async function quotaStatus(db: Queryable, a: { provider?: Provider } = {}): Promise<QuotaRow[]> {
  const { rows } = await db.query<QuotaRow & { used_percent: string | null }>(
    `SELECT DISTINCT ON (provider, auth_profile_id, model, bucket) provider, auth_profile_id, model, bucket, status, used_percent, resets_at, unknown_reason, confidence, retry_after_s, error_kind, observed_at
     FROM quota_observations WHERE ($1::text IS NULL OR provider = $1)
     ORDER BY provider, auth_profile_id, model, bucket, observed_at DESC, created_at DESC`, [a.provider ?? null]);
  return rows.map((r) => ({ ...r, used_percent: r.used_percent === null ? null : Number(r.used_percent), resets_at: r.resets_at ? new Date(r.resets_at).toISOString() : null, observed_at: new Date(r.observed_at).toISOString() }));
}
