// PW-060 backup and restore (spec 12 "Backup"). A backup set is one point in time: the database dump and
// the immutable originals it refers to, both read under the same database snapshot, plus a manifest of the
// schema version (applied migrations), every table's row count and content digest, and every original's
// hash and size. A set is complete only when COMPLETE (the manifest's sha256) has been written, last.
//
// Restoring verifies the whole set first and touches nothing when it does not hold; it restores into an
// empty database only, checks every table against the manifest, puts the originals into the asset store,
// checks that every original the restored database refers to is there and intact, and only then migrates
// forward to this version's schema. Anything short of that is reported as failed, never as restored.
//
// Not in a backup: credentials (spec 12: they have their own recovery) and login sessions (a restored copy
// accepts no old login). The connection's password, when there is one, goes to pg_dump/pg_restore in their
// environment, never on the command line.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { IntegrityError, blobPath, putBlob, readVerified } from '../../packages/domain/src/asset-policy/store.ts';
import { migrate, orderedMigrations } from '../../apps/api/src/db/migrate.ts';

export const BACKUP_FORMAT = 'pw-backup-1';
const DUMP = 'db.dump';
const MANIFEST = 'manifest.json';
const COMPLETE = 'COMPLETE';
const BLOBS = 'blobs';

// The columns that name an original in the asset store. Every other hash-like column is listed below with
// the reason it is not one; a new hash column must be put in one of the two lists (tests/restore checks).
// `needs`: the columns the reference uses. A backup of an older schema without them has no such references
// (before PW-057 every export kept its file in its row).
export const BLOB_REFS: readonly { table: string; column: string; where: string; needs: readonly string[] }[] = [
  { table: 'asset_revisions', column: 'sha256', where: 'true', needs: ['sha256'] },
  { table: 'exports', column: 'sha256', where: 'in_asset_store', needs: ['sha256', 'in_asset_store'] },
];
// tables whose rows are not carried over (their data; the table itself is)
export const DATA_LEFT_OUT: Record<string, string> = {
  sessions: 'login sessions: a restored copy accepts no old login',
};

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const EMPTY_DIGEST = createHash('md5').update('').digest('hex'); // tableDigests() of an empty table
const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface Problem { kind: string; detail: string }
export interface TableDigest { rows: number; digest: string }
export interface Manifest {
  format: string;
  status: 'complete' | 'failed';
  created_at: string;
  schema: { migrations: { name: string; sha256: string }[] };
  database: { file: string; sha256: string; bytes: number; server_version: string; dump_tool: string; data_left_out: string[] } | null;
  tables: Record<string, TableDigest>;
  blobs: { sha256: string; bytes: number; refs: Record<string, number> }[];
  warnings: string[];
  problems: Problem[];
  not_included: string[];
}

// ---- running pg_dump / pg_restore -------------------------------------------------------------------
export interface PgTools { dir: string }
// PW_PG_BIN (an absolute directory), else the newest /usr/lib/postgresql/<n>/bin
export function findPgTools(env: Record<string, string | undefined> = process.env): PgTools {
  const given = env.PW_PG_BIN;
  if (given !== undefined) {
    if (!path.isAbsolute(given)) throw new Error('PW_PG_BIN must be an absolute directory');
    return { dir: given };
  }
  const base = '/usr/lib/postgresql';
  const versions = fs.existsSync(base) ? fs.readdirSync(base).filter((v) => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a)) : [];
  for (const v of versions) if (fs.existsSync(path.join(base, v, 'bin', 'pg_dump'))) return { dir: path.join(base, v, 'bin') };
  throw new Error('pg_dump was not found; set PW_PG_BIN to the PostgreSQL bin directory');
}

// The connection as libpq environment variables (the password stays out of the command line).
export function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  const env: Record<string, string> = { PATH: '/usr/bin:/bin', PGCONNECT_TIMEOUT: '10', PGAPPNAME: 'pw-backup' };
  const host = u.searchParams.get('host') ?? decodeURIComponent(u.hostname);
  if (host) env.PGHOST = host;
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  // TLS settings of the URL (review n3): the mode and the certificate files, as libpq reads them
  for (const [param, name] of [['sslmode', 'PGSSLMODE'], ['sslrootcert', 'PGSSLROOTCERT'], ['sslcert', 'PGSSLCERT'], ['sslkey', 'PGSSLKEY']] as const) {
    const v = u.searchParams.get(param);
    if (v) env[name] = v;
  }
  env.PGDATABASE = decodeURIComponent(u.pathname.replace(/^\//, ''));
  return env;
}

function run(tool: string, args: string[], env: Record<string, string>, timeoutMs = 30 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(tool, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr!.on('data', (d: Buffer) => { if (err.length < 16_384) err += d.toString('utf8'); });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(tool)} failed (${signal ?? `exit ${code}`}): ${err.trim().slice(-2000)}`));
    });
  });
}
const toolVersion = (tool: string) => new Promise<string>((resolve) => {
  const p = spawn(tool, ['--version'], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  p.stdout!.on('data', (d: Buffer) => { out += d.toString('utf8'); });
  p.on('error', () => resolve('unknown'));
  p.on('close', () => resolve(out.trim() || 'unknown'));
});

// ---- what the database holds ------------------------------------------------------------------------
type Q = pg.Client | pg.PoolClient;
async function tableNames(c: Q): Promise<string[]> {
  return (await c.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1")).rows.map((r) => r.t);
}
// row count and an order-independent digest of every row's text
export async function tableDigests(c: Q): Promise<Record<string, TableDigest>> {
  const out: Record<string, TableDigest> = {};
  for (const t of await tableNames(c)) {
    const { rows } = await c.query<{ n: string; d: string }>(`SELECT count(*)::text AS n, md5(coalesce(string_agg(h, '' ORDER BY h), '')) AS d FROM (SELECT md5(x::text) AS h FROM ${qi(t)} x) q`);
    out[t] = { rows: Number(rows[0]!.n), digest: rows[0]!.d };
  }
  return out;
}
// every original the database refers to, with how many rows refer to it
export async function referencedBlobs(c: Q): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  for (const r of BLOB_REFS) {
    const have = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2::text[])", [r.table, r.needs])).rows[0]!.n;
    if (have !== r.needs.length) continue;
    const { rows } = await c.query<{ h: string; n: string }>(`SELECT ${qi(r.column)} AS h, count(*)::text AS n FROM ${qi(r.table)} WHERE ${r.where} GROUP BY 1`);
    for (const row of rows) {
      const refs = out.get(row.h) ?? {};
      refs[r.table] = (refs[r.table] ?? 0) + Number(row.n);
      out.set(row.h, refs);
    }
  }
  return out;
}

async function fileSha(file: string): Promise<{ sha256: string; bytes: number }> {
  const h = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) { h.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
  return { sha256: h.digest('hex'), bytes };
}
async function writeSynced(file: string, data: string) {
  const fh = await fsp.open(file, 'wx', 0o600);
  try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
}
async function syncDir(dir: string) {
  const d = await fsp.open(dir, 'r');
  try { await d.sync(); } finally { await d.close(); }
}

// ---- backup ----------------------------------------------------------------------------------------
export interface BackupResult { status: 'complete' | 'failed'; dir: string; manifest: Manifest }

export async function createBackup(opts: { databaseUrl: string; assetDir: string; outDir: string; tools?: PgTools; now?: () => Date }): Promise<BackupResult> {
  const tools = opts.tools ?? findPgTools();
  const now = opts.now ?? (() => new Date());
  await fsp.mkdir(opts.outDir, { mode: 0o700 }); // a new folder: never added into an old set
  const manifest: Manifest = {
    format: BACKUP_FORMAT, status: 'failed', created_at: now().toISOString(), schema: { migrations: [] }, database: null,
    tables: {}, blobs: [], warnings: [], problems: [],
    not_included: ['credentials and the runtime AI login profile (recovered separately)', ...Object.keys(DATA_LEFT_OUT).map((t) => `${t} rows: ${DATA_LEFT_OUT[t]}`)],
  };
  try {
    if ((await fsp.stat(opts.outDir)).dev === (await fsp.stat(opts.assetDir)).dev) {
      manifest.warnings.push('same_disk: the set is on the same disk as the asset store; it is not a disaster-recovery copy until it is copied off this disk');
    }
  } catch { /* an absent asset store shows up below as missing originals */ }

  const c = new pg.Client({ connectionString: opts.databaseUrl });
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await c.query<{ s: string }>('SELECT pg_export_snapshot() AS s')).rows[0]!.s;
    const server = (await c.query<{ v: string }>('SHOW server_version')).rows[0]!.v;
    manifest.schema.migrations = (await c.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migrations ORDER BY name')).rows;
    manifest.tables = await tableDigests(c);
    // tables whose rows are left out are restored empty
    for (const t of Object.keys(DATA_LEFT_OUT)) if (manifest.tables[t]) manifest.tables[t] = { rows: 0, digest: EMPTY_DIGEST };
    const refs = await referencedBlobs(c);

    // the dump, under the same snapshot as everything read above
    const pgDump = path.join(tools.dir, 'pg_dump');
    const left = Object.keys(DATA_LEFT_OUT).flatMap((t) => [`--exclude-table-data=public.${t}`]);
    await run(pgDump, ['--format=custom', '--no-owner', '--no-privileges', `--snapshot=${snapshot}`, ...left, `--file=${path.join(opts.outDir, DUMP)}`], pgEnv(opts.databaseUrl));
    const dump = await fileSha(path.join(opts.outDir, DUMP));
    manifest.database = { file: DUMP, ...dump, server_version: server, dump_tool: await toolVersion(pgDump), data_left_out: Object.keys(DATA_LEFT_OUT) };

    // the originals: read and checked against their hash; a missing or damaged one fails the backup
    const blobDir = path.join(opts.outDir, BLOBS);
    for (const [hash, r] of [...refs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      let bytes: Buffer;
      try {
        bytes = await readVerified(opts.assetDir, hash);
      } catch (e) {
        if (!(e instanceof IntegrityError)) throw e;
        manifest.problems.push({ kind: /missing/.test(e.message) ? 'missing_original' : 'damaged_original', detail: `${hash} (${Object.keys(r).join(', ')}): ${e.message}` });
        continue;
      }
      await putBlob(blobDir, bytes);
      manifest.blobs.push({ sha256: hash, bytes: bytes.length, refs: r });
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    manifest.problems.push({ kind: 'backup_error', detail: (e as Error).message });
  } finally {
    await c.end();
  }

  manifest.status = manifest.problems.length ? 'failed' : 'complete';
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeSynced(path.join(opts.outDir, MANIFEST), text);
  if (manifest.status === 'complete') await writeSynced(path.join(opts.outDir, COMPLETE), `${sha256(text)}\n`);
  await syncDir(opts.outDir);
  return { status: manifest.status, dir: opts.outDir, manifest };
}

// ---- verify ----------------------------------------------------------------------------------------
export interface VerifyResult { ok: boolean; problems: Problem[]; manifest: Manifest | null }

export async function verifyBackup(dir: string, opts: { migrationsDir: string }): Promise<VerifyResult> {
  const problems: Problem[] = [];
  const fail = (kind: string, detail: string) => problems.push({ kind, detail });
  let text: string;
  try { text = await fsp.readFile(path.join(dir, MANIFEST), 'utf8'); } catch { fail('no_manifest', `${MANIFEST} is missing`); return { ok: false, problems, manifest: null }; }
  let mark = '';
  try { mark = (await fsp.readFile(path.join(dir, COMPLETE), 'utf8')).trim(); } catch { fail('incomplete_set', `${COMPLETE} is missing: the backup did not finish`); }
  if (mark && mark !== sha256(text)) fail('manifest_changed', `${MANIFEST} does not match ${COMPLETE}`);
  let m: Manifest;
  try { m = JSON.parse(text) as Manifest; } catch { fail('bad_manifest', `${MANIFEST} is not JSON`); return { ok: false, problems, manifest: null }; }
  if (m.format !== BACKUP_FORMAT) fail('unknown_format', `format ${String(m.format)}`);
  if (m.status !== 'complete') fail('failed_backup', `the backup recorded status ${String(m.status)}: ${(m.problems ?? []).map((p) => p.kind).join(', ')}`);

  // the database dump
  if (!m.database) fail('no_database', 'the set has no database dump');
  else {
    const f = path.join(dir, m.database.file);
    if (m.database.file !== DUMP || !fs.existsSync(f)) fail('missing_dump', `${DUMP} is missing`);
    else {
      const got = await fileSha(f);
      if (got.sha256 !== m.database.sha256 || got.bytes !== m.database.bytes) fail('damaged_dump', `${DUMP} does not match the manifest`);
    }
  }

  // the originals: each listed one present and intact, nothing unlisted
  const listed = new Set<string>();
  for (const b of m.blobs ?? []) {
    listed.add(b.sha256);
    let bytes: Buffer;
    try {
      bytes = await readVerified(path.join(dir, BLOBS), b.sha256);
    } catch (e) {
      fail(/missing/.test((e as Error).message) ? 'missing_original' : 'damaged_original', `${b.sha256}: ${(e as Error).message}`);
      continue;
    }
    if (bytes.length !== b.bytes) fail('damaged_original', `${b.sha256}: ${bytes.length} bytes, the manifest says ${b.bytes}`);
  }
  const root = path.join(dir, BLOBS, 'sha256');
  if (fs.existsSync(root)) {
    for (const sub of await fsp.readdir(root, { withFileTypes: true })) {
      if (!sub.isDirectory()) { fail('unlisted_file', `${BLOBS}/sha256/${sub.name}`); continue; }
      for (const name of await fsp.readdir(path.join(root, sub.name))) {
        if (!listed.has(name) || blobPath(path.join(dir, BLOBS), name) !== path.join(root, sub.name, name)) fail('unlisted_file', `${BLOBS}/sha256/${sub.name}/${name}`);
      }
    }
  }

  // the schema: every migration the backup had is one this version knows, unchanged
  const known = new Map(orderedMigrations(opts.migrationsDir).map((f) => [f, sha256(fs.readFileSync(path.join(opts.migrationsDir, f), 'utf8'))]));
  for (const mg of m.schema?.migrations ?? []) {
    const sha = known.get(mg.name);
    if (!sha) fail('schema_unknown', `${mg.name} is not a migration of this version (a backup from a newer or different version)`);
    else if (sha !== mg.sha256) fail('schema_changed', `${mg.name} differs from this version's file`);
  }
  const had = new Set((m.schema?.migrations ?? []).map((x) => x.name));
  const last = [...had].sort().pop();
  if (last) for (const f of known.keys()) if (f < last && !had.has(f)) fail('schema_gap', `${f} sorts before ${last} but was not applied in the backup`);
  return { ok: problems.length === 0, problems, manifest: m };
}

// ---- restore ---------------------------------------------------------------------------------------
// target: what the target database holds afterwards — untouched (empty), or restored data that did not pass
// the checks (drop that database), or the restored and migrated copy
export interface RestoreResult { status: 'restored' | 'failed'; target: 'untouched' | 'restored_unverified' | 'restored'; problems: Problem[]; migrated: string[]; tables: number; blobs: number }

export async function restoreBackup(opts: { dir: string; targetUrl: string; assetDir: string; migrationsDir: string; tools?: PgTools }): Promise<RestoreResult> {
  const v = await verifyBackup(opts.dir, { migrationsDir: opts.migrationsDir });
  const out: RestoreResult = { status: 'failed', target: 'untouched', problems: [...v.problems], migrated: [], tables: 0, blobs: 0 };
  if (!v.ok || !v.manifest) return out; // nothing has been touched
  const m = v.manifest;
  const tools = opts.tools ?? findPgTools();

  const c = new pg.Client({ connectionString: opts.targetUrl });
  await c.connect();
  try {
    const { rows } = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_class k JOIN pg_namespace s ON s.oid = k.relnamespace WHERE s.nspname = 'public'");
    if (rows[0]!.n > 0) { out.problems.push({ kind: 'target_not_empty', detail: 'the target database already holds tables; restore only into a new, empty database' }); return out; }

    const env = pgEnv(opts.targetUrl);
    try {
      await run(path.join(tools.dir, 'pg_restore'), ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', `--dbname=${env.PGDATABASE}`, path.join(opts.dir, DUMP)], env);
    } catch (e) {
      out.problems.push({ kind: 'restore_error', detail: (e as Error).message });
      return out; // one transaction: nothing was kept
    }
    out.target = 'restored_unverified';

    // every table as it was
    const got = await tableDigests(c);
    for (const t of new Set([...Object.keys(m.tables), ...Object.keys(got)])) {
      const a = m.tables[t];
      const b = got[t];
      if (!a || !b) out.problems.push({ kind: 'table_mismatch', detail: `${t}: ${a ? 'missing after restore' : 'not in the backup'}` });
      else if (a.rows !== b.rows || a.digest !== b.digest) out.problems.push({ kind: 'table_mismatch', detail: `${t}: ${b.rows} rows restored, ${a.rows} backed up${a.rows === b.rows ? ' (contents differ)' : ''}` });
    }
    out.tables = Object.keys(got).length;

    // the originals into the asset store, then every one the database refers to must be readable there
    for (const b of m.blobs) {
      const bytes = await readVerified(path.join(opts.dir, BLOBS), b.sha256);
      await putBlob(opts.assetDir, bytes);
      out.blobs++;
    }
    for (const [hash, r] of await referencedBlobs(c)) {
      try {
        await readVerified(opts.assetDir, hash);
      } catch (e) {
        out.problems.push({ kind: 'missing_original', detail: `${hash} (${Object.keys(r).join(', ')}): ${(e as Error).message}` });
      }
    }
    if (out.problems.length) return out; // not migrated: the restored copy is not trusted

    try {
      out.migrated = await migrate(c, opts.migrationsDir);
    } catch (e) {
      // each migration is its own transaction: the ones before the failing one stay applied (review n1)
      out.problems.push({ kind: 'migration_error', detail: (e as Error).message });
      return out;
    }
    out.status = 'restored';
    out.target = 'restored';
    return out;
  } finally {
    await c.end();
  }
}
