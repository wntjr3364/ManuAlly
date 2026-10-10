// Budgets, reservations and settlement (PW-050, spec 08 "Budget").
// - setBudget(): the owner's act — a limit in USD for the app, one paper (optionally per run) or one
//   provider. The latest row of a scope counts.
// - reserveRun(): inside the run's fence. A job keeps the provider and login it started with and runs at
//   most `maxRuns` times. A run charged per call ('metered') needs a known estimate that fits every budget
//   that applies (app, paper, provider, per run); what counts against a budget is every metered run of the
//   owner: reserved at its estimate, settled at its cost (at least its estimate when the cost is unknown).
//   A free run (the MOCK) or a subscription login (limited by quota, not charged per call) needs no money
//   budget. Paid overage and reset credits are never reserved (the table refuses them).
// - settleReservation(): the run's cost from the usage ledger (reports since the run began, before the next
//   run of the job), per provider session: its cumulative session deltas if it reported any, else its
//   turns, else its messages — never two scopes added together, never a duplicate (the ledger keeps one row
//   per event key). Reports that name no session belong to the whole run (as in the ledger's summary). A
//   cost not reported is UNKNOWN, never 0 — unless the run never reached the provider (no run token or
//   run process for its fence): then it cost nothing (review m2).
// - settleOrphanReservations(): reservations of runs that ended without settling (a crash, a lost lease).
// - useJobLimit(): bounded actions per job (one repair, three searches).
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '../shared/db.ts';

export type CostClass = 'free' | 'subscription_included' | 'metered' | 'unknown';
export interface Reservation {
  id: string; job_id: string; paper_id: string; provider: string; auth_mode: string; cost_class: Exclude<CostClass, 'unknown'>; estimate_usd: string | null;
  paid_overage: boolean; reset_credit: boolean; state: 'reserved' | 'settled' | 'released'; settled_usd: string | null; settled_unknown: boolean | null; created_at: string; settled_at: string | null;
}
const COLS = 'id, job_id, paper_id, provider, auth_mode, cost_class, estimate_usd, paid_overage, reset_credit, state, settled_usd, settled_unknown, created_at, settled_at';
const bad = (m: string, f?: string) => new DomainError('INVALID', m, f);
const usd = (v: unknown, f: string) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100000) throw bad(`${f} must be an amount in USD from 0 to 100000`, f);
  return Math.round(v * 10_000) / 10_000;
};

export async function setBudget(pool: TxPool, a: { ownerId: string; body: unknown }) {
  const b = (a.body && typeof a.body === 'object' ? a.body : {}) as Record<string, unknown>;
  if (b.intent !== 'set_budget') throw bad('a budget is set with the explicit intent "set_budget"', 'intent');
  if (Object.keys(b).some((k) => !['intent', 'scope', 'paper_id', 'provider', 'limit_usd', 'run_limit_usd'].includes(k))) throw bad('unknown fields', 'body');
  if (!['app', 'paper', 'provider'].includes(b.scope as string)) throw bad('scope must be app, paper or provider', 'scope');
  const limit = usd(b.limit_usd, 'limit_usd');
  const runLimit = b.run_limit_usd === undefined || b.run_limit_usd === null ? null : usd(b.run_limit_usd, 'run_limit_usd');
  if (runLimit !== null && b.scope !== 'paper') throw bad('a per-run limit belongs to a paper budget', 'run_limit_usd');
  if (runLimit !== null && runLimit > limit) throw bad('the per-run limit cannot be above the budget', 'run_limit_usd');
  let paperId: string | null = null;
  let provider: string | null = null;
  if (b.scope === 'paper') {
    if (typeof b.paper_id !== 'string' || !UUID_RE.test(b.paper_id) || !(await pool.query('SELECT 1 FROM paper_projects WHERE id = $1 AND owner_id = $2', [b.paper_id, a.ownerId])).rowCount) throw new DomainError('NOT_FOUND', 'paper not found');
    paperId = b.paper_id;
  } else if (b.paper_id !== undefined && b.paper_id !== null) throw bad('only a paper budget names a paper', 'paper_id');
  if (b.scope === 'provider') {
    if (!['mock', 'claude_agent', 'codex'].includes(b.provider as string)) throw bad('provider must be mock, claude_agent or codex', 'provider');
    provider = b.provider as string;
  } else if (b.provider !== undefined && b.provider !== null) throw bad('only a provider budget names a provider', 'provider');
  return (await pool.query('INSERT INTO budgets (owner_id, scope, paper_id, provider, limit_usd, run_limit_usd) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, scope, paper_id, provider, limit_usd, run_limit_usd, created_at',
    [a.ownerId, b.scope, paperId, provider, limit, runLimit])).rows[0];
}

// what counts against a budget: metered runs reserved (estimate) or settled (cost; unknown → ≥ estimate)
const SPENT = `coalesce(sum(CASE WHEN state = 'reserved' THEN estimate_usd WHEN state = 'settled' AND settled_unknown THEN greatest(estimate_usd, coalesce(settled_usd, 0)) WHEN state = 'settled' THEN settled_usd ELSE 0 END), 0)`;
async function latestBudget(db: Queryable, ownerId: string, scope: string, paperId: string | null, provider: string | null) {
  return (await db.query<{ limit_usd: string; run_limit_usd: string | null }>(
    `SELECT limit_usd, run_limit_usd FROM budgets WHERE owner_id = $1 AND scope = $2 AND paper_id IS NOT DISTINCT FROM $3 AND provider IS NOT DISTINCT FROM $4 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [ownerId, scope, paperId, provider])).rows[0] ?? null;
}

export type ReserveRefusal = 'provider_changed' | 'too_many_runs' | 'cost_class_unknown' | 'cost_unknown' | 'no_budget' | 'budget_exhausted' | 'run_limit';
export async function reserveRun(pool: TxPool, a: {
  paperId: string; jobId: string; fencingToken: number; provider: string; authMode: string; costClass: CostClass; estimateUsd: number | null; maxRuns: number;
}): Promise<Reservation> {
  return inTransaction(pool, async (tx) => {
    const job = (await tx.query<{ status: string; token: number; owner_id: string }>('SELECT status, fencing_token::float8 AS token, owner_id FROM jobs WHERE id = $1 AND paper_id = $2 FOR UPDATE', [a.jobId, a.paperId])).rows[0];
    if (!job) throw new DomainError('NOT_FOUND', 'job not found');
    if (job.status !== 'RUNNING' || job.token !== a.fencingToken) throw new DomainError('CONFLICT', 'only the current run of this job is admitted (lease lost)');
    const refuse = (reason: ReserveRefusal, message: string) => new DomainError('CONFLICT', message, undefined, { details: { reason } });
    const earlier = (await tx.query<{ provider: string; auth_mode: string }>('SELECT provider, auth_mode FROM budget_reservations WHERE job_id = $1 ORDER BY created_at', [a.jobId])).rows;
    // a job keeps the provider and login it started with: never switched on its own
    if (earlier.length && (earlier[0]!.provider !== a.provider || earlier[0]!.auth_mode !== a.authMode)) throw refuse('provider_changed', `this job started on ${earlier[0]!.provider} (${earlier[0]!.auth_mode}); another provider or login needs the owner`);
    if (earlier.length >= a.maxRuns) throw refuse('too_many_runs', `this job has had ${earlier.length} runs; the owner decides whether to go on`);
    if (a.costClass === 'unknown') throw refuse('cost_class_unknown', `whether ${a.provider} (${a.authMode}) is charged per call is not known; not run`);
    let estimate: number | null = null;
    if (a.costClass === 'metered') {
      if (a.estimateUsd === null || !Number.isFinite(a.estimateUsd) || a.estimateUsd < 0) throw refuse('cost_unknown', 'the cost is not known before the run; a run charged per call needs an estimate');
      estimate = Math.round(a.estimateUsd * 10_000) / 10_000;
      // one owner's admissions one at a time: budgets are checked against everything reserved before
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('pw-budget:' || $1))", [job.owner_id]);
      // which metered runs count against each budget (parameters, never text in the query)
      const checks: { scope: string; paperId: string | null; provider: string | null; where: string; params: unknown[]; label: string }[] = [
        { scope: 'app', paperId: null, provider: null, where: "owner_id = $1 AND cost_class = 'metered'", params: [job.owner_id], label: 'the app budget' },
        { scope: 'paper', paperId: a.paperId, provider: null, where: "owner_id = $1 AND cost_class = 'metered' AND paper_id = $2", params: [job.owner_id, a.paperId], label: 'the paper budget' },
        { scope: 'provider', paperId: null, provider: a.provider, where: "owner_id = $1 AND cost_class = 'metered' AND provider = $2", params: [job.owner_id, a.provider], label: `the ${a.provider} budget` },
      ];
      let any = false;
      for (const c of checks) {
        const bgt = await latestBudget(tx, job.owner_id, c.scope, c.paperId, c.provider);
        if (!bgt) continue;
        any = true;
        if (bgt.run_limit_usd !== null && estimate > Number(bgt.run_limit_usd)) throw refuse('run_limit', `the estimate ${estimate} USD is above the paper's limit per run (${bgt.run_limit_usd} USD)`);
        const spent = Number((await tx.query<{ s: string }>(`SELECT ${SPENT} AS s FROM budget_reservations WHERE ${c.where}`, c.params)).rows[0]!.s);
        if (spent + estimate > Number(bgt.limit_usd) + 1e-9) throw refuse('budget_exhausted', `${c.label} (${bgt.limit_usd} USD) has ${Math.max(0, Number(bgt.limit_usd) - spent).toFixed(4)} USD left; this run reserves ${estimate} USD`);
      }
      if (!any) throw refuse('no_budget', 'there is no budget for runs charged per call; the owner sets one');
    }
    return (await tx.query<Reservation>(
      `INSERT INTO budget_reservations (owner_id, paper_id, job_id, fencing_token, provider, auth_mode, cost_class, estimate_usd) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
      [job.owner_id, a.paperId, a.jobId, a.fencingToken, a.provider, a.authMode, a.costClass, estimate])).rows[0]!;
  });
}

export async function settleReservation(pool: TxPool, a: { reservationId: string }): Promise<Reservation> {
  if (!UUID_RE.test(a.reservationId)) throw new DomainError('NOT_FOUND', 'reservation not found');
  return inTransaction(pool, async (tx) => {
    const r = (await tx.query<Reservation>(`SELECT ${COLS} FROM budget_reservations WHERE id = $1 FOR UPDATE`, [a.reservationId])).rows[0];
    if (!r) throw new DomainError('NOT_FOUND', 'reservation not found');
    if (r.state !== 'reserved') throw new DomainError('CONFLICT', 'this reservation is already settled');
    // this run's reports: since it began, before the job's next run (times compared in the database, at
    // its precision)
    const rows = (await tx.query<{ scope: string; native_session_id: string | null; cost_usd_estimate: string | null; delta_cost_usd: string | null }>(
      `WITH me AS (SELECT job_id, created_at FROM budget_reservations WHERE id = $1),
            nxt AS (SELECT min(b.created_at) AS at FROM budget_reservations b, me WHERE b.job_id = me.job_id AND b.created_at > me.created_at)
       SELECT u.scope, u.native_session_id, u.cost_usd_estimate, u.delta_cost_usd FROM usage_events u, me, nxt
       WHERE u.job_id = me.job_id AND u.created_at >= me.created_at AND (nxt.at IS NULL OR u.created_at < nxt.at) ORDER BY u.created_at`,
      [r.id])).rows;
    // per provider session (a run may replace its session, PW-048; review m4); reports without a session
    // describe the run's requests as a whole, so then the run is one group
    const groups = new Map<string, typeof rows>();
    const whole = rows.some((x) => x.native_session_id === null);
    for (const x of rows) { const k = whole ? '' : x.native_session_id!; groups.set(k, [...(groups.get(k) ?? []), x]); }
    let cost = 0;
    let unknown = false;
    for (const g of groups.values()) {
      const session = g.filter((x) => x.scope === 'session');
      const turns = g.filter((x) => x.scope === 'turn');
      const counted = session.length ? session.map((x) => x.delta_cost_usd) : turns.length ? turns.map((x) => x.cost_usd_estimate) : g.map((x) => x.cost_usd_estimate);
      for (const v of counted) { if (v === null) unknown = true; else cost += Number(v); }
    }
    // no report at all: a charged run that reached the provider is not known; one that never did (stopped
    // by a gate, a policy or a drift before the call) cost nothing; a free or subscription run costs nothing
    if (!rows.length && r.cost_class === 'metered') {
      const reached = (await tx.query(
        `SELECT 1 FROM budget_reservations b WHERE b.id = $1 AND (EXISTS (SELECT 1 FROM agent_run_tokens t WHERE t.job_id = b.job_id AND t.job_fencing_token = b.fencing_token)
           OR EXISTS (SELECT 1 FROM run_processes p WHERE p.job_id = b.job_id AND p.fencing_token = b.fencing_token))`, [r.id])).rowCount;
      unknown = !!reached;
    }
    return (await tx.query<Reservation>(`UPDATE budget_reservations SET state = 'settled', settled_usd = $2, settled_unknown = $3, settled_at = clock_timestamp() WHERE id = $1 RETURNING ${COLS}`,
      [r.id, Math.round(cost * 10_000) / 10_000, unknown])).rows[0]!;
  });
}

// reservations whose run ended without settling: the job runs under another fence now, or not at all
export async function settleOrphanReservations(pool: TxPool, limit = 100): Promise<number> {
  const ids = (await pool.query<{ id: string }>(
    `SELECT b.id FROM budget_reservations b JOIN jobs j ON j.id = b.job_id
     WHERE b.state = 'reserved' AND (j.status <> 'RUNNING' OR j.fencing_token <> b.fencing_token) ORDER BY b.created_at LIMIT $1`, [limit])).rows;
  let n = 0;
  for (const { id } of ids) {
    try { await settleReservation(pool, { reservationId: id }); n++; } catch (e) { if (!(e instanceof DomainError && e.code === 'CONFLICT')) throw e; }
  }
  return n;
}

export async function listReservations(db: Queryable, paperId: string, jobId: string): Promise<Reservation[]> {
  if (!UUID_RE.test(jobId)) return [];
  return (await db.query<Reservation>(`SELECT ${COLS} FROM budget_reservations WHERE paper_id = $1 AND job_id = $2 ORDER BY created_at`, [paperId, jobId])).rows;
}

export async function budgetStatus(db: Queryable, ownerId: string, paperId: string) {
  const paper = await latestBudget(db, ownerId, 'paper', paperId, null);
  const s = (await db.query<{ reserved: string; settled: string; counted: string }>(
    `SELECT coalesce(sum(estimate_usd) FILTER (WHERE state = 'reserved'), 0)::numeric(14, 4)::text AS reserved,
            coalesce(sum(settled_usd) FILTER (WHERE state = 'settled'), 0)::numeric(14, 4)::text AS settled,
            ${SPENT}::numeric(14, 4)::text AS counted
     FROM budget_reservations WHERE owner_id = $1 AND paper_id = $2 AND cost_class = 'metered'`, [ownerId, paperId])).rows[0]!;
  const app = await latestBudget(db, ownerId, 'app', null, null);
  // counted_usd: what the guard counts against the paper budget (an unknown cost at least its estimate; n2)
  return { paper: { limit_usd: paper?.limit_usd ?? null, run_limit_usd: paper?.run_limit_usd ?? null }, app: { limit_usd: app?.limit_usd ?? null }, reserved_usd: s.reserved, settled_usd: s.settled, counted_usd: s.counted };
}

export const JOB_LIMITS = { repair: 1, search: 3 } as const;
export async function useJobLimit(pool: TxPool, a: { jobId: string; kind: keyof typeof JOB_LIMITS }): Promise<number> {
  return inTransaction(pool, async (tx) => {
    const used = (await tx.query<{ used: number }>(
      `INSERT INTO job_limit_uses (job_id, kind, used) VALUES ($1, $2, 1) ON CONFLICT (job_id, kind) DO UPDATE SET used = job_limit_uses.used + 1 RETURNING used`, [a.jobId, a.kind])).rows[0]!.used;
    if (used > JOB_LIMITS[a.kind]) throw new DomainError('CONFLICT', `this job may ${a.kind} at most ${JOB_LIMITS[a.kind]} time(s)`);
    return used;
  });
}
