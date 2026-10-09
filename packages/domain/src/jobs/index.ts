// Durable jobs (spec 08 "신뢰 가능한 queue", spec 01 "논리 흐름").
// A job row is written together with its outbox message in one transaction — inside the caller's
// transaction when there is one — so a committed intent is never lost and a rolled-back one never runs.
// The same (paper, idempotency key) is one job. Workers run a job under a lease; each claim bumps a
// fencing token and only the current token may finish the job, inside a transaction that also holds
// the job's canonical write, so a stale or duplicate worker cannot change canonical state.
import { randomUUID } from 'node:crypto';
import { DomainError, UUID_RE, inTransaction, storable, type Queryable, type TxPool } from '../shared/db.ts';
import { canonicalJson, contentHash } from '../revisions/index.ts';

export const JOB_INTENTS = ['draft_paragraph', 'revise_selection', 'review', 'extract_facts', 'literature_search', 'export'] as const;
export type JobIntent = (typeof JOB_INTENTS)[number];
export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'STALE' | 'WAITING_QUOTA' | 'WAITING_AUTH' | 'WAITING_BUDGET' | 'WAITING_USER';
export const TERMINAL: JobStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE'];
export const MAX_ATTEMPTS = 3;
const KEY = /^[!-~]{1,200}$/;
const MAX_PAYLOAD_BYTES = 64 * 1024;

// what clients may see; lease owner and fencing token stay internal
export interface Job {
  id: string;
  paper_id: string;
  intent: JobIntent;
  idempotency_key: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}
const PUBLIC = 'id, paper_id, intent, idempotency_key, payload, status, attempts, last_error, result, created_at, updated_at, finished_at';
const INTERNAL = `${PUBLIC}, owner_id, fencing_token, lease_owner, lease_expires_at, payload_hash`;
interface JobRow extends Job { owner_id: string; fencing_token: string; lease_owner: string | null; lease_expires_at: string | null; payload_hash: string }

export interface JobMessage { job_id: string; paper_id: string; intent: string }

// a checked-out client (has release) is the caller's transaction; a pool needs one opened
const isTxPool = (db: Queryable | TxPool): db is TxPool => typeof (db as TxPool).connect === 'function' && typeof (db as { release?: unknown }).release !== 'function';
// run in the caller's transaction (a client), or open one (a pool)
const withTx = <T>(db: Queryable | TxPool, fn: (tx: Queryable) => Promise<T>) => (isTxPool(db) ? inTransaction(db, fn) : fn(db));
const setActor = (tx: Queryable, actor: string) => tx.query("SELECT set_config('pw.actor', $1, true)", [actor]);

// plain JSON only: a Date or Map would hash as {} and silently match a different payload
function checkPayload(v: unknown, depth = 0): void {
  const bad = (m: string) => new DomainError('INVALID', `payload ${m}`, 'payload');
  if (depth > 20) throw bad('is nested too deeply');
  if (v === null || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw bad('numbers must be finite');
    return;
  }
  if (typeof v === 'string') {
    if (!storable(v)) throw bad('contains a NUL character or an unpaired surrogate');
    return;
  }
  if (Array.isArray(v)) return v.forEach((x) => checkPayload(x, depth + 1));
  if (typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
    for (const [k, x] of Object.entries(v)) { checkPayload(k, depth + 1); checkPayload(x, depth + 1); }
    return;
  }
  throw bad(`may contain only JSON values (found ${typeof v === 'object' ? (v as object).constructor?.name ?? 'object' : typeof v})`);
}

export const MIN_LEASE_MS = 1_000;
export const MAX_LEASE_MS = 3_600_000;
function checkLease(ms: unknown): number {
  if (!Number.isInteger(ms) || (ms as number) < MIN_LEASE_MS || (ms as number) > MAX_LEASE_MS) throw new DomainError('INVALID', `lease must be a whole number of ms between ${MIN_LEASE_MS} and ${MAX_LEASE_MS}`, 'leaseMs');
  return ms as number;
}

export async function enqueueJob(db: Queryable | TxPool, a: { paperId: string; ownerId: string; intent: unknown; idempotencyKey: unknown; payload: unknown }): Promise<{ job: Job; created: boolean }> {
  if (!JOB_INTENTS.includes(a.intent as JobIntent)) throw new DomainError('INVALID', `intent must be one of ${JOB_INTENTS.join(', ')}`, 'intent');
  if (typeof a.idempotencyKey !== 'string' || !KEY.test(a.idempotencyKey)) throw new DomainError('INVALID', 'idempotency key must be 1–200 printable ASCII characters', 'idempotency_key');
  if (!a.payload || typeof a.payload !== 'object' || Array.isArray(a.payload)) throw new DomainError('INVALID', 'payload must be an object', 'payload');
  checkPayload(a.payload);
  if (Buffer.byteLength(canonicalJson(a.payload)) > MAX_PAYLOAD_BYTES) throw new DomainError('INVALID', 'payload is larger than 64 KB', 'payload');
  const hash = contentHash(a.payload);
  return withTx(db, async (tx) => {
    // inside a caller's transaction, restore its actor afterwards (e.g. a worker enqueueing a follow-up)
    const previous = (await tx.query<{ a: string | null }>("SELECT current_setting('pw.actor', true) AS a")).rows[0]!.a ?? '';
    await setActor(tx, `owner:${a.ownerId}`);
    try {
      return await enqueueIn(tx, a, hash);
    } finally {
      await setActor(tx, previous);
    }
  });
}

async function enqueueIn(tx: Queryable, a: { paperId: string; ownerId: string; intent: unknown; idempotencyKey: unknown; payload: unknown }, hash: string): Promise<{ job: Job; created: boolean }> {
  {
    if (!(await tx.query('SELECT 1 FROM paper_projects WHERE id = $1 AND owner_id = $2', [a.paperId, a.ownerId])).rows[0]) throw new DomainError('NOT_FOUND', 'paper not found');
    const id = randomUUID();
    const ins = await tx.query<Job>(
      `INSERT INTO jobs (id, paper_id, owner_id, intent, idempotency_key, payload, payload_hash) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (paper_id, idempotency_key) DO NOTHING RETURNING ${PUBLIC}`,
      [id, a.paperId, a.ownerId, a.intent, a.idempotencyKey, JSON.stringify(a.payload), hash],
    );
    // the dispatch message is written by the jobs_dispatch trigger in the same statement
    if (ins.rows[0]) return { job: ins.rows[0], created: true };
    // the same intent was registered before (possibly concurrently): return it, unless the key is reused for something else
    const { rows } = await tx.query<JobRow>(`SELECT ${INTERNAL} FROM jobs WHERE paper_id = $1 AND idempotency_key = $2`, [a.paperId, a.idempotencyKey]);
    const existing = rows[0]!;
    if (existing.intent !== a.intent || existing.payload_hash !== hash || existing.owner_id !== a.ownerId) {
      throw new DomainError('CONFLICT', 'this idempotency key was already used for a different job', 'idempotency_key');
    }
    return { job: toPublic(existing), created: false };
  }
}

const PUBLIC_KEYS = PUBLIC.split(', ') as (keyof Job)[];
function toPublic(r: JobRow): Job {
  return Object.fromEntries(PUBLIC_KEYS.map((k) => [k, r[k]])) as unknown as Job;
}

export async function getJob(db: Queryable, paperId: string, jobId: string): Promise<Job | null> {
  if (!UUID_RE.test(jobId)) return null;
  const { rows } = await db.query<Job>(`SELECT ${PUBLIC} FROM jobs WHERE id = $1 AND paper_id = $2`, [jobId, paperId]);
  return rows[0] ?? null;
}

export async function listJobs(db: Queryable, paperId: string): Promise<Job[]> {
  const { rows } = await db.query<Job>(`SELECT ${PUBLIC} FROM jobs WHERE paper_id = $1 ORDER BY created_at DESC, id LIMIT 200`, [paperId]);
  return rows;
}

// Takes the job if it is waiting, or if its previous lease has expired. Returns null otherwise.
export async function claimJob(pool: TxPool, a: { jobId: string; workerId: string; leaseMs: number }): Promise<{ job: Job; fencingToken: number } | null> {
  checkLease(a.leaseMs);
  if (!UUID_RE.test(a.jobId)) return null;
  return inTransaction(pool, async (tx) => {
    await setActor(tx, `worker:${a.workerId}`);
    const { rows } = await tx.query<JobRow & { expired: boolean }>(
      `SELECT ${INTERNAL}, (lease_expires_at < clock_timestamp()) AS expired FROM jobs WHERE id = $1 FOR UPDATE`, [a.jobId],
    );
    const j = rows[0];
    if (!j) return null;
    if (!(j.status === 'QUEUED' || (j.status === 'RUNNING' && j.expired))) return null;
    const up = await tx.query<JobRow>(
      `UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, fencing_token = fencing_token + 1, lease_owner = $2,
         lease_expires_at = clock_timestamp() + make_interval(secs => $3::double precision / 1000)
       WHERE id = $1 RETURNING ${INTERNAL}`,
      [a.jobId, a.workerId, a.leaseMs],
    );
    return { job: toPublic(up.rows[0]!), fencingToken: Number(up.rows[0]!.fencing_token) };
  });
}

export async function heartbeatJob(pool: TxPool, a: { jobId: string; fencingToken: number; leaseMs: number }): Promise<boolean> {
  checkLease(a.leaseMs);
  const { rowCount } = await pool.query(
    `UPDATE jobs SET lease_expires_at = clock_timestamp() + make_interval(secs => $3::double precision / 1000)
     WHERE id = $1 AND status = 'RUNNING' AND fencing_token = $2`,
    [a.jobId, a.fencingToken, a.leaseMs],
  );
  return rowCount === 1;
}

// Locks the job and checks the caller still holds the current lease (fencing token).
async function lockRunning(tx: Queryable, jobId: string, fencingToken: number): Promise<JobRow> {
  const { rows } = await tx.query<JobRow>(`SELECT ${INTERNAL} FROM jobs WHERE id = $1 FOR UPDATE`, [jobId]);
  const j = rows[0];
  if (!j) throw new DomainError('NOT_FOUND', 'job not found');
  if (j.status !== 'RUNNING' || Number(j.fencing_token) !== fencingToken) {
    throw new DomainError('CONFLICT', `lease lost: fencing token ${fencingToken} is not current (job is ${j.status}, token ${j.fencing_token})`);
  }
  return j;
}

// Finishes a job and applies its canonical write in the same transaction, only for the current token.
export async function completeJob(pool: TxPool, a: { jobId: string; fencingToken: number; apply?: (tx: Queryable) => Promise<void>; result?: Record<string, unknown> }): Promise<Job> {
  return inTransaction(pool, async (tx) => {
    const j = await lockRunning(tx, a.jobId, a.fencingToken);
    if (a.apply) await a.apply(tx);
    await setActor(tx, `worker:${j.lease_owner}`); // after apply, which may have set its own actor
    const { rows } = await tx.query<Job>(
      `UPDATE jobs SET status = 'SUCCEEDED', result = $2, finished_at = clock_timestamp(), lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 RETURNING ${PUBLIC}`,
      [a.jobId, a.result ? JSON.stringify(a.result) : null],
    );
    return rows[0]!;
  });
}

// Ends a run that did not succeed. 'retry' re-queues (with a new outbox message) until MAX_ATTEMPTS.
export async function failJob(pool: TxPool, a: { jobId: string; fencingToken: number; error: string; next: 'retry' | 'FAILED' | 'STALE' | 'WAITING_QUOTA' | 'WAITING_AUTH' | 'WAITING_BUDGET' | 'WAITING_USER' }): Promise<Job> {
  return inTransaction(pool, async (tx) => {
    const j = await lockRunning(tx, a.jobId, a.fencingToken);
    await setActor(tx, `worker:${j.lease_owner}`);
    const next = a.next === 'retry' ? (j.attempts >= MAX_ATTEMPTS ? 'FAILED' : 'QUEUED') : a.next;
    // a retry is dispatched again (jobs_dispatch trigger) after an exponential delay
    await tx.query("SELECT set_config('pw.dispatch_delay_secs', $1, true)", [String(2 ** j.attempts)]);
    const { rows } = await tx.query<Job>(
      `UPDATE jobs SET status = $2, last_error = $3, lease_owner = NULL, lease_expires_at = NULL,
         finished_at = CASE WHEN $2 IN ('FAILED', 'STALE') THEN clock_timestamp() END
       WHERE id = $1 RETURNING ${PUBLIC}`,
      [a.jobId, next, a.error.slice(0, 1000)],
    );
    return rows[0]!;
  });
}

// The owner stops a job. A running worker then fails its fencing check and changes nothing.
export async function cancelJob(pool: TxPool, a: { paperId: string; jobId: string; ownerId: string }): Promise<Job> {
  if (!UUID_RE.test(a.jobId)) throw new DomainError('NOT_FOUND', 'job not found');
  return inTransaction(pool, async (tx) => {
    await setActor(tx, `owner:${a.ownerId}`);
    const { rows } = await tx.query<Job>(`SELECT ${PUBLIC} FROM jobs WHERE id = $1 AND paper_id = $2 FOR UPDATE`, [a.jobId, a.paperId]);
    const j = rows[0];
    if (!j) throw new DomainError('NOT_FOUND', 'job not found');
    if (j.status === 'CANCELLED') return j;
    if (TERMINAL.includes(j.status)) throw new DomainError('CONFLICT', `job already ${j.status.toLowerCase()}`);
    const up = await tx.query<Job>(
      `UPDATE jobs SET status = 'CANCELLED', finished_at = clock_timestamp(), lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 RETURNING ${PUBLIC}`,
      [a.jobId],
    );
    return up.rows[0]!;
  });
}

// Recovers jobs a crashed worker left behind (spec 08: queue redelivery is not trusted alone).
// - RUNNING with an expired lease: back to QUEUED (dispatched again by trigger), or FAILED after
//   MAX_ATTEMPTS runs. The old worker's fencing token no longer matches anything.
// - QUEUED whose message was taken but never processed (e.g. the worker died after receiving it):
//   re-dispatched once its last publication is older than redispatchAfterMs.
// Run it periodically from the relay loop. Re-dispatching a job that is in fact still progressing
// is harmless: the second delivery cannot claim a live lease and a finished job is a duplicate.
export async function recoverJobs(pool: TxPool, opts: { redispatchAfterMs?: number } = {}): Promise<{ requeued: number; failed: number; redispatched: number }> {
  const after = opts.redispatchAfterMs ?? 5 * 60_000;
  return inTransaction(pool, async (tx) => {
    await setActor(tx, 'system:recovery');
    const expired = await tx.query<{ id: string; attempts: number }>(
      "SELECT id, attempts FROM jobs WHERE status = 'RUNNING' AND lease_expires_at < clock_timestamp() ORDER BY id FOR UPDATE SKIP LOCKED",
    );
    let requeued = 0;
    let failed = 0;
    for (const j of expired.rows) {
      const give = j.attempts >= MAX_ATTEMPTS;
      await tx.query(
        `UPDATE jobs SET status = $2, lease_owner = NULL, lease_expires_at = NULL, last_error = $3,
           finished_at = CASE WHEN $2 = 'FAILED' THEN clock_timestamp() END WHERE id = $1`,
        [j.id, give ? 'FAILED' : 'QUEUED', give ? `lease expired ${j.attempts} times; giving up` : 'lease expired; re-queued'],
      );
      if (give) failed++;
      else requeued++;
    }
    const re = await tx.query(
      `INSERT INTO job_outbox (job_id, payload)
       SELECT j.id, jsonb_build_object('job_id', j.id, 'paper_id', j.paper_id, 'intent', j.intent) FROM jobs j
       WHERE j.status = 'QUEUED'
         AND NOT EXISTS (SELECT 1 FROM job_outbox o WHERE o.job_id = j.id AND o.published_at IS NULL)
         AND (SELECT max(o.published_at) FROM job_outbox o WHERE o.job_id = j.id) <= clock_timestamp() - make_interval(secs => $1::double precision / 1000)`,
      [after],
    );
    return { requeued, failed, redispatched: re.rowCount ?? 0 };
  });
}
