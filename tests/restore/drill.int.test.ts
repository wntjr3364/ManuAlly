// PW-060 restore drill (spec 12 "배포 전 최소 한 번 실제 restore drill").
// TST-060A: a paper with its manuscript, outline, evidence, comments, references, figures (with files),
//   snapshots, exports and a frozen submission is backed up, restored into a new database and a new asset
//   store (the old ones out of reach), and served again: every reading route answers exactly as before,
//   every file comes back byte for byte, and the owners can sign in (old sessions cannot).
//   Migration compatibility: a backup taken on an older schema is restored and migrated forward, and this
//   version's server then works with it.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../packages/config/src/test-db.ts';
import { migrate } from '../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createOwner } from '../../apps/api/src/auth/owners.ts';
import { listRoutes } from '../security/routes.ts';
import { buildWorld, type World } from '../security/world.ts';
import { createBackup, referencedBlobs, restoreBackup, verifyBackup } from '../../infra/backup/backup.ts';

const ORIGIN = 'http://127.0.0.1:5173';
const MIGRATIONS = path.resolve('db/migrations');
type Db = { url: string; drop: () => Promise<void> };
const dbs: Db[] = [];
const tmp: string[] = [];
const newDb = async () => { const d = await createTempDatabase(); dbs.push(d); return d; };
const newDir = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmp.push(d); return d; };
const pools: pg.Pool[] = [];
const apps: FastifyInstance[] = [];

async function serve(url: string, assetDir: string, migrateFirst = false) {
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  pools.push(pool);
  if (migrateFirst) { const c = await pool.connect(); await migrate(c, MIGRATIONS); c.release(); }
  const app = buildServer({ pool, allowedOrigins: [ORIGIN], assets: { dir: assetDir }, eventStreamMaxMs: 300, eventPollMs: 50, zotero: { baseUrl: 'http://127.0.0.1:9' } });
  await app.ready();
  apps.push(app);
  return { pool, app };
}
async function login(app: FastifyInstance, username: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username, password: 'correct horse battery' } });
  if (r.statusCode !== 200) throw new Error(`login ${username}: ${r.statusCode} ${r.body}`);
  return { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken as string, origin: ORIGIN };
}

// ids for the path parameters of the reading routes, from the paper's records
const PARAM: Record<string, string> = {
  documentId: 'SELECT id::text FROM documents WHERE paper_id = $1',
  revisionId: 'SELECT id::text FROM document_revisions WHERE paper_id = $1 UNION SELECT id::text FROM outline_revisions WHERE paper_id = $1 UNION SELECT id::text FROM story_revisions WHERE paper_id = $1',
  assetId: 'SELECT id::text FROM asset_revisions WHERE paper_id = $1',
  snapshotId: 'SELECT id::text FROM paper_snapshots WHERE paper_id = $1',
  submissionId: 'SELECT id::text FROM submissions WHERE paper_id = $1',
  exportId: 'SELECT id::text FROM exports WHERE paper_id = $1',
  figureId: 'SELECT id::text FROM figure_objects WHERE paper_id = $1',
  claimId: 'SELECT id::text FROM claims WHERE paper_id = $1',
  evidenceId: 'SELECT id::text FROM evidence_records WHERE paper_id = $1',
  threadId: 'SELECT id::text FROM comment_threads WHERE paper_id = $1',
  commentId: 'SELECT id::text FROM review_comments WHERE paper_id = $1',
  importId: 'SELECT id::text FROM import_sources WHERE paper_id = $1',
  runId: 'SELECT id::text FROM review_runs WHERE paper_id = $1',
};
// what every reading route of a paper answers (status, type and body), with every id the route can take
async function view(app: FastifyInstance, pool: pg.Pool, headers: Record<string, string>, paperId: string) {
  const out: Record<string, string> = {};
  for (const r of listRoutes(app).filter((x) => x.method === 'GET' && x.url.startsWith('/api/papers/:paperId'))) {
    const params = [...r.url.matchAll(/:(\w+)/g)].map((m) => m[1]!).filter((p) => p !== 'paperId');
    if (params.some((p) => !PARAM[p]) || params.length > 1) continue; // routes with other parameters: covered by the table digests
    const ids = params.length ? (await pool.query(PARAM[params[0]!]!, [paperId])).rows.map((x) => Object.values(x)[0] as string) : [''];
    for (const id of ids) {
      const url = r.url.replace(':paperId', paperId).replace(/:\w+/, id);
      const res = await app.inject({ method: 'GET', url: `${url}${url.includes('/events') ? '?once=1' : ''}`, headers });
      out[url] = `${res.statusCode} ${String(res.headers['content-type'] ?? '')} ${res.rawPayload.toString('base64')}`;
    }
  }
  return out;
}

let source: { pool: pg.Pool; app: FastifyInstance };
let sourceDb: Db;
let sourceAssets: string;
let A: World;
let B: World;
let before: Record<string, Record<string, string>>;
let oldCookie: Record<string, string>;
let setDir: string;

beforeAll(async () => {
  sourceDb = await newDb();
  sourceAssets = newDir('pw060-src-assets-');
  source = await serve(sourceDb.url, sourceAssets, true);
  for (const u of ['alice', 'bob']) await createOwner(source.pool, { username: u, password: 'correct horse battery' });
  const ha = await login(source.app, 'alice');
  const hb = await login(source.app, 'bob');
  oldCookie = ha;
  A = await buildWorld(source.app, source.pool, ha, 'RESTOREALICE', '', sourceAssets);
  B = await buildWorld(source.app, source.pool, hb, 'RESTOREBOB', '', sourceAssets);
  before = { alice: await view(source.app, source.pool, ha, A.paperId), bob: await view(source.app, source.pool, hb, B.paperId) };
  setDir = path.join(newDir('pw060-sets-'), 'set-1');
  const r = await createBackup({ databaseUrl: sourceDb.url, assetDir: sourceAssets, outDir: setDir });
  if (r.status !== 'complete') throw new Error(`backup failed: ${JSON.stringify(r.manifest.problems)}`);
}, 240_000);
afterAll(async () => {
  for (const a of apps) await a.close();
  for (const p of pools) await p.end();
  for (const d of dbs) await d.drop();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

describe('TST-060A: a backup restores the whole paper in a new environment', () => {
  test('the set holds the database, every original the database refers to, and the schema version', async () => {
    const v = await verifyBackup(setDir, { migrationsDir: MIGRATIONS });
    expect(v.problems).toEqual([]);
    const m = v.manifest!;
    const c = await source.pool.connect();
    try {
      const refs = await referencedBlobs(c);
      expect(m.blobs.map((b) => b.sha256).sort()).toEqual([...refs.keys()].sort());
      // a figure file, a source PDF and the frozen submission's archive
      expect(Object.keys(m.blobs.reduce((a, b) => ({ ...a, ...b.refs }), {})).sort()).toEqual(['asset_revisions', 'exports']);
      // two figure files, the source PDF (the same synthetic bytes in both papers: one original, two rows) and two archives
      expect(m.blobs.length).toBe(5);
      expect(m.blobs.some((b) => b.refs.asset_revisions === 2)).toBe(true);
      const applied = (await c.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((x) => x.name);
      expect(m.schema.migrations.map((x) => x.name)).toEqual(applied);
    } finally { c.release(); }
    for (const t of ['documents', 'document_revisions', 'outline_revisions', 'outline_nodes', 'evidence_records', 'claims', 'comment_threads', 'comment_messages', 'reference_works', 'project_references', 'figure_objects', 'figure_versions', 'asset_revisions', 'paper_snapshots', 'snapshot_document_revisions', 'exports', 'submissions']) {
      expect(m.tables[t]!.rows, t).toBeGreaterThan(0);
    }
    expect(m.tables.sessions?.rows).toBe(0);
    expect(m.warnings.join(' ')).toMatch(/same_disk/); // this drill keeps the set on the same disk, and says so
    expect(JSON.stringify(m)).not.toMatch(/scrypt\$|password/i);
  });

  test('restored into a new database and asset store, the papers answer exactly as before, and the owners sign in again', async () => {
    const target = await newDb();
    const assets = newDir('pw060-new-assets-');
    // the old environment is out of reach: its originals moved away, its server stopped
    const moved = `${sourceAssets}-away`;
    fs.renameSync(sourceAssets, moved);
    try {
      const r = await restoreBackup({ dir: setDir, targetUrl: target.url, assetDir: assets, migrationsDir: MIGRATIONS });
      expect(r.problems).toEqual([]);
      expect(r.status).toBe('restored');
      expect(r.target).toBe('restored');
      expect(r.migrated).toEqual([]); // same version: nothing to migrate
      const restored = await serve(target.url, assets);
      // an old login does not carry over
      expect((await restored.app.inject({ method: 'GET', url: `/api/papers/${A.paperId}`, headers: oldCookie })).statusCode).toBe(401);
      const ha = await login(restored.app, 'alice');
      const hb = await login(restored.app, 'bob');
      const after = { alice: await view(restored.app, restored.pool, ha, A.paperId), bob: await view(restored.app, restored.pool, hb, B.paperId) };
      expect(Object.keys(after.alice).length).toBeGreaterThanOrEqual(40);
      for (const who of ['alice', 'bob'] as const) {
        expect(Object.keys(after[who]).sort()).toEqual(Object.keys(before[who]!).sort());
        for (const k of Object.keys(before[who]!)) expect(after[who][k], `${who} ${k}`).toBe(before[who]![k]);
      }
      // the routes the spec names are among them, with content
      const P = `/api/papers/${A.paperId}`;
      for (const k of [`${P}/outline`, `${P}/references`, `${P}/figures`, `${P}/snapshots`, `${P}/evidence`, `${P}/claims`, `${P}/submissions`]) {
        expect(after.alice[k], k).toMatch(/^200 /);
      }
      // the files themselves (source PDF, DOCX export, the frozen submission's archive), byte for byte
      const files = Object.keys(after.alice).filter((k) => /\/(assets\/[^/]+\/content|exports\/[^/]+\/file)$/.test(k) && after.alice[k]!.startsWith('200 '));
      expect(files.length).toBeGreaterThanOrEqual(3);
      // the restored server keeps working: a new snapshot and export
      expect((await restored.app.inject({ method: 'POST', url: `${P}/snapshots`, headers: ha, payload: { label: 'after restore' } })).statusCode).toBe(201);
    } finally {
      fs.renameSync(moved, sourceAssets);
    }
  });

  test('the command line runs the same drill: backup, verify, restore (exit codes 0)', async () => {
    const target = await newDb();
    const assets = newDir('pw060-cli-assets-');
    const out = path.join(newDir('pw060-cli-'), 'set');
    const node = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'infra/backup/cli.ts', ...args], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, encoding: 'utf8' });
    const b = node(['backup', '--out', out], { PW_DATABASE_URL: sourceDb.url, PW_ASSET_DIR: sourceAssets });
    expect(b.status, b.stderr + b.stdout).toBe(0);
    expect(JSON.parse(b.stdout).status).toBe('complete');
    expect(b.stdout + b.stderr).not.toContain(sourceDb.url);
    const v = node(['verify', out], {});
    expect(v.status, v.stdout).toBe(0);
    const r = node(['restore', out, '--target-env', 'PW_RESTORE_URL', '--asset-dir', assets], { PW_RESTORE_URL: target.url });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe('restored');
    // a second restore into the now non-empty database is refused
    const again = node(['restore', out, '--target-env', 'PW_RESTORE_URL', '--asset-dir', assets], { PW_RESTORE_URL: target.url });
    expect(again.status).toBe(1);
    expect(JSON.parse(again.stdout).problems.map((p: { kind: string }) => p.kind)).toEqual(['target_not_empty']);
    expect(node(['restore', out], {}).status).toBe(2);
  });
});

describe('TST-060A: a backup from an older schema migrates forward', () => {
  test('a set taken before the PW-057/058 migrations is restored, migrated, and served by this version', async () => {
    // the older version: the migrations up to PW-056
    const oldDir = newDir('pw060-old-migrations-');
    for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f < 'pw_057')) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(oldDir, f));
    const oldDb = await newDb();
    const oldAssets = newDir('pw060-old-assets-');
    const pool = new pg.Pool({ connectionString: oldDb.url });
    pools.push(pool);
    { const c = await pool.connect(); await migrate(c, oldDir); c.release(); }
    // what the older version stored: an owner, a paper, a manuscript with text, a reference, a figure file, a DOCX export
    const old = await serve(oldDb.url, oldAssets);
    await createOwner(old.pool, { username: 'dave', password: 'correct horse battery' });
    const h = await login(old.app, 'dave');
    const p = (await old.app.inject({ method: 'POST', url: '/api/papers', headers: h, payload: { working_title: 'OLDSCHEMA paper', article_type: 'research_article' } })).json();
    const P = `/api/papers/${p.id}`;
    const d = (await old.app.inject({ method: 'POST', url: `${P}/documents`, headers: h, payload: { kind: 'manuscript' } })).json();
    const content = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: '00000000-0000-4000-8000-000000000001' }, content: [{ type: 'text', text: 'OLDSCHEMA sentence.' }] }] };
    expect((await old.app.inject({ method: 'POST', url: `${P}/documents/${d.document.id}/saves`, headers: h, payload: { schema_version: 1, reason: 'manual', expected_head_revision_id: d.head.id, content_json: content } })).statusCode).toBe(201);
    expect((await old.app.inject({ method: 'POST', url: `${P}/references`, headers: h, payload: { title: 'OLDSCHEMA reference', authors: [], year: 2019 } })).statusCode).toBe(201);
    const fig = (await old.app.inject({ method: 'POST', url: `${P}/figures`, headers: h, payload: { kind: 'figure', title: 'OLDSCHEMA figure' } })).json();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('OLDSCHEMA image')]);
    expect((await old.app.inject({ method: 'POST', url: `${P}/figures/${fig.id}/files?name=f.png`, headers: { ...h, 'content-type': 'image/png' }, payload: png })).statusCode).toBe(201);
    // an export as the PW-056 version stored it (the file in the row); this version's export code writes the
    // PW-057 columns, so the older version's row is written in the older shape directly
    const saved = (await old.app.inject({ method: 'GET', url: `${P}/documents/${d.document.id}`, headers: h })).json().head.id;
    const docx = Buffer.from('PK\u0003\u0004 OLDSCHEMA export (synthetic)');
    await pool.query(`INSERT INTO exports (paper_id, document_id, revision_id, format, status, style, style_version, renderer_version, report_json, file_bytes, sha256, byte_size, created_by)
      VALUES ($1, $2, $3, 'docx', 'clean', 'vancouver', '1', 'pw-056', '{}', $4, encode(sha256($4), 'hex'), $5, $6)`, [p.id, d.document.id, saved, docx, docx.length, p.owner_id]);

    const set = path.join(newDir('pw060-old-set-'), 'set');
    const b = await createBackup({ databaseUrl: oldDb.url, assetDir: oldAssets, outDir: set });
    expect(b.manifest.problems).toEqual([]);
    expect(b.manifest.schema.migrations.at(-1)!.name < 'pw_057').toBe(true);

    const target = await newDb();
    const assets = newDir('pw060-old-new-assets-');
    const r = await restoreBackup({ dir: set, targetUrl: target.url, assetDir: assets, migrationsDir: MIGRATIONS });
    expect(r.problems).toEqual([]);
    expect(r.status).toBe('restored');
    expect(r.migrated).toEqual(fs.readdirSync(MIGRATIONS).filter((f) => f >= 'pw_057').sort());

    const now = await serve(target.url, assets);
    const h2 = await login(now.app, 'dave');
    const doc = (await now.app.inject({ method: 'GET', url: `${P}/documents/${d.document.id}`, headers: h2 })).json();
    expect(JSON.stringify(doc.head.content_json)).toContain('OLDSCHEMA sentence.');
    const exports = (await now.app.inject({ method: 'GET', url: `${P}/exports`, headers: h2 })).json();
    const exp = (exports.exports ?? exports)[0];
    const file = await now.app.inject({ method: 'GET', url: `${P}/exports/${exp.id}/file`, headers: h2 });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.toString('latin1')).toContain('OLDSCHEMA export');
    // features added after the backup's version work on the restored data
    const snap = await now.app.inject({ method: 'POST', url: `${P}/snapshots`, headers: h2, payload: { label: 'after migration' } });
    expect(snap.statusCode, snap.body).toBe(201);
    const arch = await now.app.inject({ method: 'POST', url: `${P}/exports`, headers: h2, payload: { format: 'source_archive', snapshot_id: snap.json().id, purpose: 'private' } });
    expect(arch.statusCode, arch.body).toBe(201);
  });
});
