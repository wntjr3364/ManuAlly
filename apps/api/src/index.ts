import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './server.ts';
import { migrate } from './db/migrate.ts';
import { defaultAssetDir } from '@pw/domain/asset-policy/store.ts';

// Local development entry: loopback only (no remote exposure by default).
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.PW_DATABASE_URL;
  if (!url) throw new Error('PW_DATABASE_URL is not set (see .env.example / `pnpm db:dev start`)');
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();
  await migrate(client, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations'));
  client.release();
  const origin = process.env.PW_WEB_ORIGIN ?? 'http://127.0.0.1:5173';
  // source documents live in the runtime user's own data folder unless PW_ASSET_DIR says otherwise
  const app = buildServer({ pool, allowedOrigins: [origin], logger: true, assets: { dir: defaultAssetDir() } });
  await app.listen({ host: '127.0.0.1', port: Number(process.env.PW_API_PORT ?? 8787) });
}
export { buildServer };
