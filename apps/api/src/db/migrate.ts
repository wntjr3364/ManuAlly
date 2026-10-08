// Plain-SQL migrations, applied in lexical order inside one transaction each.
// Applied files are checksummed: editing a migration that already ran is refused.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type pg from 'pg';

const LOCK_KEY = 728_011; // advisory lock shared by all migration runners

export async function migrate(client: pg.Client | pg.PoolClient, dir: string): Promise<string[]> {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migrations');
    const done = new Map(rows.map((r) => [r.name, r.sha256]));
    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const sha = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(file);
      if (prev) {
        if (prev !== sha) throw new Error(`migration ${file} changed after it was applied (checksum mismatch); write a new migration instead`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [file, sha]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(e as Error).message}`, { cause: e });
      }
      applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
  return applied;
}
