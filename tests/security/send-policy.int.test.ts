// PW-059 audit finding F-03: the paper's sending policy (spec 09 "미공개 연구자료": data_classification,
// external_send_policy, allowed_providers) is checked where paper material actually leaves for a real
// provider — runProviderTurn, before a token, a folder or a process exists — not only by each caller.
// TST-059A (explicit external-send policy): a paper that blocks sending, is sensitive, or does not list the
//   provider never reaches a run; nothing is issued or started.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../packages/config/src/test-db.ts';
import { migrate } from '../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createOwner } from '../../apps/api/src/auth/owners.ts';
import { runProviderTurn } from '../../apps/worker/src/provider-runs/index.ts';
import { JobOutcomeError } from '../../apps/worker/src/queue/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
let tmp: string;
let H: Record<string, string>;
let ownerId: string;
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 4 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  ownerId = (await createOwner(pool, { username: 'alice', password: 'correct horse battery' })).id;
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: 'alice', password: 'correct horse battery' } });
  H = { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken, origin: ORIGIN };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw059-send-'));
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('F-03: the sending policy is checked where material leaves', () => {
  test.each([
    ['blocks sending', "external_send_policy = 'block', allowed_providers = '{claude_agent}'"],
    ['sensitive', "data_classification = 'sensitive', allowed_providers = '{claude_agent}'"],
    ['provider not listed', "allowed_providers = '{codex}'"],
    ['no provider listed (the default)', "allowed_providers = '{}'"],
  ])('a paper that %s: refused before anything is issued or started', async (_, set) => {
    const paperId = (await app.inject({ method: 'POST', url: '/api/papers', headers: H, payload: { working_title: 'p', article_type: 'research_article' } })).json().id as string;
    await pool.query(`UPDATE paper_projects SET ${set} WHERE id = $1`, [paperId]);
    const runsRoot = path.join(tmp, randomUUID());
    const tokens = async () => (await pool.query('SELECT count(*)::int AS n FROM agent_run_tokens WHERE paper_id = $1', [paperId])).rows[0].n;
    const err = await runProviderTurn(pool, {
      job: { id: randomUUID(), fencingToken: 1, paperId, ownerId }, workerId: 'w', provider: 'claude_agent', decision: {} as never, cmd: '/nonexistent/claude',
      profileDir: '/nonexistent', prompt: 'x', documentId: null, handleIds: [], tools: [], session: { new: randomUUID() },
      config: { runsRoot, stateRoot: path.join(tmp, 'state'), egressAllow: [], nodePath: process.execPath } as never,
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(JobOutcomeError);
    expect((err as JobOutcomeError).next).toBe('WAITING_USER');
    expect(await tokens()).toBe(0);
    expect(fs.existsSync(runsRoot)).toBe(false);
  });
});
