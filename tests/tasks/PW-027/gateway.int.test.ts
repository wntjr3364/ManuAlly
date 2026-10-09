// PW-027 — typed tool gateway and run-token scope (spec 07 "Tool gateway", 09 비신뢰 데이터).
// TST-027A: a run reads only the allowed outline, paragraph and evidence data and can only create
//   proposals (nothing is applied, approved or verified).
// TST-027B: a model that changes paper_id / approved_by / the tool name cannot reach another paper,
//   apply to the canonical text or obtain an approval. The scope comes from the run token alone.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { parseDocument, snapshotSelection } from '../../../packages/editor-core/src/index.ts';
import { FORBIDDEN_TOOLS, MAX_CALLS_PER_TOKEN, TOOL_NAMES, callTool, issueRunToken, revokeRunToken, toolDefinitions } from '../../../packages/domain/src/tool-policy/index.ts';
import { serveToolSocket } from '../../../apps/worker/src/provider-runs/tool-socket.ts';

const ORIGIN = 'http://127.0.0.1:5173';
const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const BRIDGE = path.resolve('apps/worker/src/provider-runs/mcp-bridge.mjs');
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
const H: Record<string, Record<string, string>> = {};
const ids: Record<string, string> = {};
let tmp: string;

beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  for (const u of ['alice', 'bob']) {
    ids[u] = (await createOwner(pool, { username: u, password: 'correct horse battery' })).id;
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: u, password: 'correct horse battery' } });
    H[u] = { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken, origin: ORIGIN };
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw027-'));
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, headers: H[who], payload: payload as object | undefined });
const content = (secret: string) => ({
  type: 'doc',
  content: [
    { type: 'paragraph', attrs: { id: P1 }, content: [{ type: 'text', text: `Expression rose 2.4-fold in roots. ${secret} It was very very clear.` }] },
    { type: 'paragraph', attrs: { id: P2 }, content: [{ type: 'text', text: 'Second paragraph stays.' }] },
  ],
});
const brief = { purpose: 'Test whether ABC1 responds to drought', audience: 'plant stress biologists', known_facts: ['ABC1 induced 2.4-fold'], missing_material: [], avoid_claims: [] };
const story = { question: 'Does ABC1 respond to drought?', main_message: 'ABC1 is drought-induced', novelty: 'none yet', evidence_links: [], competing_explanations: [], presentation_order: ['induction'], limitations: ['single genotype'] };
const node = () => ({ node_id: randomUUID(), parent_node_id: null, section: 'Results', role: 'result', paragraph_goal: 'Report the induction', claim_ids: [], evidence_ids: [], requires_evidence: false, allowed_interpretation: 'observation only', exclusions: [], transition: '', word_budget_min: 40, word_budget_max: 80 });

interface Paper { paperId: string; documentId: string; head: string; handleId: string; factId: string; candidateFactId: string; refId: string; figureId: string; outlineId: string }
async function paper(who: string, secret: string): Promise<Paper> {
  const p = (await call(who, 'POST', '/api/papers', { working_title: `paper of ${who}`, article_type: 'research_article' })).json();
  const d = (await call(who, 'POST', `/api/papers/${p.id}/documents`, { kind: 'manuscript' })).json();
  const head = (await call(who, 'POST', `/api/papers/${p.id}/documents/${d.document.id}/saves`, { expected_head_revision_id: d.head.id, content_json: content(secret), schema_version: 1, reason: 'manual' })).json().id;
  const doc = parseDocument(content(secret), 1);
  let from = -1;
  doc.forEach((n) => { if (n.attrs.id === P1) from = n.textBetween(0, n.content.size).indexOf('very very clear'); });
  const selection = await snapshotSelection(doc, { blockId: P1, from, to: from + 'very very clear'.length });
  const handle = (await call(who, 'POST', `/api/papers/${p.id}/documents/${d.document.id}/selection-handles`, { base_revision_id: head, selection })).json();
  const s1 = (await call(who, 'POST', `/api/papers/${p.id}/story/revisions`, { parent_revision_id: null, brief, story })).json();
  await call(who, 'POST', `/api/papers/${p.id}/story/revisions/${s1.id}/approve`, { intent: 'approve_story', content_hash: s1.content_hash });
  const o1 = (await call(who, 'POST', `/api/papers/${p.id}/outline/revisions`, { parent_revision_id: null, story_revision_id: s1.id, nodes: [node()] })).json();
  await call(who, 'POST', `/api/papers/${p.id}/outline/revisions/${o1.id}/approve`, { intent: 'approve_outline', content_hash: o1.content_hash });
  const asset = (await pool.query("INSERT INTO asset_revisions (paper_id, asset_key, sha256, byte_size, media_type, original_name, created_by) VALUES ($1, 'table-2', repeat('d', 64), 120, 'text/csv', 'qpcr.csv', $2) RETURNING id", [p.id, ids[who]])).rows[0].id;
  const ev = (await call(who, 'POST', `/api/papers/${p.id}/evidence`, { kind: 'table_cell', source_asset_revision_id: asset, locator: { table: 'Table 2', row: 'ABC1', column: 'fold change' }, label: 'ABC1 qPCR' })).json();
  await call(who, 'POST', `/api/papers/${p.id}/evidence/${ev.id}/verify`, { intent: 'verify_evidence', content_hash: ev.content_hash });
  const factBody = (v: string) => ({ evidence_id: ev.id, entity: 'ABC1 transcript', metric: 'fold_change', value_text: v, unit: 'fold', group: 'drought, 7 d', comparison: 'well-watered control', n: 3, extraction_method: 'manual_entry', statistics: [{ kind: 'p_value', value_text: '0.003', test: 'Welch t-test' }] });
  const f = (await call(who, 'POST', `/api/papers/${p.id}/facts`, factBody('2.4'))).json();
  await call(who, 'POST', `/api/papers/${p.id}/facts/${f.id}/verify`, { intent: 'verify_fact', content_hash: f.content_hash });
  const candidate = (await call(who, 'POST', `/api/papers/${p.id}/facts`, factBody('9.9'))).json();
  const ref = (await call(who, 'POST', `/api/papers/${p.id}/references`, { authors: [{ family: 'Kim', given: 'J' }], year: 2021, title: `Drought ${secret}`, container: 'Plant J', doi: null })).json();
  const fig = (await call(who, 'POST', `/api/papers/${p.id}/figures`, { kind: 'figure', title: `qPCR ${secret}` })).json();
  return { paperId: p.id, documentId: d.document.id, head, handleId: handle.id, factId: f.id, candidateFactId: candidate.id, refId: ref.id, figureId: fig.id, outlineId: o1.id };
}

let A: Paper;
let B: Paper;
const ALL = [...TOOL_NAMES];
const token = (p: Paper, over: Record<string, unknown> = {}) => issueRunToken(pool, { ownerId: ids.alice!, paperId: p.paperId, documentId: p.documentId, handleIds: [p.handleId], provider: 'codex', tools: ALL, ttlMs: 60_000, ...over });
beforeAll(async () => {
  A = await paper('alice', 'ALICE-SECRET');
  B = await paper('bob', 'BOB-SECRET');
});

describe('TST-027A: allowed outline, paragraph and evidence reads; proposals only', () => {
  test('read tools return this paper\'s approved outline, scoped paragraphs, verified facts, references and figures', async () => {
    const t = await token(A);
    const outline = await callTool(pool, t.token, 'get_approved_outline', {});
    expect(outline).toMatchObject({ ok: true, result: { approved: true, outline_revision_id: A.outlineId } });
    expect((outline.result as { nodes: unknown[] }).nodes).toHaveLength(1);
    const slice = await callTool(pool, t.token, 'get_document_slice', { handle_id: A.handleId });
    expect(slice).toMatchObject({ ok: true, result: { handle_id: A.handleId, block_id: P1, text: 'very very clear' } });
    const block = await callTool(pool, t.token, 'get_document_slice', { block_id: P2 });
    expect(block).toMatchObject({ ok: true, result: { block_id: P2, text: 'Second paragraph stays.' } });
    const facts = await callTool(pool, t.token, 'get_fact_records', {});
    // only facts the user verified: a candidate value is never offered to the model as a fact
    expect((facts.result as { facts: { id: string; value_text: string }[] }).facts.map((f) => [f.id, f.value_text])).toEqual([[A.factId, '2.4']]);
    const refs = await callTool(pool, t.token, 'get_reference_excerpt', { reference_ids: [A.refId] });
    expect(refs).toMatchObject({ ok: true, result: { references: [{ id: A.refId, title: 'Drought ALICE-SECRET', excerpt: null }] } });
    const figs = await callTool(pool, t.token, 'get_figure_metadata', {});
    expect(figs).toMatchObject({ ok: true, result: { figures: [{ id: A.figureId, kind: 'figure', number: 1 }] } });
  });

  test('propose_manuscript_edit creates a pending proposal and changes nothing canonical', async () => {
    const t = await token(A);
    const r = await callTool(pool, t.token, 'propose_manuscript_edit', { handle_id: A.handleId, intent: 'concise', replacement: [{ type: 'text', text: 'clear' }], explanation: 'shorter' });
    expect(r).toMatchObject({ ok: true, result: { status: 'PENDING' } });
    const row = (await pool.query('SELECT origin, status, applied_revision_id FROM edit_proposals WHERE id = $1', [(r.result as { proposal_id: string }).proposal_id])).rows[0];
    expect(row).toMatchObject({ origin: 'worker:tool-gateway:codex', status: 'PENDING', applied_revision_id: null });
    const head = (await pool.query('SELECT head_revision_id FROM documents WHERE id = $1', [A.documentId])).rows[0].head_revision_id;
    expect(head).toBe(A.head);
  });

  test('the tool list a run sees holds only its allowed tools, each with a closed schema; no forbidden tool exists', async () => {
    const reads = await token(A, { tools: ['get_approved_outline', 'get_document_slice'] });
    const defs = await toolDefinitions(pool, reads.token);
    expect(defs.map((d) => d.name)).toEqual(['get_approved_outline', 'get_document_slice']);
    for (const d of await toolDefinitions(pool, (await token(A)).token)) {
      expect(d.input_schema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(FORBIDDEN_TOOLS).not.toContain(d.name);
    }
  });
});

describe('TST-027B: the model cannot widen its scope, apply or approve', () => {
  test('paper_id, approved_by, owner or document fields in the arguments are refused, not used', async () => {
    const t = await token(A);
    const before = (await pool.query('SELECT count(*)::int AS n FROM edit_proposals')).rows[0].n;
    for (const extra of [{ paper_id: B.paperId }, { approved_by: ids.alice }, { owner_id: ids.bob }, { document_id: B.documentId }, { status: 'APPLIED' }, { apply: true }]) {
      const r = await callTool(pool, t.token, 'propose_manuscript_edit', { handle_id: A.handleId, intent: 'concise', replacement: [{ type: 'text', text: 'x' }], ...extra });
      expect(r, JSON.stringify(extra)).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
      expect((await callTool(pool, t.token, 'get_approved_outline', extra)).error?.code).toBe('invalid_arguments');
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM edit_proposals')).rows[0].n).toBe(before);
  });

  test('ids from another paper find nothing (scope is the token\'s paper, document and selection)', async () => {
    const t = await token(A);
    const out = JSON.stringify([
      await callTool(pool, t.token, 'get_document_slice', { handle_id: B.handleId }),
      await callTool(pool, t.token, 'get_document_slice', { block_id: randomUUID() }),
      await callTool(pool, t.token, 'get_reference_excerpt', { reference_ids: [B.refId] }),
      await callTool(pool, t.token, 'get_fact_records', { fact_ids: [B.factId] }),
      await callTool(pool, t.token, 'propose_manuscript_edit', { handle_id: B.handleId, intent: 'concise', replacement: [{ type: 'text', text: 'x' }] }),
    ]);
    expect(out).not.toMatch(/BOB-SECRET/);
    expect((await callTool(pool, t.token, 'get_document_slice', { handle_id: B.handleId })).error?.code).toBe('not_in_scope');
    expect((await callTool(pool, t.token, 'propose_manuscript_edit', { handle_id: B.handleId, intent: 'concise', replacement: [{ type: 'text', text: 'x' }] })).error?.code).toBe('not_in_scope');
    expect((await callTool(pool, t.token, 'get_reference_excerpt', { reference_ids: [B.refId] })).result).toEqual({ references: [] });
    // a selection handle of this paper but not given to this run is out of scope too
    const narrow = await token(A, { handleIds: [] });
    expect((await callTool(pool, narrow.token, 'get_document_slice', { handle_id: A.handleId })).error?.code).toBe('not_in_scope');
    expect((await callTool(pool, narrow.token, 'propose_manuscript_edit', { handle_id: A.handleId, intent: 'concise', replacement: [{ type: 'text', text: 'x' }] })).error?.code).toBe('not_in_scope');
  });

  test('forbidden, unknown and look-alike tool names are refused; a tool outside the token\'s list is refused', async () => {
    const t = await token(A);
    for (const name of [...FORBIDDEN_TOOLS, 'Approve_Outline', ' get_approved_outline', 'get_approved_outline ', 'get_approved_outline​', 'shell', 'made_up', '__proto__', 'constructor']) {
      const r = await callTool(pool, t.token, name, {});
      expect(r.ok, name).toBe(false);
      expect(['forbidden_tool', 'unknown_tool'], name).toContain(r.error!.code);
    }
    for (const name of ['approve_outline', 'set_verified_fact', 'apply_approved_patch', 'change_owner', 'delete_snapshot', 'change_budget', 'submit_paper', 'arbitrary_http', 'shell', 'write_file']) {
      expect(FORBIDDEN_TOOLS).toContain(name);
    }
    const audited = (await pool.query("SELECT tool FROM agent_tool_calls WHERE token_id = $1 AND tool LIKE 'get_approved_outline%'", [t.id])).rows.map((r) => r.tool);
    expect(audited).toContain('get_approved_outline?'); // the zero-width character is shown, not hidden
    const reads = await token(A, { tools: ['get_approved_outline'] });
    expect((await callTool(pool, reads.token, 'propose_manuscript_edit', { handle_id: A.handleId, intent: 'concise', replacement: [{ type: 'text', text: 'x' }] })).error?.code).toBe('tool_not_allowed');
  });

  test('tokens: unknown, expired or revoked tokens do nothing; only a hash is stored; issuance checks ownership and tools', async () => {
    const t = await token(A);
    expect((await pool.query('SELECT count(*)::int AS n FROM agent_run_tokens WHERE token_hash = $1', [t.token])).rows[0].n).toBe(0);
    expect(JSON.stringify((await pool.query('SELECT * FROM agent_run_tokens WHERE id = $1', [t.id])).rows)).not.toContain(t.token);
    expect((await callTool(pool, 'not-a-token', 'get_approved_outline', {})).error?.code).toBe('invalid_token');
    const short = await token(A, { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect((await callTool(pool, short.token, 'get_approved_outline', {})).error?.code).toBe('invalid_token');
    await revokeRunToken(pool, t.id);
    expect((await callTool(pool, t.token, 'get_approved_outline', {})).error?.code).toBe('invalid_token');
    await expect(issueRunToken(pool, { ownerId: ids.alice!, paperId: B.paperId, documentId: B.documentId, handleIds: [], provider: 'codex', tools: ALL, ttlMs: 60_000 })).rejects.toThrow(/not found/);
    await expect(token(A, { handleIds: [B.handleId] })).rejects.toThrow(/selection/);
    await expect(token(A, { tools: ['approve_outline'] })).rejects.toThrow(/not a gateway tool/);
    await expect(token(A, { ttlMs: 7 * 24 * 3600e3 })).rejects.toThrow(/ttl/);
  });

  test('every call is audited (tool, outcome, argument hash — not the arguments); the audit cannot be changed', async () => {
    const t = await token(A);
    await callTool(pool, t.token, 'get_approved_outline', {});
    await callTool(pool, t.token, 'approve_outline', { outline_revision_id: A.outlineId });
    const rows = (await pool.query('SELECT tool, outcome, reason, args_sha256 FROM agent_tool_calls WHERE token_id = $1 ORDER BY created_at', [t.id])).rows;
    expect(rows.map((r) => [r.tool, r.outcome])).toEqual([['get_approved_outline', 'ok'], ['approve_outline', 'refused']]);
    expect(rows[1].reason).toBe('forbidden_tool');
    expect(rows[0].args_sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(pool.query('UPDATE agent_tool_calls SET outcome = $1 WHERE token_id = $2', ['ok', t.id])).rejects.toThrow(/immutable|not allowed/);
  });

  // review MINOR: a write and its audit row commit together
  test('a failing audit leaves no proposal behind (the write rolls back with it)', async () => {
    const t = await token(A);
    const before = (await pool.query('SELECT count(*)::int AS n FROM edit_proposals')).rows[0].n;
    await pool.query(`CREATE FUNCTION pw_test_audit_down() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.outcome = 'ok' THEN RAISE EXCEPTION 'audit down'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER pw_test_audit_down BEFORE INSERT ON agent_tool_calls FOR EACH ROW EXECUTE FUNCTION pw_test_audit_down()');
    try {
      const r = await callTool(pool, t.token, 'propose_manuscript_edit', { handle_id: A.handleId, intent: 'concise', replacement: [{ type: 'text', text: 'clear' }] });
      expect(r).toMatchObject({ ok: false, error: { code: 'internal' } });
    } finally {
      await pool.query('DROP TRIGGER pw_test_audit_down ON agent_tool_calls');
      await pool.query('DROP FUNCTION pw_test_audit_down()');
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM edit_proposals')).rows[0].n).toBe(before);
    expect((await pool.query("SELECT outcome FROM agent_tool_calls WHERE token_id = $1", [t.id])).rows).toEqual([{ outcome: 'error' }]);
  });

  test('a run token has a call budget', async () => {
    const t = await token(A);
    await pool.query("INSERT INTO agent_tool_calls (token_id, tool, outcome, args_sha256) SELECT $1, 'get_approved_outline', 'ok', repeat('0', 64) FROM generate_series(1, $2::int)", [t.id, MAX_CALLS_PER_TOKEN]);
    expect((await callTool(pool, t.token, 'get_approved_outline', {})).error?.code).toBe('call_budget_exhausted');
  });

  test('tools that arrive in later tasks are listed nowhere and refused', async () => {
    const t = await token(A);
    for (const name of ['search_literature_with_budget', 'propose_outline_change', 'propose_profile_change', 'add_candidate_reference', 'add_review_finding']) {
      expect((await callTool(pool, t.token, name, {})).error?.code, name).toBe('not_available_yet');
    }
  });
});

describe('transport: a Unix socket bound to one run token, and the MCP stdio bridge for Claude', () => {
  async function rpc(sock: string, lines: unknown[]): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const c = net.connect(sock);
      let buf = '';
      const out: unknown[] = [];
      c.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); if (out.length === lines.length) c.end(); }
      });
      c.on('end', () => resolve(out));
      c.on('error', reject);
      for (const l of lines) c.write(typeof l === 'string' ? l + '\n' : JSON.stringify(l) + '\n');
    });
  }

  test('the socket serves the run\'s tools without the token ever entering the sandbox; bad input is refused', async () => {
    const t = await token(A);
    const sock = path.join(tmp, `tools-${randomUUID().slice(0, 8)}.sock`);
    const srv = await serveToolSocket({ pool, socketPath: sock, token: t.token });
    try {
      expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
      const [list, called, bad, forbidden] = await rpc(sock, [
        { id: 1, method: 'tools/list' },
        { id: 2, method: 'tools/call', params: { name: 'get_document_slice', arguments: { handle_id: A.handleId } } },
        'not json',
        { id: 4, method: 'tools/call', params: { name: 'apply_approved_patch', arguments: {} } },
      ]) as { id: number; result?: { tools?: { name: string }[]; ok?: boolean; result?: { text?: string } }; error?: { code: string } }[];
      expect(list!.result!.tools!.map((x) => x.name)).toEqual([...ALL].sort());
      expect(called!.result).toMatchObject({ ok: true, result: { text: 'very very clear' } });
      expect(bad!.error!.code).toBe('bad_request');
      expect(forbidden!.result).toMatchObject({ ok: false, error: { code: 'forbidden_tool' } });
      const huge = await rpc(sock, [{ id: 5, method: 'tools/call', params: { name: 'get_approved_outline', arguments: { pad: 'x'.repeat(300_000) } } }]);
      expect(huge).toMatchObject([{ error: { code: 'too_large' } }]);
      // a flood without any newline is cut off too (nothing is buffered without bound)
      const flood = await new Promise<string>((resolve) => {
        const c = net.connect(sock);
        let got = '';
        c.on('data', (d) => { got += d; });
        c.on('close', () => resolve(got));
        c.on('error', () => resolve(got));
        const chunk = 'y'.repeat(64 * 1024);
        for (let i = 0; i < 8; i++) c.write(chunk);
      });
      expect(flood).toContain('"too_large"');
      // many requests at once: at most 16 wait, the rest end the connection
      const burst = await rpc(sock, Array.from({ length: 40 }, (_, i) => ({ id: 100 + i, method: 'tools/list' }))).catch(() => []);
      expect(JSON.stringify(burst)).toContain('too_many_requests');
    } finally {
      await srv.close();
    }
    expect(fs.existsSync(sock)).toBe(false);
  });

  test('the MCP bridge answers initialize, tools/list and tools/call over stdio through the socket', async () => {
    const t = await token(A);
    const sock = path.join(tmp, `tools-${randomUUID().slice(0, 8)}.sock`);
    const srv = await serveToolSocket({ pool, socketPath: sock, token: t.token });
    const child = spawn(process.execPath, [BRIDGE, sock], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH! } });
    const answers: { id: number; result?: Record<string, unknown>; error?: { code: number } }[] = [];
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { answers.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n');
    const waitFor = async (n: number) => { for (let i = 0; i < 200 && answers.length < n; i++) await new Promise((r) => setTimeout(r, 20)); };
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_document_slice', arguments: { handle_id: A.handleId } } });
      send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'approve_outline', arguments: {} } });
      send({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
      await waitFor(5);
      const by = (id: number) => answers.find((x) => x.id === id)!;
      expect(by(1).result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'paper-workspace-tools' } });
      expect((by(2).result!.tools as { name: string; inputSchema: unknown }[]).map((x) => x.name)).toEqual([...ALL].sort());
      expect(by(3).result).toMatchObject({ isError: false, content: [{ type: 'text' }] });
      expect(JSON.parse((by(3).result!.content as { text: string }[])[0]!.text)).toMatchObject({ text: 'very very clear' });
      expect(by(4).result).toMatchObject({ isError: true });
      expect(by(5).error!.code).toBe(-32601);
    } finally {
      child.kill();
      await srv.close();
    }
  });
});
