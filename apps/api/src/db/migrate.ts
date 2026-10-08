// Plain-SQL migrations, applied in order inside one transaction each.
// - file names must be pw_<task 3 digits>_<seq 4 digits>_<name>.sql; order = (task, seq)
// - an applied file that is edited or deleted is refused
// - a new file that sorts before the last applied one is refused (no silent reordering)
// - one runner at a time (advisory lock with a timeout)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type pg from 'pg';

const LOCK_KEY = 728_011;
export const MIGRATION_NAME = /^pw_(\d{3})_(\d{4})_[a-z0-9_]+\.sql$/;

export function orderedMigrations(dir: string): string[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const bad = files.filter((f) => !MIGRATION_NAME.test(f));
  if (bad.length) throw new Error(`migration file names must match pw_NNN_NNNN_name.sql: ${bad.join(', ')}`);
  return files.sort(); // fixed-width numeric parts make lexical order = (task, seq) order
}

async function acquireLock(client: pg.Client | pg.PoolClient, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (rows[0]!.ok) return;
    if (Date.now() > deadline) throw new Error(`another migration runner holds the lock (waited ${timeoutMs} ms)`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function migrate(client: pg.Client | pg.PoolClient, dir: string, { lockTimeoutMs = 30_000 } = {}): Promise<string[]> {
  const files = orderedMigrations(dir);
  const applied: string[] = [];
  await acquireLock(client, lockTimeoutMs);
  let failure: unknown = null;
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migrations ORDER BY name');
    const done = new Map(rows.map((r) => [r.name, r.sha256]));
    const missing = rows.map((r) => r.name).filter((n) => !files.includes(n));
    if (missing.length) throw new Error(`applied migrations are missing from ${dir}: ${missing.join(', ')}`);
    const lastApplied = rows.length ? rows[rows.length - 1]!.name : null;
    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const sha = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(file);
      if (prev) {
        if (prev !== sha) throw new Error(`migration ${file} changed after it was applied (checksum mismatch); write a new migration instead`);
        continue;
      }
      if (lastApplied && file < lastApplied) throw new Error(`migration ${file} sorts before already-applied ${lastApplied}; renumber it after the last applied migration`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [file, sha]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {}); // keep the original error
        throw new Error(`migration ${file} failed: ${(e as Error).message}`, { cause: e });
      }
      applied.push(file);
    }
  } catch (e) {
    failure = e;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    } catch (unlockError) {
      if (!failure) failure = unlockError; // never mask the original failure
    }
  }
  if (failure) throw failure;
  return applied;
}
