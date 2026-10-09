// Worker entry for a single-user installation: runs AI jobs in this process with the admitted
// provider (only the mock exists until a real provider is admitted, RFC-004). Loopback DB only.
import pg from 'pg';
import { createMockProvider, selectProvider } from '@pw/providers';
import { startLocalWorker } from './local/index.ts';
import { selectionHandlers } from './selection/index.ts';

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.PW_DATABASE_URL;
  if (!url) throw new Error('PW_DATABASE_URL is not set (see .env.example / `pnpm db:dev start`)');
  selectProvider(process.env); // refuses anything but an admitted provider
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  const worker = startLocalWorker(pool, {
    handlers: selectionHandlers(pool, createMockProvider({ chunkDelayMs: 80 })),
    onError: (e) => console.error('worker error:', e instanceof Error ? e.message : e),
  });
  const stop = async () => { await worker.stop(); await pool.end(); process.exit(0); };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  console.log('worker running (provider: mock — answers are labelled MOCK)');
}
