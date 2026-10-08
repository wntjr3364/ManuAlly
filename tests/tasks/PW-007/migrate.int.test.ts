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
beforeAll(async () => {
  db = await createTempDatabase();
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
});
afterAll(async () => {
  await client?.end();
  await db?.drop();
});

describe('migration runner', () => {
  test('applies repo migrations once and records checksums', async () => {
    const dir = path.resolve('db/migrations');
    const first = await migrate(client, dir);
    expect(first).toContain('pw_007_0001_baseline.sql');
    expect(await migrate(client, dir)).toEqual([]);
    const { rows } = await client.query("SELECT value FROM app_meta WHERE key = 'db_schema'");
    expect(rows[0].value).toBe('p01');
  });

  test('an edited, already-applied migration is refused; a failing one rolls back', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw007-mig-'));
    try {
      fs.writeFileSync(path.join(dir, 'a_0001.sql'), 'CREATE TABLE mig_a (id int);');
      await migrate(client, dir);
      fs.writeFileSync(path.join(dir, 'a_0001.sql'), 'CREATE TABLE mig_a (id int, x int);');
      await expect(migrate(client, dir)).rejects.toThrow(/checksum mismatch/);
      fs.writeFileSync(path.join(dir, 'a_0001.sql'), 'CREATE TABLE mig_a (id int);');
      fs.writeFileSync(path.join(dir, 'a_0002.sql'), 'CREATE TABLE mig_b (id int); SELECT no_such_function();');
      await expect(migrate(client, dir)).rejects.toThrow(/a_0002.sql failed/);
      const { rows } = await client.query("SELECT to_regclass('mig_b') AS t");
      expect(rows[0].t).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
