// PW-030 — the P03 provider chain, end to end, against a stand-in Codex app-server (no model call).
// It composes what P03 built, as the worker will: a claimed job → a run token bound to that run
// (PW-027/028) → the Codex adapter under an admission decision (PW-025) → the model's tool call goes
// through the gateway and becomes a pending proposal (PW-017/027) → the provider's usage reports go to
// the ledger (PW-029) → the job completes under its fencing token. Then: stop in the middle of a turn
// (nothing is created, the token is dead), and resume of the stored thread id only.
// What this does NOT show: that the real Codex CLI behaves like the stand-in (see reports/p03).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { parseDocument, snapshotSelection } from '../../../packages/editor-core/src/index.ts';
import { claimJob, completeJob, enqueueJob } from '../../../packages/domain/src/jobs/index.ts';
import { callTool, issueRunToken } from '../../../packages/domain/src/tool-policy/index.ts';
import { recordUsage, usageSummary } from '../../../packages/domain/src/usage/index.ts';
import { decideCodexCall, startCodexServer, type CodexRun } from '../../../packages/providers/src/codex/index.ts';
import { FEATURES, loadRegistry, type Registry } from '../../../packages/providers/src/core/index.ts';
import type { ProviderEvent } from '../../../packages/contracts/src/provider/index.ts';
import { validateProviderEvent } from '../../../packages/contracts/src/provider/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
const FAKE = path.resolve('tests/integration/providers/fake-codex-gateway.mjs');
const P1 = '00000000-0000-4000-8000-0000000000a1';
const host = os.hostname();
const KEY = { version: 'codex-cli 0.161.0', auth_mode: 'chatgpt_login', deployment_profile: 'PERSONAL_LOCAL' as const };
// a registry as it would be after a passed live smoke on this machine — test-only; the shipped
// registry stays requires_verification (asserted in the gate test)
const now = Date.now();
const APPROVED: Registry = loadRegistry({ entries: [{
  capability: { provider: 'codex', ...KEY, admission: 'approved', features: Object.fromEntries(FEATURES.map((f) => [f, 'unknown'])) },
  evidence: { live_evidence: { checked_at: new Date(now).toISOString(), cli_version: KEY.version, host, tests: ['PW-030 stand-in'], passed: true } },
}] });
const decision = () => decideCodexCall(APPROVED, {
  key: KEY, purpose: 'paper_work', approval: { approved: true, max_turns: 5, budget_usd: 1 },
  sentinel: { provider: 'codex', status: 'isolated', host, checked_at: new Date(now - 60e3).toISOString() },
  sandbox: { kind: 'userns', verified: true, host, checked_at: new Date(now - 60e3).toISOString() }, now, host,
});

let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
let H: Record<string, string>;
let ownerId: string;
let root: string;
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  ownerId = (await createOwner(pool, { username: 'alice', password: 'correct horse battery' })).id;
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: 'alice', password: 'correct horse battery' } });
  H = { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken, origin: ORIGIN };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw030-'));
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
  fs.rmSync(root, { recursive: true, force: true });
});

async function paperWithSelection() {
  const paperId = (await app.inject({ method: 'POST', url: '/api/papers', headers: H, payload: { working_title: 'p', article_type: 'research_article' } })).json().id;
  const d = (await app.inject({ method: 'POST', url: `/api/papers/${paperId}/documents`, headers: H, payload: { kind: 'manuscript' } })).json();
  const content = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P1 }, content: [{ type: 'text', text: 'It was very very clear.' }] }] };
  const head = (await app.inject({ method: 'POST', url: `/api/papers/${paperId}/documents/${d.document.id}/saves`, headers: H, payload: { expected_head_revision_id: d.head.id, content_json: content, schema_version: 1, reason: 'manual' } })).json().id;
  const selection = await snapshotSelection(parseDocument(content, 1), { blockId: P1, from: 7, to: 22 });
  const handle = (await app.inject({ method: 'POST', url: `/api/papers/${paperId}/documents/${d.document.id}/selection-handles`, headers: H, payload: { base_revision_id: head, selection } })).json();
  return { paperId: paperId as string, documentId: d.document.id as string, head: head as string, handleId: handle.id as string };
}
function runFolders(): CodexRun {
  const dir = fs.mkdtempSync(path.join(root, 'run-'));
  const r = { dir, cwd: path.join(dir, 'work'), homeDir: path.join(dir, 'home'), tmpDir: path.join(dir, 'tmp') };
  for (const x of [r.cwd, r.homeDir, r.tmpDir]) fs.mkdirSync(x, { mode: 0o700 });
  return r;
}
function profile(toolCall: unknown, flags: string[] = []) {
  const p = fs.mkdtempSync(path.join(root, 'profile-'));
  fs.chmodSync(p, 0o700);
  fs.writeFileSync(path.join(p, 'tool-call.json'), JSON.stringify(toolCall));
  for (const f of flags) fs.writeFileSync(path.join(p, f), '');
  return p;
}

// what the worker will do for one Codex run (composition only; the worker wiring is P05's Writer)
async function runCodexJob(s: Awaited<ReturnType<typeof paperWithSelection>>, opts: { flags?: string[]; stopAfter?: number; resumeThread?: string } = {}) {
  const { job } = await enqueueJob(pool, { paperId: s.paperId, ownerId, intent: 'revise_selection', idempotencyKey: randomUUID(), payload: { handle_id: s.handleId } });
  const { fencingToken } = (await claimJob(pool, { jobId: job.id, workerId: 'w1', leaseMs: 60_000 }))!;
  const token = await issueRunToken(pool, { ownerId, paperId: s.paperId, documentId: s.documentId, handleIds: [s.handleId], provider: 'codex', tools: ['get_document_slice', 'propose_manuscript_edit'], ttlMs: 10 * 60_000, jobId: job.id, fencingToken });
  const toolAnswers: unknown[] = [];
  const server = await startCodexServer({
    decision: decision(), cmd: FAKE, run: runFolders(), parentEnv: { PATH: process.env.PATH! }, homes: [os.homedir()],
    profileDir: profile({ tool: 'propose_manuscript_edit', arguments: { handle_id: s.handleId, intent: 'concise', replacement: [{ type: 'text', text: 'clear' }], explanation: 'shorter' } }, opts.flags),
    // the model's tool call → the gateway with this run's token (the token never reaches the provider)
    onToolCall: async (name, args) => {
      const out = await callTool(pool, token.token, name, args);
      toolAnswers.push(out);
      return { content: [{ type: 'text', text: JSON.stringify(out.ok ? out.result : out.error) }], isError: !out.ok };
    },
  });
  const thread = opts.resumeThread ? await server.resumeThread(opts.resumeThread) : await server.startThread();
  const events: ProviderEvent[] = [];
  let n = 0;
  for await (const e of server.runTurn(thread, 'Make the selection concise.')) {
    events.push(e);
    if (e.kind === 'usage') await recordUsage(pool, { paperId: s.paperId, jobId: job.id, provider: 'codex', nativeSessionId: thread, eventKey: `${thread}:${job.id}:${n++}`, data: e.data });
    if (opts.stopAfter !== undefined && events.length >= opts.stopAfter) {
      await app.inject({ method: 'POST', url: `/api/papers/${s.paperId}/jobs/${job.id}/cancel`, headers: H, payload: {} });
      break; // the adapter interrupts and settles the turn (PW-025 review)
    }
  }
  await server.close();
  return { job, fencingToken, token, thread, events, toolAnswers };
}

describe('P03 chain against the stand-in Codex', () => {
  test('a run proposes through the gateway, records its usage and completes; nothing is applied', async () => {
    const s = await paperWithSelection();
    const r = await runCodexJob(s);
    expect(r.events.every((e) => validateProviderEvent(e).ok)).toBe(true);
    expect(r.events.at(-1)).toMatchObject({ kind: 'turn_completed' });
    expect(r.toolAnswers).toEqual([expect.objectContaining({ ok: true, result: expect.objectContaining({ status: 'PENDING' }) })]);
    const proposal = (await pool.query('SELECT id, origin, status FROM edit_proposals WHERE document_id = $1', [s.documentId])).rows;
    expect(proposal).toEqual([expect.objectContaining({ origin: 'worker:tool-gateway:codex', status: 'PENDING' })]);
    expect((await pool.query('SELECT head_revision_id FROM documents WHERE id = $1', [s.documentId])).rows[0].head_revision_id).toBe(s.head);
    // usage: the provider's cumulative counter, stored as a session report with its delta
    expect((await usageSummary(pool, s.paperId)).billed.input_tokens).toEqual({ value: 900, unknown: false });
    await completeJob(pool, { jobId: r.job.id, fencingToken: r.fencingToken, result: { kind: 'proposal', proposal_id: proposal[0].id } });
    expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [r.job.id])).rows[0].status).toBe('SUCCEEDED');
    // the run is over: its token creates nothing more
    expect((await callTool(pool, r.token.token, 'get_document_slice', { handle_id: s.handleId })).error?.code).toBe('invalid_token');
  });

  test('stopping in the middle of a turn: the cancel is stored, the turn is interrupted, the late tool call creates nothing', async () => {
    const s = await paperWithSelection();
    // slow: the turn stays open until interrupted. The stand-in makes its tool call at turn start (before
    // the stop); a late call after the stop is made directly with the run's token.
    const r = await runCodexJob(s, { flags: ['slow'], stopAfter: 1 });
    expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [r.job.id])).rows[0].status).toBe('CANCELLED');
    const before = (await pool.query('SELECT count(*)::int AS n FROM edit_proposals WHERE document_id = $1', [s.documentId])).rows[0].n;
    const late = await callTool(pool, r.token.token, 'propose_manuscript_edit', { handle_id: s.handleId, intent: 'concise', replacement: [{ type: 'text', text: 'late' }] });
    expect(late.error?.code).toBe('invalid_token');
    expect((await pool.query('SELECT count(*)::int AS n FROM edit_proposals WHERE document_id = $1', [s.documentId])).rows[0].n).toBe(before);
    await expect(completeJob(pool, { jobId: r.job.id, fencingToken: r.fencingToken, result: { kind: 'proposal' } })).rejects.toThrow(/lease lost/);
  });

  test('resume continues the stored thread id only; an unknown id is refused', async () => {
    const s = await paperWithSelection();
    const first = await runCodexJob(s);
    // a new server process: the stand-in knows the thread only through its profile marker (as the
    // real one knows it from CODEX_HOME), so the second run resumes exactly that id
    const p = profile({ tool: 'get_document_slice', arguments: { handle_id: s.handleId } }, [`thread-${first.thread}`]);
    const server = await startCodexServer({ decision: decision(), cmd: FAKE, run: runFolders(), profileDir: p, parentEnv: { PATH: process.env.PATH! }, homes: [os.homedir()] });
    expect(await server.resumeThread(first.thread)).toBe(first.thread);
    await expect(server.resumeThread('th-unknown')).rejects.toThrow(/not found/);
    await server.close();
  });
});
