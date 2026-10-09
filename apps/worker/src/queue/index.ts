// Dispatch side of the job system (spec 08 "신뢰 가능한 queue", ADR-008).
// - relayOutbox: moves committed outbox messages to the queue. At-least-once: a crash between
//   publishing and marking re-publishes the same message later.
// - PgBossQueue: pg-boss in the same PostgreSQL, used only to carry {job_id, paper_id, intent}.
// - processDelivery: turns one delivery into at most one completed run. The job row (lease +
//   fencing token) decides; a duplicate, late or mismatched message changes nothing.
import { PgBoss } from 'pg-boss';
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '@pw/domain/shared/db.ts';
import { FAIL_NEXT, TERMINAL, claimJob, completeJob, failJob, heartbeatJob, type Job, type JobMessage } from '@pw/domain/jobs/index.ts';

export type { JobMessage };
export const QUEUE_NAME = 'pw-jobs';

export class PgBossQueue {
  readonly #boss: PgBoss;
  readonly #name: string;
  constructor(opts: { connectionString: string; schema?: string; queueName?: string }) {
    this.#boss = new PgBoss({ connectionString: opts.connectionString, schema: opts.schema ?? 'pgboss', max: 4, application_name: 'pw-worker-queue' });
    this.#name = opts.queueName ?? QUEUE_NAME;
    this.#boss.on('error', () => {}); // surfaced by the failing call; never crash the process on a pool error
  }
  async start(): Promise<void> {
    await this.#boss.start();
    if (!(await this.#boss.getQueue(this.#name))) await this.#boss.createQueue(this.#name);
  }
  async stop(): Promise<void> {
    await this.#boss.stop({ graceful: false, close: true });
  }
  async publish(msg: JobMessage): Promise<void> {
    const id = await this.#boss.send(this.#name, { job_id: msg.job_id, paper_id: msg.paper_id, intent: msg.intent });
    if (!id) throw new Error('queue did not accept the message');
  }
  // Takes up to n messages. They are acknowledged at once: redelivery after a crash comes from
  // the outbox/lease, not from the queue, so the queue never decides whether work was done.
  async receive(n: number): Promise<JobMessage[]> {
    const jobs = await this.#boss.fetch<JobMessage>(this.#name, { batchSize: n });
    if (jobs.length) await this.#boss.complete(this.#name, jobs.map((j) => j.id));
    return jobs.map((j) => j.data);
  }
}

export interface RelayResult { published: number; failed: number }

// Publishes due outbox rows. Rows are locked (SKIP LOCKED) so several relays never send the same
// row at the same time; a failed publish is recorded and retried with backoff.
export async function relayOutbox(pool: TxPool, publish: (m: JobMessage) => Promise<void>, opts: { batchSize?: number; afterPublish?: (m: JobMessage) => void } = {}): Promise<RelayResult> {
  return inTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string; payload: JobMessage; attempts: number }>(
      `SELECT id, payload, attempts FROM job_outbox WHERE published_at IS NULL AND available_at <= clock_timestamp()
       ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [opts.batchSize ?? 50],
    );
    const out: RelayResult = { published: 0, failed: 0 };
    for (const row of rows) {
      try {
        await publish(row.payload);
      } catch (e) {
        out.failed++;
        const backoffSecs = Math.min(2 ** (row.attempts + 1), 300);
        await tx.query(
          'UPDATE job_outbox SET attempts = attempts + 1, last_error = $2, available_at = clock_timestamp() + make_interval(secs => $3) WHERE id = $1',
          [row.id, (e instanceof Error ? e.message : String(e)).slice(0, 1000), backoffSecs],
        );
        continue;
      }
      opts.afterPublish?.(row.payload); // test hook: a throw here is a crash after publishing
      await tx.query('UPDATE job_outbox SET published_at = clock_timestamp(), attempts = attempts + 1 WHERE id = $1', [row.id]);
      out.published++;
    }
    return out;
  });
}

export interface HandlerContext { fencingToken: number; heartbeat: () => Promise<boolean> }
// A handler does the (non-canonical) work and returns the canonical write to apply on success.
// It must not write canonical state itself: apply runs inside completeJob under the fencing check.
export type JobHandler = (job: Job, ctx: HandlerContext) => Promise<{ apply?: (tx: Queryable, job: Job, fencingToken: number) => Promise<void>; result?: Record<string, unknown> }>;

// A handler throws this to say what the job should wait for (spec 08 "오류 종류별 동작"):
// 429 -> WAITING_QUOTA, 401/403 -> WAITING_AUTH, budget -> WAITING_BUDGET, missing evidence ->
// WAITING_USER, document conflict -> STALE, otherwise FAILED. Any other error is retried.
export class JobOutcomeError extends Error {
  readonly next: 'FAILED' | 'STALE' | 'WAITING_QUOTA' | 'WAITING_AUTH' | 'WAITING_BUDGET' | 'WAITING_USER';
  constructor(message: string, next: JobOutcomeError['next']) {
    if (next === ('retry' as never) || !FAIL_NEXT.includes(next)) throw new TypeError(`JobOutcomeError next must be one of ${FAIL_NEXT.filter((n) => n !== 'retry').join(', ')}`);
    super(message);
    this.next = next;
  }
}

export type DeliveryOutcome = 'completed' | 'duplicate' | 'skipped' | 'rejected' | 'failed' | 'lost_lease';

export async function processDelivery(pool: TxPool, msg: JobMessage, opts: { workerId: string; leaseMs: number; handlers: Partial<Record<string, JobHandler>> }): Promise<{ outcome: DeliveryOutcome; detail?: string }> {
  if (!msg || typeof msg.job_id !== 'string' || !UUID_RE.test(msg.job_id) || typeof msg.paper_id !== 'string') return { outcome: 'rejected', detail: 'malformed message' };
  const { rows } = await pool.query<{ paper_id: string; intent: string; status: Job['status'] }>('SELECT paper_id, intent, status FROM jobs WHERE id = $1', [msg.job_id]);
  const row = rows[0];
  // the message is only a pointer; the job row is authoritative and must match it
  if (!row || row.paper_id !== msg.paper_id || row.intent !== msg.intent) return { outcome: 'rejected', detail: 'message does not match a job' };
  if (row.status === 'SUCCEEDED') return { outcome: 'duplicate' };
  if (TERMINAL.includes(row.status) || row.status.startsWith('WAITING_')) return { outcome: 'skipped', detail: row.status };
  const claim = await claimJob(pool, { jobId: msg.job_id, workerId: opts.workerId, leaseMs: opts.leaseMs });
  if (!claim) return { outcome: 'duplicate', detail: 'another worker holds or finished it' };
  const { job, fencingToken } = claim;
  const handler = opts.handlers[job.intent];
  if (!handler) {
    await failJob(pool, { jobId: job.id, fencingToken, error: `no handler for ${job.intent}`, next: 'FAILED' });
    return { outcome: 'failed', detail: 'no handler' };
  }
  try {
    const out = await handler(job, { fencingToken, heartbeat: () => heartbeatJob(pool, { jobId: job.id, fencingToken, leaseMs: opts.leaseMs }) });
    await completeJob(pool, { jobId: job.id, fencingToken, apply: out.apply ? (tx) => out.apply!(tx, job, fencingToken) : undefined, result: out.result });
    return { outcome: 'completed' };
  } catch (e) {
    if (e instanceof DomainError && e.code === 'CONFLICT' && /lease lost/.test(e.message)) return { outcome: 'lost_lease' };
    try {
      await failJob(pool, { jobId: job.id, fencingToken, error: e instanceof Error ? e.message : String(e), next: e instanceof JobOutcomeError ? e.next : 'retry' });
    } catch (f) {
      if (f instanceof DomainError && f.code === 'CONFLICT') return { outcome: 'lost_lease' };
      throw f;
    }
    return { outcome: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}
