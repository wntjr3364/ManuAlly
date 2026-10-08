// Test database helpers. Integration tests FAIL (never skip) when PostgreSQL is not configured,
// and refuse any database whose name does not mark it as a test database.
import pg from 'pg';
import { randomBytes } from 'node:crypto';

export function requireTestDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.PW_TEST_DATABASE_URL;
  if (!url) {
    throw new Error('PW_TEST_DATABASE_URL is not set. Start the dev cluster with `pnpm db:dev start` and export the URL it prints. Integration tests do not skip.');
  }
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!/^pw_test(_|$)/.test(name)) throw new Error(`refusing to use "${name}": the test database name must start with pw_test`);
  return url;
}

// Creates an isolated, uniquely named database for one test file and returns its URL plus a drop function.
export async function createTempDatabase(baseUrl = requireTestDatabaseUrl()): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `pw_test_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  return {
    url: u.toString(),
    drop: async () => {
      const c = new pg.Client({ connectionString: baseUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
