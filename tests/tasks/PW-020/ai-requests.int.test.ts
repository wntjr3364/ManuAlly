// PW-020 — AI requests on a selection run as jobs with the deterministic mock provider and report
// progress as append-only events (REQ-020-A); a browser disconnect never cancels a job and mock output
// is always labelled as mock (REQ-020-B).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { parseDocument, snapshotSelection } from '../../../packages/editor-core/src/index.ts';
import { appendJobEvent, cancelJob, claimJob } from '../../../packages/domain/src/jobs/index.ts';
import { runOnce } from '../../../apps/worker/src/local/index.ts';
import { selectionHandlers } from '../../../apps/worker/src/selection/index.ts';
import { createMockProvider } from '../../../packages/providers/src/mock/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
const P = '00000000-0000-4000-8000-0000000000a1';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
let base: string;
let H: Record<string, string>;
let other: Record<string, string>;

async function login(username: string) {
  await createOwner(pool, { username, password: 'correct horse battery' });
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username, password: 'correct horse battery' } });
  return { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken, origin: ORIGIN };
}
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 10 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN], eventPollMs: 20 });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
  H = await login('alice');
  other = await login('mallory');
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});

const call = (method: 'GET' | 'POST', url: string, payload?: unknown, headers = H) => app.inject({ method, url, headers, payload: payload as object | undefined });
const TEXT = 'It was very very clear at 2.4-fold.';

async function setup(text = TEXT) {
  const doc = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P }, content: [{ type: 'text', text }] }] };
  const p = (await call('POST', '/api/papers', { working_title: 'p', article_type: 'research_article' })).json();
  const d = (await call('POST', `/api/papers/${p.id}/documents`, { kind: 'manuscript' })).json();
  const saved = (await call('POST', `/api/papers/${p.id}/documents/${d.document.id}/saves`, { expected_head_revision_id: d.head.id, content_json: doc, schema_version: 1, reason: 'manual' })).json();
  return { paperId: p.id as string, documentId: d.document.id as string, head: saved.id as string, doc };
}
type S = Awaited<ReturnType<typeof setup>>;
async function request(s: S, quote: string, intent: string, instruction = '', key = randomUUID(), headers = H) {
  const at = (s.doc.content[0]!.content[0]!.text).indexOf(quote);
  const selection = await snapshotSelection(parseDocument(s.doc, 1), { blockId: P, from: at, to: at + quote.length });
  return call('POST', `/api/papers/${s.paperId}/documents/${s.documentId}/ai-requests`, { base_revision_id: s.head, selection, intent, instruction, idempotency_key: key }, headers);
}
const handlers = (delay = 0) => selectionHandlers(pool, createMockProvider({ chunkDelayMs: delay }));
const events = async (jobId: string) => (await pool.query('SELECT seq, kind, data FROM job_events WHERE job_id = $1 ORDER BY seq', [jobId])).rows as { seq: number; kind: string; data: Record<string, unknown> }[];
const head = async (documentId: string) => (await pool.query('SELECT head_revision_id FROM documents WHERE id = $1', [documentId])).rows[0].head_revision_id as string;

describe('TST-020A: requests become jobs; answers stream; a proposal is ready but not applied', () => {
  test('an ask request is a job; the same key returns it, another body with that key is refused', async () => {
    const s = await setup();
    const key = randomUUID();
    const r = await request(s, 'very very clear', 'ask', 'Is this too strong?', key);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ job: { intent: 'ask_selection', status: 'QUEUED' }, created: true });
    expect(r.json().job.payload).toMatchObject({ intent: 'ask', instruction: 'Is this too strong?', document_id: s.documentId, handle_id: expect.any(String) });
    const again = await request(s, 'very very clear', 'ask', 'Is this too strong?', key);
    expect(again.statusCode).toBe(200);
    expect(again.json().job.id).toBe(r.json().job.id);
    expect((await pool.query('SELECT count(*)::int AS n FROM selection_handles WHERE paper_id = $1', [s.paperId])).rows[0].n).toBe(1);
    expect((await request(s, 'very very clear', 'ask', 'Something else?', key)).statusCode).toBe(409);
  });

  test('bad requests are refused without a job', async () => {
    const s = await setup();
    expect((await request(s, 'very very clear', 'ask', '')).statusCode).toBe(422); // a question needs text
    expect((await request(s, 'very very clear', 'summarize')).statusCode).toBe(422);
    const rw = await request(s, 'very very clear', 'rewrite');
    expect(rw.statusCode).toBe(403); // RFC-003: no rewrite before the outline is approved
    expect(rw.json().details?.reason ?? rw.json().reason).toBe('OUTLINE_NOT_APPROVED');
    expect((await request(s, 'very very clear', 'ask', 'q?', randomUUID(), other)).statusCode).toBe(404);
    expect((await pool.query('SELECT count(*)::int AS n FROM jobs WHERE paper_id = $1', [s.paperId])).rows[0].n).toBe(0);
  });

  test('an answer streams as deltas, ends with answer_done, and never changes the manuscript', async () => {
    const s = await setup();
    const job = (await request(s, 'very very clear', 'ask', 'Is this too strong?')).json().job;
    const out = await runOnce(pool, { handlers: handlers() });
    expect(out).toContainEqual({ job_id: job.id, outcome: 'completed' });
    const ev = await events(job.id);
    expect(ev[0]).toMatchObject({ seq: 1, kind: 'status', data: { state: 'running', provider: 'mock', label: 'MOCK' } });
    const deltas = ev.filter((e) => e.kind === 'delta');
    expect(deltas.length).toBeGreaterThan(1);
    const answer = deltas.map((e) => e.data.text).join('');
    expect(answer).toMatch(/^\[MOCK\]/);
    expect(answer).toContain('Is this too strong?');
    expect(ev.at(-1)).toMatchObject({ kind: 'answer_done', data: { provider: 'mock', label: 'MOCK' } });
    expect(ev.map((e) => e.seq)).toEqual(ev.map((_, i) => i + 1));
    expect(await head(s.documentId)).toBe(s.head);
    expect((await pool.query('SELECT count(*)::int AS n FROM edit_proposals WHERE paper_id = $1', [s.paperId])).rows[0].n).toBe(0);
    expect((await call('GET', `/api/papers/${s.paperId}/jobs/${job.id}`)).json()).toMatchObject({ status: 'SUCCEEDED', result: { kind: 'answer', label: 'MOCK' } });
  });

  test('a concise request yields a PENDING proposal marked as mock; the manuscript is unchanged until the owner applies it', async () => {
    const s = await setup();
    const job = (await request(s, 'very very clear', 'concise')).json().job;
    await runOnce(pool, { handlers: handlers() });
    const ev = await events(job.id);
    const prop = ev.find((e) => e.kind === 'proposal')!;
    expect(prop.data).toMatchObject({ status: 'PENDING', provider: 'mock', label: 'MOCK' });
    const p = (await call('GET', `/api/papers/${s.paperId}/proposals/${prop.data.proposal_id}`)).json();
    expect(p.proposal).toMatchObject({ status: 'PENDING', origin: 'worker:provider.mock', intent: 'concise' });
    expect(p.after_block.content[0].text).toBe('It was clear at 2.4-fold.');
    expect(await head(s.documentId)).toBe(s.head); // ready, not applied
  });

  test('nothing to correct is reported as no_change without a proposal', async () => {
    const s = await setup('Cells divided twice.');
    const job = (await request(s, 'Cells divided twice.', 'grammar')).json().job;
    await runOnce(pool, { handlers: handlers() });
    expect((await events(job.id)).map((e) => e.kind)).toEqual(['status', 'no_change']);
    expect((await pool.query('SELECT count(*)::int AS n FROM edit_proposals WHERE paper_id = $1', [s.paperId])).rows[0].n).toBe(0);
  });

  test('an answer that arrives after the manuscript changed becomes a STALE proposal', async () => {
    const s = await setup();
    const job = (await request(s, 'very very clear', 'concise')).json().job;
    const changed = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: P }, content: [{ type: 'text', text: `${TEXT} More.` }] }] };
    expect((await call('POST', `/api/papers/${s.paperId}/documents/${s.documentId}/saves`, { expected_head_revision_id: s.head, content_json: changed, schema_version: 1, reason: 'manual' })).statusCode).toBe(201);
    await runOnce(pool, { handlers: handlers() });
    expect((await events(job.id)).find((e) => e.kind === 'proposal')!.data.status).toBe('STALE');
  });

  test('events are immutable and only the current run may append them', async () => {
    const s = await setup();
    const job = (await request(s, 'very very clear', 'ask', 'q?')).json().job;
    const claim = (await claimJob(pool, { jobId: job.id, workerId: 'w1', leaseMs: 30_000 }))!;
    await appendJobEvent(pool, { jobId: job.id, fencingToken: claim.fencingToken, kind: 'delta', data: { text: 'a' } });
    await expect(appendJobEvent(pool, { jobId: job.id, fencingToken: claim.fencingToken + 1, kind: 'delta', data: { text: 'b' } })).rejects.toThrow(/lease lost/);
    await expect(appendJobEvent(pool, { jobId: job.id, fencingToken: claim.fencingToken, kind: 'proposal_applied' as never, data: {} })).rejects.toThrow(/kind/);
    await expect(pool.query("UPDATE job_events SET data = '{\"text\":\"x\"}' WHERE job_id = $1", [job.id])).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM job_events WHERE job_id = $1', [job.id])).rejects.toThrow(/immutable/);
  });
});

// reads an SSE response until `end` (or until stop() returns true), returning the parsed events
async function readSse(url: string, init: RequestInit & { stop?: (evs: Sse[]) => boolean } = {}) {
  const ctl = new AbortController();
  const res = await fetch(url, { ...init, signal: ctl.signal });
  const out: Sse[] = [];
  if (res.status !== 200) return { status: res.status, events: out, headers: res.headers };
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const e: Sse = { event: 'message', data: '' };
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) e.id = line.slice(4);
        else if (line.startsWith('event: ')) e.event = line.slice(7);
        else if (line.startsWith('data: ')) e.data = line.slice(6);
      }
      if (block.split('\n').every((l) => l.startsWith(':') || l.startsWith('retry:'))) continue;
      out.push(e);
    }
    if (out.at(-1)?.event === 'end' || init.stop?.(out)) break;
  }
  ctl.abort();
  return { status: res.status, events: out, headers: res.headers };
}
interface Sse { id?: string; event: string; data: string }
const sseHeaders = (h = H) => ({ cookie: h.cookie! });

describe('SSE: progress is streamed in order and resumes from Last-Event-ID', () => {
  test('a finished job streams all events, then end with the job status', async () => {
    const s = await setup();
    const job = (await request(s, 'very very clear', 'ask', 'q?')).json().job;
    await runOnce(pool, { handlers: handlers() });
    const r = await readSse(`${base}/api/papers/${s.paperId}/jobs/${job.id}/events`, { headers: sseHeaders() });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const stored = await events(job.id);
    expect(r.events.filter((e) => e.id).map((e) => [e.id, e.event])).toEqual(stored.map((e) => [String(e.seq), e.kind]));
    expect(r.events.filter((e) => e.event === 'job').map((e) => JSON.parse(e.data).status)).toEqual(['SUCCEEDED']);
    expect(JSON.parse(r.events.at(-1)!.data)).toMatchObject({ status: 'SUCCEEDED' });
    const resumed = await readSse(`${base}/api/papers/${s.paperId}/jobs/${job.id}/events`, { headers: { ...sseHeaders(), 'last-event-id': '2' } });
    expect(resumed.events.filter((e) => e.id).map((e) => Number(e.id))).toEqual(stored.filter((e) => e.seq > 2).map((e) => e.seq));
  });

  test('another owner cannot read a job stream', async () => {
    const s = await setup();
    const job = (await request(s, 'very very clear', 'ask', 'q?')).json().job;
    expect((await readSse(`${base}/api/papers/${s.paperId}/jobs/${job.id}/events`, { headers: sseHeaders(other) })).status).toBe(404);
    expect((await readSse(`${base}/api/papers/${s.paperId}/jobs/${job.id}/events`)).status).toBe(401);
  });
});

describe('TST-020B: a disconnect is not a cancel; a cancel stops the run without a result', () => {
  test('closing the stream mid-answer does not cancel: the job finishes and a new stream reads it all', async () => {
    const s = await setup();
    const job = (await request(s, 'very very clear', 'ask', 'Is this too strong?')).json().job;
    const run = runOnce(pool, { handlers: handlers(40) });
    const first = await readSse(`${base}/api/papers/${s.paperId}/jobs/${job.id}/events`, { headers: sseHeaders(), stop: (evs) => evs.some((e) => e.event === 'delta') });
    expect(first.events.some((e) => e.event === 'end')).toBe(false); // left mid-answer
    expect(await run).toContainEqual({ job_id: job.id, outcome: 'completed' });
    expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [job.id])).rows[0].status).toBe('SUCCEEDED');
    const again = await readSse(`${base}/api/papers/${s.paperId}/jobs/${job.id}/events`, { headers: sseHeaders() });
    expect(again.events.map((e) => e.event)).toContain('answer_done');
  });

  test('cancelling mid-answer stops the run: no answer_done, no proposal, the stream ends CANCELLED', async () => {
    const s = await setup();
    const job = (await request(s, 'very very clear', 'concise')).json().job;
    const ask = (await request(s, 'very very clear', 'ask', 'q?')).json().job;
    // cancel the ask as soon as its first piece is stored
    const run = runOnce(pool, { handlers: handlers(40) });
    const r = await readSse(`${base}/api/papers/${s.paperId}/jobs/${ask.id}/events`, {
      headers: sseHeaders(),
      stop: (evs) => {
        if (evs.some((e) => e.event === 'delta') && !evs.some((e) => e.event === 'cancel-sent')) {
          evs.push({ event: 'cancel-sent', data: '' });
          void cancelJob(pool, { paperId: s.paperId, jobId: ask.id, ownerId: 'x' });
        }
        return false;
      },
    });
    const outcomes = await run;
    expect(outcomes.find((o) => o.job_id === ask.id)!.outcome).toBe('lost_lease');
    expect(JSON.parse(r.events.at(-1)!.data)).toMatchObject({ status: 'CANCELLED' });
    const kinds = (await events(ask.id)).map((e) => e.kind);
    expect(kinds).not.toContain('answer_done');
    // the other job is unaffected
    expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [job.id])).rows[0].status).toBe('SUCCEEDED');
  });

  test('a cancelled revise run leaves no proposal', async () => {
    const s = await setup();
    const job = (await request(s, 'very very clear', 'concise')).json().job;
    const owner = (await pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [s.paperId])).rows[0].owner_id;
    const run = runOnce(pool, { handlers: selectionHandlers(pool, createMockProvider({ chunkDelayMs: 0, beforeRevise: () => cancelJob(pool, { paperId: s.paperId, jobId: job.id, ownerId: owner }).then(() => {}) })) });
    expect((await run).find((o) => o.job_id === job.id)!.outcome).toBe('lost_lease');
    expect((await pool.query('SELECT count(*)::int AS n FROM edit_proposals WHERE paper_id = $1', [s.paperId])).rows[0].n).toBe(0);
    expect((await events(job.id)).map((e) => e.kind)).toEqual(['status']);
  });
});
