// PW-053 — fault injection for tests on a temporary database (never on a real one): a write that fails as
// if the disk were full (SQLSTATE 53100), a commit held open so a process can be killed inside it, and a
// child worker process to kill. Each injection returns its removal.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type pg from 'pg';

let n = 0;
const name = () => `pw_fault_${process.pid}_${++n}`;

// every INSERT into the table fails like a full disk (PostgreSQL: could not extend file, 53100)
export async function diskFullOn(pool: pg.Pool, table: string): Promise<() => Promise<void>> {
  const f = name();
  await pool.query(`CREATE FUNCTION ${f}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'could not extend file: No space left on device' USING ERRCODE = 'disk_full'; END $$`);
  await pool.query(`CREATE TRIGGER ${f} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${f}()`);
  return async () => {
    await pool.query(`DROP TRIGGER IF EXISTS ${f} ON ${table}`);
    await pool.query(`DROP FUNCTION IF EXISTS ${f}()`);
  };
}

// every INSERT into the table waits `secs` inside its transaction (pg_sleep), so a process can be killed
// while its commit is open
export async function holdInsertsOn(pool: pg.Pool, table: string, secs: number): Promise<() => Promise<void>> {
  const f = name();
  await pool.query(`CREATE FUNCTION ${f}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(${Number(secs)}); RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${f} AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${f}()`);
  return async () => {
    await pool.query(`DROP TRIGGER IF EXISTS ${f} ON ${table}`);
    await pool.query(`DROP FUNCTION IF EXISTS ${f}()`);
  };
}

// waits until a backend of this database sleeps inside an injected hold (holdInsertsOn)
export async function waitForHold(pool: pg.Pool, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { rows } = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event = 'PgSleep'");
    if (rows.length) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no backend held within ${timeoutMs} ms`);
}

// waits until no backend of this database is held or left inside an open transaction (a killed worker's
// transaction is rolled back by the server once its connection is found closed)
export async function untilReleased(pool: pg.Pool, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND (wait_event = 'PgSleep' OR state LIKE 'idle in transaction%')");
    if (rows[0].n === 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('a killed worker\'s transaction is still open');
}

export interface Child { proc: ChildProcess; lines: string[]; waitFor: (line: string, timeoutMs?: number) => Promise<void>; kill: () => Promise<void> }

// a worker process running one Writer delivery (tests/faults/writer-child.ts)
export function writerChild(a: { dbUrl: string; paperId: string; jobId: string; mode: 'hang_in_call' | 'normal'; leaseMs: number }): Child {
  const script = path.resolve('tests/faults/writer-child.ts');
  const proc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script, a.dbUrl, a.paperId, a.jobId, a.mode, String(a.leaseMs)], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
  const lines: string[] = [];
  let err = '';
  let buf = '';
  proc.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    const parts = buf.split('\n');
    buf = parts.pop()!;
    lines.push(...parts);
  });
  proc.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));
  return {
    proc, lines,
    async waitFor(line, timeoutMs = 20_000) {
      const end = Date.now() + timeoutMs;
      while (!lines.some((l) => l.startsWith(line))) {
        if (proc.exitCode !== null || Date.now() > end) throw new Error(`child did not print ${line} (exit ${proc.exitCode}): ${lines.join(' | ')} ${err.slice(0, 2000)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    // a crash: SIGKILL, no cleanup of any kind
    async kill() {
      if (proc.exitCode === null) proc.kill('SIGKILL');
      await exited;
    },
  };
}
