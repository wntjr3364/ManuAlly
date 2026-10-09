// Test harness for the manual-paper E2E: temporary PostgreSQL database, the real API on loopback, and
// the real web app through Vite's dev server (which proxies /api to the API, so the browser sees one
// origin, as in deployment).
import net from 'node:net';
import path from 'node:path';
import pg from 'pg';
import { createServer, type ViteDevServer } from 'vite';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { startLocalWorker } from '../../../apps/worker/src/local/index.ts';
import { selectionHandlers } from '../../../apps/worker/src/selection/index.ts';
import { createMockProvider } from '../../../packages/providers/src/mock/index.ts';

export interface Harness {
  webUrl: string;
  pool: pg.Pool;
  failRevisionInserts(on: boolean): Promise<void>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

// worker: run AI jobs in this process with the mock provider (PW-020); chunkDelayMs makes streaming visible
export async function startHarness(opts: { worker?: { chunkDelayMs?: number } } = {}): Promise<Harness> {
  const root = path.resolve('.');
  const db = await createTempDatabase();
  const pool = new pg.Pool({ connectionString: db.url, max: 6 });
  const c = await pool.connect();
  await migrate(c, path.join(root, 'db/migrations'));
  c.release();
  await createOwner(pool, { username: 'alice', password: 'correct horse battery' });
  const origins: string[] = [];
  const app = buildServer({ pool, allowedOrigins: origins });
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const worker = opts.worker ? startLocalWorker(pool, { handlers: selectionHandlers(pool, createMockProvider(opts.worker)), pollMs: 50 }) : null;
  const port = await freePort();
  let vite: ViteDevServer | undefined;
  try {
    vite = await createServer({
      configFile: path.join(root, 'apps/web/vite.config.ts'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/api': { target: api } } },
    });
    await vite.listen();
  } catch (e) {
    await worker?.stop();
    await app.close();
    await pool.end();
    await db.drop();
    throw e;
  }
  const webUrl = `http://127.0.0.1:${port}`;
  origins.push(webUrl);
  return {
    webUrl,
    pool,
    async failRevisionInserts(on) {
      if (on) {
        await pool.query(`CREATE OR REPLACE FUNCTION pw_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'simulated database failure'; END $$`);
        await pool.query('CREATE TRIGGER pw_test_fail BEFORE INSERT ON document_revisions FOR EACH ROW EXECUTE FUNCTION pw_test_fail()');
      } else {
        await pool.query('DROP TRIGGER IF EXISTS pw_test_fail ON document_revisions');
      }
    },
    async stop() {
      await vite?.close();
      await worker?.stop();
      await app.close();
      await pool.end();
      await db.drop();
    },
  };
}
