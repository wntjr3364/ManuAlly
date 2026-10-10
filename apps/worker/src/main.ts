// Worker entry for a single-user installation: runs AI jobs in this process with the admitted
// provider (only the mock exists until a real provider is admitted, RFC-004). Loopback DB only.
import pg from 'pg';
import { createMockProvider, selectProvider } from '@pw/providers';
import { startLocalWorker } from './local/index.ts';
import { selectionHandlers } from './selection/index.ts';
import { storyHandlers, createMockStoryGenerator } from './story/index.ts';
import { profileHandlers, createMockProfileGenerator } from './writing-profile/index.ts';
import { writerHandlers, createMockWriter } from './writer/index.ts';
import { reviewerHandlers, createMockReviewer } from './reviewer/index.ts';
import { curationHandlers, createMockAssessor } from './curation/index.ts';
import { pdfHandlers } from './pdf/index.ts';
import { defaultAssetDir } from '@pw/domain/asset-policy/store.ts';
import { reconcileRunProcesses } from './lifecycle/index.ts';
import { wakeDueWaits, withQuotaWaits } from './quota-scheduler/index.ts';
import { withAdmission } from './admission/index.ts';
import { settleOrphanReservations } from '@pw/domain/budget/index.ts';
import type { JobHandler } from './queue/index.ts';

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.PW_DATABASE_URL;
  if (!url) throw new Error('PW_DATABASE_URL is not set (see .env.example / `pnpm db:dev start`)');
  selectProvider(process.env); // refuses anything but an admitted provider
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  const admitted = <K extends string>(h: Record<K, JobHandler>) => withAdmission(pool, h, { provider: 'mock', authMode: 'none', estimateUsd: () => null });
  const worker = startLocalWorker(pool, {
    handlers: {
      // PW-050: every AI job is admitted (and settled) per run, with the provider it runs on — the MOCK is
      // free; a real provider configured here must name its login so its cost class is known (review m1)
      ...admitted(selectionHandlers(pool, createMockProvider({ chunkDelayMs: 80 }))), ...admitted(curationHandlers(pool, createMockAssessor())), ...admitted(storyHandlers(pool, createMockStoryGenerator())),
      ...admitted(profileHandlers(pool, createMockProfileGenerator())), ...admitted(withQuotaWaits(pool, writerHandlers(pool, createMockWriter()))), ...admitted(reviewerHandlers(pool, createMockReviewer())),
      ...pdfHandlers(pool, { assetDir: defaultAssetDir() }),
    },
    onError: (e) => console.error('worker error:', e instanceof Error ? e.message : e),
  });
  // RFC-010: provider run processes left by a crashed worker (or of cancelled jobs) are ended on start
  // and then every minute, under the identity check of PW-028
  const reconcile = () => reconcileRunProcesses(pool).catch((e) => console.error('reconcile error:', e instanceof Error ? e.message : e));
  void reconcile();
  const timer = setInterval(() => void reconcile(), 60_000);
  // PW-049: quota waits that are due are decided every minute. No provider offers a verified availability
  // check yet, so the probe cannot tell: a known reset that passed resumes, an unknown one keeps waiting.
  const wake = () => wakeDueWaits(pool, { now: new Date(), probe: async () => 'unknown' }).catch((e) => console.error('quota scheduler error:', e instanceof Error ? e.message : e));
  // PW-050: reservations of runs that ended without settling (a crash, a lost lease)
  const sweep = () => settleOrphanReservations(pool).catch((e) => console.error('settlement sweep error:', e instanceof Error ? e.message : e));
  const quotaTimer = setInterval(() => { void wake(); void sweep(); }, 60_000);
  const stop = async () => { clearInterval(timer); clearInterval(quotaTimer); await worker.stop(); await pool.end(); process.exit(0); };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  console.log('worker running (provider: mock — answers are labelled MOCK)');
}
