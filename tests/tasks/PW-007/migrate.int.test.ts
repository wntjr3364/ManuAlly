// PW-007 — migration runner against a real PostgreSQL (TST-007A: registered integration command works)
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';

let db: { url: string; drop: () => Promise<void> };
let client: pg.Client;
const dirs: string[] = [];
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pw007-mig-'));
  dirs.push(d);
  return d;
};
beforeAll(async () => {
  db = await createTempDatabase();
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
});
afterAll(async () => {
  await client?.end();
  await db?.drop();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// each scenario uses its own schema_migrations by running in a fresh temp database
async function freshClient() {
  const d = await createTempDatabase();
  const c = new pg.Client({ connectionString: d.url });
  await c.connect();
  return { c, done: async () => { await c.end(); await d.drop(); }, url: d.url };
}

describe('migration runner', () => {
  test('applies repo migrations once, in order, and records checksums', async () => {
    const first = await migrate(client, path.resolve('db/migrations'));
    expect(first[0]).toBe('pw_007_0001_baseline.sql');
    expect(first).toEqual([...first].sort());
    expect(await migrate(client, path.resolve('db/migrations'))).toEqual([]);
    const { rows } = await client.query("SELECT value FROM app_meta WHERE key = 'db_schema'");
    expect(rows[0].value).toBe('p01');
  });

  test('edited or deleted applied migrations are refused; a failing one rolls back', async () => {
    const { c, done } = await freshClient();
    try {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, 'pw_900_0001_a.sql'), 'CREATE TABLE mig_a (id int);');
      await migrate(c, dir);
      fs.writeFileSync(path.join(dir, 'pw_900_0001_a.sql'), 'CREATE TABLE mig_a (id int, x int);');
      await expect(migrate(c, dir)).rejects.toThrow(/checksum mismatch/);
      fs.writeFileSync(path.join(dir, 'pw_900_0001_a.sql'), 'CREATE TABLE mig_a (id int);');
      fs.writeFileSync(path.join(dir, 'pw_900_0002_b.sql'), 'CREATE TABLE mig_b (id int); SELECT no_such_function();');
      await expect(migrate(c, dir)).rejects.toThrow(/pw_900_0002_b.sql failed/);
      expect((await c.query("SELECT to_regclass('mig_b') AS t")).rows[0].t).toBeNull();
      fs.rmSync(path.join(dir, 'pw_900_0002_b.sql'));
      fs.rmSync(path.join(dir, 'pw_900_0001_a.sql'));
      await expect(migrate(c, dir)).rejects.toThrow(/missing/);
    } finally {
      await done();
    }
  });

  test('bad names and files that sort before the last applied migration are refused', async () => {
    const { c, done } = await freshClient();
    try {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, 'p01_owner_tables.sql'), 'SELECT 1;');
      await expect(migrate(c, dir)).rejects.toThrow(/pw_NNN_NNNN_name/);
      fs.rmSync(path.join(dir, 'p01_owner_tables.sql'));
      fs.writeFileSync(path.join(dir, 'pw_900_0002_later.sql'), 'SELECT 1;');
      await migrate(c, dir);
      fs.writeFileSync(path.join(dir, 'pw_900_0001_earlier.sql'), 'SELECT 1;');
      await expect(migrate(c, dir)).rejects.toThrow(/sorts before/);
    } finally {
      await done();
    }
  });

  test('two concurrent runners apply each migration exactly once', async () => {
    const { c, done, url } = await freshClient();
    const c2 = new pg.Client({ connectionString: url });
    await c2.connect();
    try {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, 'pw_900_0001_slow.sql'), 'SELECT pg_sleep(0.5); CREATE TABLE slow_t (id int);');
      const results = await Promise.all([migrate(c, dir), migrate(c2, dir)]);
      expect(results.flat()).toEqual(['pw_900_0001_slow.sql']);
      // a runner that cannot get the lock in time fails instead of waiting forever
      await c.query('SELECT pg_advisory_lock(728011)');
      await expect(migrate(c2, dir, { lockTimeoutMs: 300 })).rejects.toThrow(/holds the lock/);
      await c.query('SELECT pg_advisory_unlock(728011)');
    } finally {
      await c2.end();
      await done();
    }
  });
});
