// PW-061 production server: the API (apps/api buildServer) and the built web app from one origin, bound to
// loopback. Added to every answer unless a route set its own: the browser hardening headers of security
// finding F-02 (Content-Security-Policy with frame-ancestors 'none', nosniff, no referrer, no framing).
// Session cookies are Secure (__Host-) when the public origin is https. The server does not start on a
// database whose schema is not this version's (migrations are applied by `pwctl migrate`, after a backup).
// While the data root is over its size cap (disk_pressure, set by the supervisor) uploads and new files
// are refused with 507; reading and editing go on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../apps/api/src/server.ts';
import { orderedMigrations } from '../../apps/api/src/db/migrate.ts';
import type { DeployConfig } from './check.ts';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};
// requests that add files to the data root: uploads (any non-JSON body), exports and imports
const ADDS_FILES = (method: string, url: string, type: string) => method === 'POST' && (!/^application\/json\b/.test(type) || /\/(exports|imports|submissions)(\?|$)/.test(url));

export async function schemaState(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<{ current: boolean; applied: number; expected: number; pending: string[]; unknown: string[] }> {
  const files = orderedMigrations(dir);
  let applied: string[] = [];
  try { applied = (await pool.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name); } catch { applied = []; }
  const pending = files.filter((f) => !applied.includes(f));
  const unknown = applied.filter((f) => !files.includes(f));
  return { current: pending.length === 0 && unknown.length === 0, applied: applied.length, expected: files.length, pending, unknown };
}

export async function startServer(cfg: DeployConfig, env: Record<string, string | undefined>): Promise<{ app: FastifyInstance; pool: pg.Pool; close: () => Promise<void> }> {
  const pool = new pg.Pool({ connectionString: env[cfg.database_url_env], max: 10 });
  const s = await schemaState(pool);
  if (!s.current) {
    await pool.end();
    throw new Error(`the database schema is not this version's (${s.pending.length} pending, ${s.unknown.length} unknown migrations): run \`pwctl migrate\` (it takes a backup first)`);
  }
  const app = buildServer({
    pool, allowedOrigins: [cfg.public_origin], secureCookies: cfg.public_origin.startsWith('https://'), logger: true,
    assets: { dir: path.join(cfg.data_root, 'assets') },
  });

  let pressure = false;
  const refresh = async () => { try { pressure = (await pool.query<{ p: boolean }>('SELECT disk_pressure AS p FROM ops_controls')).rows[0]?.p ?? true; } catch { pressure = true; } };
  await refresh();
  const timer = setInterval(() => void refresh(), 5_000);
  timer.unref();
  app.addHook('onRequest', async (req, reply) => {
    if (pressure && ADDS_FILES(req.method, req.url, String(req.headers['content-type'] ?? ''))) {
      return reply.code(507).send({ error: 'disk_pressure', message: 'the data folder has reached its size limit; new files are not accepted until space is freed (reading and editing go on)' });
    }
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!reply.hasHeader(k)) reply.header(k, v);
    return payload;
  });

  // the built web app: files under web_dist only; other paths (client-side routes) get index.html
  const dist = path.resolve(cfg.web_dist);
  const index = path.join(dist, 'index.html');
  if (!fs.existsSync(index)) throw new Error(`web_dist has no index.html (${dist}); build the web app first`);
  const web = async (req: { url: string }, reply: import('fastify').FastifyReply) => {
    const rel = decodeURIComponent(String(req.url).split('?')[0]!);
    if (rel.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
    const file = path.resolve(dist, `.${rel}`);
    const target = file.startsWith(`${dist}${path.sep}`) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : index;
    const ext = path.extname(target);
    reply.header('content-type', TYPES[ext] ?? 'application/octet-stream');
    reply.header('cache-control', target === index ? 'no-cache' : 'public, max-age=3600');
    return reply.send(fs.readFileSync(target));
  };
  // the app shell is public (it holds no data; every /api route keeps its own session check)
  app.get('/', { config: { public: true } }, web);
  app.get('/*', { config: { public: true } }, web);

  await app.listen({ host: cfg.listen.host, port: cfg.listen.port });
  return { app, pool, close: async () => { clearInterval(timer); await app.close(); await pool.end(); } };
}

// entry used by the supervisor: config path in PW_DEPLOY_CONFIG
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = JSON.parse(fs.readFileSync(process.env.PW_DEPLOY_CONFIG ?? '', 'utf8')) as DeployConfig;
  startServer(cfg, process.env).then(({ close }) => {
    const stop = () => void close().then(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }, (e: unknown) => { process.stderr.write(`${(e as Error).message}\n`); process.exit(1); });
}
