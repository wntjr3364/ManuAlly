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

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.PW_DATABASE_URL;
  if (!url) throw new Error('PW_DATABASE_URL is not set (see .env.example / `pnpm db:dev start`)');
  selectProvider(process.env); // refuses anything but an admitted provider
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  const worker = startLocalWorker(pool, {
    handlers: { ...selectionHandlers(pool, createMockProvider({ chunkDelayMs: 80 })), ...curationHandlers(pool, createMockAssessor()), ...storyHandlers(pool, createMockStoryGenerator()), ...profileHandlers(pool, createMockProfileGenerator()), // PW-050: admitted (and settled) per run; the MOCK is free and needs no money budget
      ...withAdmission(pool, withQuotaWaits(pool, writerHandlers(pool, createMockWriter())), { provider: 'mock', authMode: 'none', estimateUsd: () => null }), ...reviewerHandlers(pool, createMockReviewer()), ...pdfHandlers(pool, { assetDir: defaultAssetDir() }) },
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
  const quotaTimer = setInterval(() => void wake(), 60_000);
  const stop = async () => { clearInterval(timer); clearInterval(quotaTimer); await worker.stop(); await pool.end(); process.exit(0); };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  console.log('worker running (provider: mock — answers are labelled MOCK)');
}
