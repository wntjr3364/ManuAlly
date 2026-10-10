// A worker loop inside one process, for a single-user installation and for tests: it relays committed
// outbox rows to an in-memory hand-off and runs them through processDelivery (lease, fencing token,
// duplicate handling), recovering abandoned jobs now and then. It never decides on its own whether a
// job ran — the job row does, exactly as with the pg-boss queue.
import { randomUUID } from 'node:crypto';
import type { TxPool } from '@pw/domain/shared/db.ts';
import { reconcileInflight } from '../recovery/index.ts';
import { processDelivery, relayOutbox, type DeliveryOutcome, type JobHandler, type JobMessage } from '../queue/index.ts';

export interface LocalWorkerOptions {
  handlers: Partial<Record<string, JobHandler>>;
  workerId?: string;
  leaseMs?: number;
}

// Relays what is due and runs it (concurrently); returns each delivery's outcome.
export async function runOnce(pool: TxPool, opts: LocalWorkerOptions): Promise<{ job_id: string; outcome: DeliveryOutcome }[]> {
  const msgs: JobMessage[] = [];
  await relayOutbox(pool, async (m) => { msgs.push(m); });
  const workerId = opts.workerId ?? `local-${randomUUID().slice(0, 8)}`;
  return Promise.all(msgs.map(async (m) => ({ job_id: m.job_id, outcome: (await processDelivery(pool, m, { workerId, leaseMs: opts.leaseMs ?? 30_000, handlers: opts.handlers })).outcome })));
}

export function startLocalWorker(pool: TxPool, opts: LocalWorkerOptions & { pollMs?: number; recoverEveryMs?: number; onError?: (e: unknown) => void }) {
  let stopped = false;
  const running = new Set<Promise<unknown>>();
  const workerId = opts.workerId ?? `local-${randomUUID().slice(0, 8)}`;
  const leaseMs = opts.leaseMs ?? 30_000;
  let lastRecover = 0;
  const loop = (async () => {
    while (!stopped) {
      try {
        // PW-051: expired runs re-queued (with a status event), lost messages re-sent, ended runs settled
        if (Date.now() - lastRecover > (opts.recoverEveryMs ?? 30_000)) { await reconcileInflight(pool); lastRecover = Date.now(); }
        const msgs: JobMessage[] = [];
        await relayOutbox(pool, async (m) => { msgs.push(m); });
        for (const m of msgs) {
          const run = processDelivery(pool, m, { workerId, leaseMs, handlers: opts.handlers }).catch((e) => opts.onError?.(e));
          running.add(run);
          void run.finally(() => running.delete(run));
        }
      } catch (e) {
        opts.onError?.(e);
      }
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 200));
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      await Promise.allSettled([...running]);
    },
  };
}
