// PW-028 — stop, interrupt, narrow termination, late answers and reconciliation (spec 07 "취소·소유권").
// TST-028A: a cancel is stored first; the run is interrupted, then only its own process group is
//   ended; what the server reports afterwards (job, events) is the stored final state.
// TST-028B: a late answer after the cancel changes nothing; no other session's process is touched
//   (no broad pkill, no pid reuse mistakes).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { appendJobEvent, claimJob, completeJob, enqueueJob } from '../../../packages/domain/src/jobs/index.ts';
import { callTool, issueRunToken } from '../../../packages/domain/src/tool-policy/index.ts';
import { parseDocument, snapshotSelection } from '../../../packages/editor-core/src/index.ts';
import { procStartTicks, processMatches, reconcileRunProcesses, startRunProcess, superviseRun, terminateRunGroup, watchJob, type RunProcessRecord } from '../../../apps/worker/src/lifecycle/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
const FAKE = path.resolve('tests/tasks/PW-028/fake-run.mjs');
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
let H: Record<string, string>;
let ownerId: string;
let paperId: string;
let documentId: string;
let tmp: string;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 5000) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 20)); } return true; };

beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN], eventPollMs: 20, eventStreamMaxMs: 2000 });
  await app.ready();
  ownerId = (await createOwner(pool, { username: 'alice', password: 'correct horse battery' })).id;
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: 'alice', password: 'correct horse battery' } });
  H = { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken, origin: ORIGIN };
  paperId = (await app.inject({ method: 'POST', url: '/api/papers', headers: H, payload: { working_title: 'p', article_type: 'research_article' } })).json().id;
  documentId = (await app.inject({ method: 'POST', url: `/api/papers/${paperId}/documents`, headers: H, payload: { kind: 'manuscript' } })).json().document.id;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw028-'));
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function runningJob() {
  const { job } = await enqueueJob(pool, { paperId, ownerId, intent: 'ask_selection', idempotencyKey: randomUUID(), payload: { test: true } });
  const claim = (await claimJob(pool, { jobId: job.id, workerId: 'w1', leaseMs: 60_000 }))!;
  return { jobId: job.id, fencingToken: claim.fencingToken };
}
async function start(flags: string[] = []) {
  const j = await runningJob();
  const pidfile = path.join(tmp, `${randomUUID()}.pid`);
  const run = await startRunProcess(pool, { jobId: j.jobId, fencingToken: j.fencingToken, workerId: 'w1', cmd: process.execPath, args: [FAKE, ...flags, `pidfile=${pidfile}`], env: { PATH: process.env.PATH! } });
  await waitFor(() => fs.existsSync(pidfile) && fs.readFileSync(pidfile, 'utf8').includes(' '));
  const [, grand] = fs.readFileSync(pidfile, 'utf8').split(' ').map(Number);
  return { ...j, ...run, grandchild: grand! };
}
const cancel = (jobId: string) => app.inject({ method: 'POST', url: `/api/papers/${paperId}/jobs/${jobId}/cancel`, headers: H, payload: {} });
const ended = async (id: string) => (await pool.query('SELECT end_reason FROM run_processes WHERE id = $1', [id])).rows[0].end_reason as string | null;
const interruptVia = (child: { stdin: NodeJS.WritableStream | null }) => async () => { child.stdin?.write('interrupt\n'); };

describe('TST-028A: the stored cancel drives the stop; the server reports the stored final state', () => {
  test('cancel → provider interrupt → the run ends; the job, its events and the process record agree', async () => {
    const r = await start();
    const sup = superviseRun(pool, { jobId: r.jobId, fencingToken: r.fencingToken, record: r.record, child: r.child, interrupt: interruptVia(r.child), pollMs: 30, interruptGraceMs: 2000, killGraceMs: 1000 });
    await new Promise((res) => setTimeout(res, 150));
    expect((await cancel(r.jobId)).statusCode).toBe(200);
    const out = await sup;
    expect(out).toMatchObject({ reason: 'cancelled', end: 'interrupted' });
    expect(alive(r.record.pid)).toBe(false);
    expect(await waitFor(() => !alive(r.grandchild))).toBe(true);
    expect(await ended(r.record.id)).toBe('interrupted');
    const job = (await app.inject({ method: 'GET', url: `/api/papers/${paperId}/jobs/${r.jobId}`, headers: H })).json();
    expect(job.status ?? job.job?.status).toBe('CANCELLED');
    // a reconnecting browser replays the stored events and ends on the stored status
    const sse = await app.inject({ method: 'GET', url: `/api/papers/${paperId}/jobs/${r.jobId}/events`, headers: H });
    expect(sse.body).toMatch(/event: job\ndata: .*"status":"CANCELLED"/);
    expect(sse.body).toMatch(/event: end/);
  });

  test('an interrupt that is ignored ends with SIGTERM to the run\'s group; SIGTERM ignored ends with SIGKILL', async () => {
    for (const [flags, end] of [[['ignore-interrupt'], 'terminated'], [['ignore-interrupt', 'ignore-term'], 'killed']] as const) {
      const r = await start([...flags]);
      const sup = superviseRun(pool, { jobId: r.jobId, fencingToken: r.fencingToken, record: r.record, child: r.child, interrupt: interruptVia(r.child), pollMs: 30, interruptGraceMs: 200, killGraceMs: 300 });
      await cancel(r.jobId);
      expect(await sup).toMatchObject({ reason: 'cancelled', end });
      expect(await waitFor(() => !alive(r.record.pid) && !alive(r.grandchild))).toBe(true);
      expect(await ended(r.record.id)).toBe(end);
    }
  });

  test('a run that loses its lease to another worker is stopped the same way', async () => {
    const r = await start();
    const sup = superviseRun(pool, { jobId: r.jobId, fencingToken: r.fencingToken, record: r.record, child: r.child, interrupt: interruptVia(r.child), pollMs: 30, interruptGraceMs: 2000, killGraceMs: 500 });
    await pool.query("UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [r.jobId]);
    expect(await claimJob(pool, { jobId: r.jobId, workerId: 'w2', leaseMs: 60_000 })).not.toBeNull();
    expect(await sup).toMatchObject({ reason: 'lease_lost', end: 'interrupted' });
  });
});

describe('TST-028B: late answers change nothing; only the run\'s own processes are ended', () => {
  test('after a cancel, the run\'s completion and events are refused and nothing canonical changes', async () => {
    const r = await start();
    const sup = superviseRun(pool, { jobId: r.jobId, fencingToken: r.fencingToken, record: r.record, child: r.child, interrupt: interruptVia(r.child), pollMs: 30, interruptGraceMs: 2000, killGraceMs: 500 });
    await cancel(r.jobId);
    await sup;
    const before = (await pool.query('SELECT head_revision_id FROM documents WHERE id = $1', [documentId])).rows[0].head_revision_id;
    let applied = false;
    await expect(completeJob(pool, { jobId: r.jobId, fencingToken: r.fencingToken, apply: async () => { applied = true; }, result: { kind: 'answer' } })).rejects.toThrow(/lease lost/);
    await expect(appendJobEvent(pool, { jobId: r.jobId, fencingToken: r.fencingToken, kind: 'delta', data: { text: 'late' } })).rejects.toThrow(/lease lost/);
    expect(applied).toBe(false);
    expect((await pool.query('SELECT head_revision_id FROM documents WHERE id = $1', [documentId])).rows[0].head_revision_id).toBe(before);
    expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [r.jobId])).rows[0].status).toBe('CANCELLED');
  });

  test('cancelling one run leaves another session running the same command untouched', async () => {
    const a = await start();
    const b = await start();
    const supA = superviseRun(pool, { jobId: a.jobId, fencingToken: a.fencingToken, record: a.record, child: a.child, interrupt: interruptVia(a.child), pollMs: 30, interruptGraceMs: 2000, killGraceMs: 500 });
    await cancel(a.jobId);
    await supA;
    expect(alive(b.record.pid)).toBe(true);
    expect(alive(b.grandchild)).toBe(true);
    // a developer's own process with the same command line, outside any run, is untouched as well
    const own = spawn(process.execPath, [FAKE], { stdio: 'ignore', detached: true });
    await new Promise((res) => setTimeout(res, 100));
    const supB = superviseRun(pool, { jobId: b.jobId, fencingToken: b.fencingToken, record: b.record, child: b.child, interrupt: interruptVia(b.child), pollMs: 30, interruptGraceMs: 200, killGraceMs: 300 });
    await cancel(b.jobId);
    await supB;
    expect(alive(own.pid!)).toBe(true);
    own.kill('SIGKILL');
  });

  test('a record that does not match the live process (pid reused, other marker) ends nothing', async () => {
    const victim = spawn(process.execPath, [FAKE], { stdio: 'ignore', detached: true });
    await new Promise((res) => setTimeout(res, 100));
    const forged: RunProcessRecord[] = [];
    const r = await start();
    // same pid and group, but the start time is not the recorded one (the pid was reused)
    forged.push({ ...r.record, pid: victim.pid!, pgid: victim.pid! });
    // right start time, but the process does not carry this run's marker
    forged.push({ ...r.record, pid: victim.pid!, pgid: victim.pid!, proc_start_ticks: procStartTicks(victim.pid!)! });
    // the real record matches; the same record with another start time (a reused pid) does not
    expect(processMatches(r.record)).toBe(true);
    expect(processMatches({ ...r.record, proc_start_ticks: r.record.proc_start_ticks + 1 })).toBe(false);
    for (const f of forged) {
      expect(processMatches(f)).toBe(false);
      expect(await terminateRunGroup(pool, f, { graceMs: 100 })).toBe('gone');
    }
    expect(alive(victim.pid!)).toBe(true);
    victim.kill('SIGKILL');
    r.child.kill('SIGKILL');
  });

  // review MAJOR: the tool gateway is part of the run: a cancelled or taken-over run's token is dead
  test('after a cancel (or a takeover) the run\'s tool token creates nothing', async () => {
    const P1 = '00000000-0000-4000-8000-0000000000a1';
    const content = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P1 }, content: [{ type: 'text', text: 'It was very very clear.' }] }] };
    const d = (await app.inject({ method: 'POST', url: `/api/papers/${paperId}/documents`, headers: H, payload: { kind: 'manuscript' } })).json();
    const head = (await app.inject({ method: 'POST', url: `/api/papers/${paperId}/documents/${d.document.id}/saves`, headers: H, payload: { expected_head_revision_id: d.head.id, content_json: content, schema_version: 1, reason: 'manual' } })).json().id;
    const sel = await snapshotSelection(parseDocument(content, 1), { blockId: P1, from: 7, to: 22 });
    const handle = (await app.inject({ method: 'POST', url: `/api/papers/${paperId}/documents/${d.document.id}/selection-handles`, headers: H, payload: { base_revision_id: head, selection: sel } })).json();
    const propose = (t: string) => callTool(pool, t, 'propose_manuscript_edit', { handle_id: handle.id, intent: 'concise', replacement: [{ type: 'text', text: 'clear' }] });
    const tokenFor = (j: { jobId: string; fencingToken: number }) => issueRunToken(pool, { ownerId, paperId, documentId: d.document.id, handleIds: [handle.id], provider: 'codex', tools: ['propose_manuscript_edit'], ttlMs: 60_000, jobId: j.jobId, fencingToken: j.fencingToken });
    const count = async () => (await pool.query('SELECT count(*)::int AS n FROM edit_proposals WHERE document_id = $1', [d.document.id])).rows[0].n as number;
    const a = await runningJob();
    const ta = await tokenFor(a);
    expect((await propose(ta.token)).ok).toBe(true); // while the run is current
    await cancel(a.jobId);
    expect((await propose(ta.token)).error?.code).toBe('invalid_token');
    // taken over after its lease expired: the old run's token is dead, the new run gets its own
    const b = await runningJob();
    const tb = await tokenFor(b);
    await pool.query("UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [b.jobId]);
    await claimJob(pool, { jobId: b.jobId, workerId: 'w2', leaseMs: 60_000 });
    expect((await propose(tb.token)).error?.code).toBe('invalid_token');
    expect(await count()).toBe(1);
    await expect(issueRunToken(pool, { ownerId, paperId, documentId: d.document.id, handleIds: [], provider: 'codex', tools: ['get_approved_outline'], ttlMs: 60_000, jobId: a.jobId, fencingToken: a.fencingToken })).rejects.toThrow(/not running/);
  });

  // review MINOR-2: a child that dropped the marker but stayed in the run's group is ended too
  test('a child without the run marker left in the run\'s group is ended when the run exits or is stopped', async () => {
    for (const flags of [['unmarked-child', 'exit-soon'], ['unmarked-child']]) {
      const r = await start(flags);
      const unmarked = Number(fs.readFileSync(fs.readdirSync(tmp).map((f) => path.join(tmp, f)).filter((f) => f.endsWith('.unmarked')).sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs)[0]!, 'utf8'));
      expect(alive(unmarked)).toBe(true);
      const sup = superviseRun(pool, { jobId: r.jobId, fencingToken: r.fencingToken, record: r.record, child: r.child, interrupt: interruptVia(r.child), pollMs: 30, interruptGraceMs: 2000, killGraceMs: 500 });
      if (!flags.includes('exit-soon')) await cancel(r.jobId);
      await sup;
      expect(await waitFor(() => !alive(unmarked)), flags.join(',')).toBe(true);
    }
  });

  test('a watcher that cannot read the database stops the run after repeated failures (not forever)', async () => {
    const broken = { query: async () => { throw new Error('db down'); } } as unknown as pg.Pool;
    const w = watchJob(broken, { jobId: randomUUID(), fencingToken: 1, pollMs: 10, maxFailures: 5 });
    expect(await waitFor(() => w.signal.aborted, 2000)).toBe(true);
    expect(w.signal.reason).toBe('db_unreachable');
  });

  test('the worker never uses broad process termination', () => {
    const dir = path.resolve('apps/worker/src');
    const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.(ts|mjs|js)$/.test(f));
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/\bpkill\b|\bkillall\b|process\.kill\(\s*-1\b|kill\s+-9\s+-1|process\.kill\(\s*0\b/);
    }
  });
});

describe('reconciliation after a worker restart', () => {
  test('a run left behind by a crashed worker is ended if (and only if) it is still that run', async () => {
    const left = await start();
    const done = await start();
    const live = await start();
    // the worker "crashed": nobody supervises these. The user cancels one; one has already exited.
    await cancel(left.jobId);
    process.kill(-done.record.pgid, 'SIGKILL'); // the whole run is already gone
    await waitFor(() => !alive(done.record.pid) && !alive(done.grandchild));
    const out = await reconcileRunProcesses(pool, { host: os.hostname(), graceMs: 300 });
    expect(out).toMatchObject({ ended: 1, gone: 1 });
    expect(await waitFor(() => !alive(left.record.pid) && !alive(left.grandchild))).toBe(true);
    expect(await ended(left.record.id)).toBe('reconciled');
    expect(await ended(done.record.id)).toBe('gone');
    // a run whose job is still running under a valid lease is not touched
    expect(alive(live.record.pid)).toBe(true);
    expect(await ended(live.record.id)).toBeNull();
    // review MINOR-3: nor is another worker's run whose lease merely expired (a late heartbeat): its
    // job is still RUNNING under the same token, and it is not this worker's run
    await pool.query("UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [live.jobId]);
    expect(await reconcileRunProcesses(pool, { host: os.hostname(), workerId: 'w-restarted', graceMs: 300 })).toMatchObject({ ended: 0, kept: 1 });
    expect(alive(live.record.pid)).toBe(true);
    // the same worker restarting does end its own run with an expired lease
    expect(await reconcileRunProcesses(pool, { host: os.hostname(), workerId: 'w1', graceMs: 300 })).toMatchObject({ ended: 1 });
    expect(await waitFor(() => !alive(live.record.pid))).toBe(true);
  });

  test('process records can only be ended once; nothing else about them changes', async () => {
    const r = await start();
    await terminateRunGroup(pool, r.record, { graceMs: 100 });
    await expect(pool.query("UPDATE run_processes SET end_reason = 'exited' WHERE id = $1", [r.record.id])).rejects.toThrow(/immutable/);
    await expect(pool.query('UPDATE run_processes SET pid = 2 WHERE id = $1', [r.record.id])).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM run_processes WHERE id = $1', [r.record.id])).rejects.toThrow(/immutable/);
  });
});
