// PW-060 TST-060B: a backup that holds only the database, or whose originals are missing, damaged or not
// the ones the database refers to, is never reported as a success — not when it is taken, not when it is
// verified, not when it is restored. A failed restore is not migrated.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../packages/config/src/test-db.ts';
import { migrate } from '../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createOwner } from '../../apps/api/src/auth/owners.ts';
import { blobPath } from '../../packages/domain/src/asset-policy/store.ts';
import { BLOB_REFS, createBackup, findPgTools, pgEnv, restoreBackup, verifyBackup, type Manifest } from '../../infra/backup/backup.ts';

const ORIGIN = 'http://127.0.0.1:5173';
const MIGRATIONS = path.resolve('db/migrations');
type Db = { url: string; drop: () => Promise<void> };
const dbs: Db[] = [];
const tmp: string[] = [];
const newDb = async () => { const d = await createTempDatabase(); dbs.push(d); return d; };
const newDir = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmp.push(d); return d; };
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let db: Db;
let pool: pg.Pool;
let app: FastifyInstance;
let assets: string;
let good: string; // a complete set, copied for each case
const hashes: string[] = [];

beforeAll(async () => {
  db = await newDb();
  pool = new pg.Pool({ connectionString: db.url, max: 4 });
  { const c = await pool.connect(); await migrate(c, MIGRATIONS); c.release(); }
  assets = newDir('pw060b-assets-');
  app = buildServer({ pool, allowedOrigins: [ORIGIN], assets: { dir: assets } });
  await app.ready();
  await createOwner(pool, { username: 'erin', password: 'correct horse battery' });
  const l = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: 'erin', password: 'correct horse battery' } });
  const h = { cookie: String(l.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': l.json().csrfToken as string, origin: ORIGIN };
  const p = (await app.inject({ method: 'POST', url: '/api/papers', headers: h, payload: { working_title: 'B paper', article_type: 'research_article' } })).json();
  for (const n of [1, 2]) {
    const fig = (await app.inject({ method: 'POST', url: `/api/papers/${p.id}/figures`, headers: h, payload: { kind: 'figure', title: `figure ${n}` } })).json();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`figure ${n} bytes`)]);
    const r = await app.inject({ method: 'POST', url: `/api/papers/${p.id}/figures/${fig.id}/files?name=f.png`, headers: { ...h, 'content-type': 'image/png' }, payload: png });
    hashes.push(r.json().sha256);
  }
  good = path.join(newDir('pw060b-good-'), 'set');
  const b = await createBackup({ databaseUrl: db.url, assetDir: assets, outDir: good });
  if (b.status !== 'complete') throw new Error(JSON.stringify(b.manifest.problems));
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pool?.end();
  for (const d of dbs) await d.drop();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

const copy = () => { const d = path.join(newDir('pw060b-case-'), 'set'); fs.cpSync(good, d, { recursive: true }); for (const f of walk(d)) fs.chmodSync(f, 0o600); return d; };
function walk(d: string): string[] { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])); }
const kinds = (ps: { kind: string }[]) => ps.map((p) => p.kind);
const readManifest = (d: string) => JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8')) as Manifest;
// rewrites the manifest and its COMPLETE mark consistently (a forged or hand-edited set)
const rewrite = (d: string, f: (m: Manifest) => void) => {
  const m = readManifest(d);
  f(m);
  const text = `${JSON.stringify(m, null, 2)}\n`;
  fs.writeFileSync(path.join(d, 'manifest.json'), text);
  fs.writeFileSync(path.join(d, 'COMPLETE'), `${sha(text)}\n`);
};
// a restore that must fail leaves the target unmigrated and says so
async function restoreFails(d: string, expected: string[], left: 'untouched' | 'restored_unverified' = 'untouched') {
  const target = await newDb();
  const out = newDir('pw060b-restore-');
  const r = await restoreBackup({ dir: d, targetUrl: target.url, assetDir: out, migrationsDir: MIGRATIONS });
  expect(r.status).toBe('failed');
  expect(r.migrated).toEqual([]);
  expect(r.target).toBe(left);
  for (const k of expected) expect(kinds(r.problems)).toContain(k);
  return { r, target };
}

describe('TST-060B: a backup is complete only with every original the database refers to', () => {
  test('a missing original in the store fails the backup: no COMPLETE mark, and verify and restore refuse it', async () => {
    const f = blobPath(assets, hashes[0]!);
    const keep = fs.readFileSync(f);
    fs.chmodSync(f, 0o600);
    fs.unlinkSync(f);
    try {
      const d = path.join(newDir('pw060b-'), 'set');
      const b = await createBackup({ databaseUrl: db.url, assetDir: assets, outDir: d });
      expect(b.status).toBe('failed');
      expect(kinds(b.manifest.problems)).toEqual(['missing_original']);
      expect(fs.existsSync(path.join(d, 'COMPLETE'))).toBe(false);
      const v = await verifyBackup(d, { migrationsDir: MIGRATIONS });
      expect(v.ok).toBe(false);
      expect(kinds(v.problems)).toEqual(expect.arrayContaining(['incomplete_set', 'failed_backup']));
      const { target } = await restoreFails(d, ['incomplete_set']);
      const c = new pg.Client({ connectionString: target.url });
      await c.connect();
      expect((await c.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'")).rows[0].n).toBe(0); // untouched
      await c.end();
    } finally {
      fs.writeFileSync(f, keep, { mode: 0o444 });
    }
  });

  test('a damaged original in the store fails the backup', async () => {
    const f = blobPath(assets, hashes[1]!);
    const keep = fs.readFileSync(f);
    fs.chmodSync(f, 0o600);
    fs.writeFileSync(f, Buffer.concat([keep, Buffer.from('x')]));
    try {
      const b = await createBackup({ databaseUrl: db.url, assetDir: assets, outDir: path.join(newDir('pw060b-'), 'set') });
      expect(b.status).toBe('failed');
      expect(kinds(b.manifest.problems)).toEqual(['damaged_original']);
    } finally {
      fs.writeFileSync(f, keep);
      fs.chmodSync(f, 0o444);
    }
  });

  test('a database-only set (the originals folder gone) is refused', async () => {
    const d = copy();
    fs.rmSync(path.join(d, 'blobs'), { recursive: true });
    expect(kinds((await verifyBackup(d, { migrationsDir: MIGRATIONS })).problems)).toEqual(['missing_original', 'missing_original']);
    await restoreFails(d, ['missing_original']);
  });

  test('a database-only set whose manifest was rewritten to list no originals is caught by the restored database', async () => {
    const d = copy();
    fs.rmSync(path.join(d, 'blobs'), { recursive: true });
    rewrite(d, (m) => { m.blobs = []; });
    expect((await verifyBackup(d, { migrationsDir: MIGRATIONS })).ok).toBe(true); // the set agrees with itself …
    const { r } = await restoreFails(d, ['missing_original'], 'restored_unverified'); // … but not with what the database refers to
    expect(r.problems.filter((p) => p.kind === 'missing_original')).toHaveLength(2);
  });

  test('a damaged, swapped or unlisted original in the set is refused', async () => {
    const d1 = copy();
    const f1 = blobPath(path.join(d1, 'blobs'), hashes[0]!);
    const b = fs.readFileSync(f1);
    b.writeUInt8(b.readUInt8(b.length - 1) ^ 1, b.length - 1);
    fs.writeFileSync(f1, b);
    expect(kinds((await verifyBackup(d1, { migrationsDir: MIGRATIONS })).problems)).toEqual(['damaged_original']);
    await restoreFails(d1, ['damaged_original']);

    const d2 = copy(); // one original in the other's place
    fs.copyFileSync(blobPath(path.join(d2, 'blobs'), hashes[1]!), blobPath(path.join(d2, 'blobs'), hashes[0]!));
    expect(kinds((await verifyBackup(d2, { migrationsDir: MIGRATIONS })).problems)).toEqual(['damaged_original']);

    const d3 = copy();
    const extra = Buffer.from('not listed');
    fs.mkdirSync(path.dirname(blobPath(path.join(d3, 'blobs'), sha(extra))), { recursive: true });
    fs.writeFileSync(blobPath(path.join(d3, 'blobs'), sha(extra)), extra);
    expect(kinds((await verifyBackup(d3, { migrationsDir: MIGRATIONS })).problems)).toEqual(['unlisted_file']);

    const d4 = copy(); // a stray file where a folder belongs
    fs.writeFileSync(path.join(d4, 'blobs', 'sha256', 'stray'), 'x');
    expect(kinds((await verifyBackup(d4, { migrationsDir: MIGRATIONS })).problems)).toEqual(['unlisted_file']);
  });

  test('a manifest whose original size was edited is refused', async () => {
    const d = copy();
    rewrite(d, (m) => { m.blobs[0]!.bytes += 1; });
    expect(kinds((await verifyBackup(d, { migrationsDir: MIGRATIONS })).problems)).toEqual(['damaged_original']);
  });

  test('a truncated dump, a missing dump, a missing mark or an edited manifest is refused', async () => {
    const d1 = copy();
    const dump = path.join(d1, 'db.dump');
    fs.truncateSync(dump, fs.statSync(dump).size - 100);
    expect(kinds((await verifyBackup(d1, { migrationsDir: MIGRATIONS })).problems)).toEqual(['damaged_dump']);
    await restoreFails(d1, ['damaged_dump']);

    const d2 = copy();
    fs.rmSync(path.join(d2, 'db.dump'));
    expect(kinds((await verifyBackup(d2, { migrationsDir: MIGRATIONS })).problems)).toEqual(['missing_dump']);

    const d3 = copy();
    fs.rmSync(path.join(d3, 'COMPLETE'));
    expect(kinds((await verifyBackup(d3, { migrationsDir: MIGRATIONS })).problems)).toEqual(['incomplete_set']);

    const d4 = copy();
    const m = readManifest(d4);
    m.blobs = m.blobs.slice(1);
    fs.writeFileSync(path.join(d4, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
    expect(kinds((await verifyBackup(d4, { migrationsDir: MIGRATIONS })).problems)).toEqual(['manifest_changed', 'unlisted_file']);

    const d5 = copy();
    fs.rmSync(path.join(d5, 'manifest.json'));
    expect(kinds((await verifyBackup(d5, { migrationsDir: MIGRATIONS })).problems)).toEqual(['no_manifest']);
  });

  test('a table that does not come back as it was backed up fails the restore, which is then not migrated', async () => {
    const d = copy();
    rewrite(d, (m) => { m.tables.figure_objects = { rows: m.tables.figure_objects!.rows + 1, digest: m.tables.figure_objects!.digest }; });
    const { r } = await restoreFails(d, ['table_mismatch'], 'restored_unverified');
    expect(r.problems.find((p) => p.kind === 'table_mismatch')!.detail).toMatch(/^figure_objects: 2 rows restored, 3 backed up/);

    const d2 = copy();
    rewrite(d2, (m) => { m.tables.references_items_gone = { rows: 0, digest: 'x' }; });
    await restoreFails(d2, ['table_mismatch'], 'restored_unverified');
  });

  test('a set from a newer or different schema is refused before anything is restored', async () => {
    const d1 = copy();
    rewrite(d1, (m) => { m.schema.migrations.push({ name: 'pw_099_0001_future.sql', sha256: 'f'.repeat(64) }); });
    expect(kinds((await verifyBackup(d1, { migrationsDir: MIGRATIONS })).problems)).toEqual(['schema_unknown']);
    await restoreFails(d1, ['schema_unknown']);

    const d2 = copy();
    rewrite(d2, (m) => { m.schema.migrations[3]!.sha256 = '0'.repeat(64); });
    expect(kinds((await verifyBackup(d2, { migrationsDir: MIGRATIONS })).problems)).toEqual(['schema_changed']);

    const d3 = copy();
    rewrite(d3, (m) => { m.schema.migrations.splice(2, 1); });
    expect(kinds((await verifyBackup(d3, { migrationsDir: MIGRATIONS })).problems)).toEqual(['schema_gap']);
  });

  test('a backup is never written into an existing folder', async () => {
    await expect(createBackup({ databaseUrl: db.url, assetDir: assets, outDir: good })).rejects.toThrow(/EEXIST/);
    expect((await verifyBackup(good, { migrationsDir: MIGRATIONS })).ok).toBe(true);
  });
});

describe('TST-060B: one point in time', () => {
  test('a write that lands while pg_dump starts is in neither the dump nor the manifest (one snapshot)', async () => {
    // a pg_dump that first writes a row through its own connection, then dumps (the real tool)
    const real = findPgTools().dir;
    const bin = newDir('pw060b-tools-');
    fs.writeFileSync(path.join(bin, 'pg_dump'), `#!/bin/sh\n"${real}/psql" -X -q -c "INSERT INTO owners (username, password_hash) VALUES ('late_writer', 'scrypt\\$synthetic')" >/dev/null || exit 9\nexec "${real}/pg_dump" "$@"\n`, { mode: 0o755 });
    fs.symlinkSync(path.join(real, 'pg_restore'), path.join(bin, 'pg_restore'));
    const d = path.join(newDir('pw060b-'), 'set');
    const b = await createBackup({ databaseUrl: db.url, assetDir: assets, outDir: d, tools: { dir: bin } });
    expect(b.manifest.problems).toEqual([]);
    expect((await pool.query("SELECT count(*)::int AS n FROM owners WHERE username = 'late_writer'")).rows[0].n).toBe(1); // the write happened
    const target = await newDb();
    const r = await restoreBackup({ dir: d, targetUrl: target.url, assetDir: newDir('pw060b-restore-'), migrationsDir: MIGRATIONS });
    expect(r.problems).toEqual([]);
    const c = new pg.Client({ connectionString: target.url });
    await c.connect();
    expect((await c.query("SELECT count(*)::int AS n FROM owners WHERE username = 'late_writer'")).rows[0].n).toBe(0);
    await c.end();
    await pool.query("DELETE FROM owners WHERE username = 'late_writer'");
  });
});

describe('TST-060B: what a backup holds and how it connects', () => {
  test('every hash-like column is classified: an original in the store, or not one (with the reason)', async () => {
    // columns that hold a hash of something other than an original in the asset store
    const NOT_ORIGINALS: Record<string, string> = {
      'owners.password_hash': 'login secret',
      'sessions.token_hash': 'login session (its rows are not backed up)',
      'sessions.csrf_hash': 'login session',
      'agent_run_tokens.token_hash': 'tool gateway run token',
      'agent_tool_calls.args_sha256': 'hash of a tool call\'s arguments (audit)',
      'schema_migrations.sha256': 'hash of a migration file (the schema version, in the manifest)',
      'pdf_extractions.sha256': 'the asset revision it was extracted from (also in asset_revisions)',
      'pdf_anchors.sha256': 'the asset revision it anchors on (also in asset_revisions)',
      'import_sources.source_sha256': 'the imported file is kept in the database row',
      'submissions.docx_sha256': 'hash of the DOCX inside the archive export (the archive is in exports)',
      'literature_searches.response_sha256': 'hash of a search response (not kept as a file)',
    };
    const { rows } = await pool.query<{ k: string }>("SELECT table_name || '.' || column_name AS k FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name) WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND (column_name LIKE '%sha256%' OR column_name ~ '(^|_)(token|password|csrf)_hash$') ORDER BY 1");
    const refs = new Set(BLOB_REFS.map((r) => `${r.table}.${r.column}`));
    expect(rows.map((r) => r.k).filter((k) => !refs.has(k) && !NOT_ORIGINALS[k])).toEqual([]);
    expect(Object.keys(NOT_ORIGINALS).filter((k) => !rows.some((r) => r.k === k))).toEqual([]);
  });

  test('the password goes to pg_dump in its environment, never on its command line', () => {
    const env = pgEnv('postgres://u%40x:s3cr%2Ft@db.example:6543/pw_prod?sslmode=require');
    expect(env).toMatchObject({ PGHOST: 'db.example', PGPORT: '6543', PGUSER: 'u@x', PGPASSWORD: 's3cr/t', PGDATABASE: 'pw_prod', PGSSLMODE: 'require' });
    expect(Object.keys(env).sort()).toEqual(['PATH', 'PGAPPNAME', 'PGCONNECT_TIMEOUT', 'PGDATABASE', 'PGHOST', 'PGPASSWORD', 'PGPORT', 'PGSSLMODE', 'PGUSER']);
    expect(pgEnv('postgres://pw@localhost:54329/pw_test?host=/tmp/sock')).toMatchObject({ PGHOST: '/tmp/sock', PGUSER: 'pw' });
    const m = readManifest(good);
    expect(JSON.stringify(m)).not.toContain(db.url);
  });
});
