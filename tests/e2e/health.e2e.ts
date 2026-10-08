// E2E smoke: a real headless browser loads the API (temporary database, loopback only).
import { test, expect } from '@playwright/test';
import path from 'node:path';
import pg from 'pg';
import { createTempDatabase } from '../../packages/config/src/test-db.ts';
import { migrate } from '../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../apps/api/src/server.ts';

test('browser reaches the API health endpoint and sees the mock provider', async ({ page }) => {
  const db = await createTempDatabase();
  const pool = new pg.Pool({ connectionString: db.url, max: 2 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  const app = buildServer({ pool, allowedOrigins: [] });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    await page.goto(`${address}/api/health`);
    expect(JSON.parse(await page.locator('body').innerText())).toEqual({ ok: true, provider: 'mock' });
  } finally {
    await app.close();
    await pool.end();
    await db.drop();
  }
});
