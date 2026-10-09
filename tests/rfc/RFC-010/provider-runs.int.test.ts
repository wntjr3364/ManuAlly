// RFC-010 — real providers run inside the sandbox, on the worker's run path. Stand-in CLIs (no network,
// no model) are installed in a temporary folder and started the way the worker starts a real CLI:
// a claimed job → a run folder and a host-owned, read-only gateway folder → a run token for that job →
// the CLI inside the sandbox (unshare backend; bubblewrap is not installed here) as a recorded run
// process under the supervisor → tool calls through the gateway become pending proposals → usage goes
// to the ledger → token revoked, socket closed, folders removed. Cancel ends everything inside,
// including a process that left the session. Adapters refuse to start a CLI outside the sandbox.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { parseDocument, snapshotSelection } from '../../../packages/editor-core/src/index.ts';
import { cancelJob, claimJob, enqueueJob } from '../../../packages/domain/src/jobs/index.ts';
import { callTool } from '../../../packages/domain/src/tool-policy/index.ts';
import { usageSummary } from '../../../packages/domain/src/usage/index.ts';
import { decideClaudeCall, startClaudeTurn } from '../../../packages/providers/src/claude/index.ts';
import { decideCodexCall, startCodexServer } from '../../../packages/providers/src/codex/index.ts';
import { FEATURES, loadRegistry, type Registry } from '../../../packages/providers/src/core/index.ts';
import { directLauncherForTests, type Launcher } from '../../../packages/providers/src/core/launch.ts';
import { runProviderTurn, type ProviderRunConfig } from '../../../apps/worker/src/provider-runs/index.ts';
import { reconcileRunProcesses } from '../../../apps/worker/src/lifecycle/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
const P1 = '00000000-0000-4000-8000-0000000000b1';
const host = os.hostname();
const now = Date.now();
const CLAUDE_KEY = { version: 'claude-code 2.1.294', auth_mode: 'subscription_cli_login', deployment_profile: 'PERSONAL_LOCAL' as const };
const CODEX_KEY = { version: 'codex-cli 0.161.0', auth_mode: 'chatgpt_login', deployment_profile: 'PERSONAL_LOCAL' as const };
const evidence = (version: string) => ({ live_evidence: { checked_at: new Date(now).toISOString(), cli_version: version, host, tests: ['RFC-010 stand-in'], passed: true, ran_inside_sandbox: true } });
// a registry as it would be after a passed live smoke inside the sandbox — test-only
const APPROVED: Registry = loadRegistry({ entries: [
  { capability: { provider: 'claude_agent', ...CLAUDE_KEY, admission: 'approved', features: Object.fromEntries(FEATURES.map((f) => [f, 'unknown'])) }, evidence: evidence(CLAUDE_KEY.version) },
  { capability: { provider: 'codex', ...CODEX_KEY, admission: 'approved', features: Object.fromEntries(FEATURES.map((f) => [f, 'unknown'])) }, evidence: evidence(CODEX_KEY.version) },
] });
const approval = { approved: true, max_turns: 5, budget_usd: 1 };
const checked = new Date(now - 60e3).toISOString();
const claudeDecision = () => decideClaudeCall(APPROVED, { key: CLAUDE_KEY, purpose: 'paper_work', approval, sentinel: { provider: 'claude_agent', status: 'isolated', host, checked_at: checked }, now, host });
const codexDecision = (kind: 'userns' | 'bubblewrap' = 'userns') => decideCodexCall(APPROVED, {
  key: CODEX_KEY, purpose: 'paper_work', approval, sentinel: { provider: 'codex', status: 'isolated', host, checked_at: checked },
  sandbox: { kind, verified: true, host, checked_at: checked }, now, host,
});

let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
let H: Record<string, string>;
let ownerId: string;
let root: string;
let install: string;
let config: ProviderRunConfig;
// what the sandboxed CLI must not reach
let outside: string;
let decoy: string;
let hostTcp: net.Server;
let hostAbstract: net.Server;
const abstractName = `pw-rfc010-${randomUUID()}`;

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-rfc010-'));
  fs.chmodSync(root, 0o700);
  // the "installed" CLIs: copies outside the source tree (the sandbox never sees the repository)
  install = path.join(root, 'cli');
  fs.mkdirSync(install, { mode: 0o755 });
  fs.copyFileSync(path.resolve('tests/rfc/RFC-010/fake-claude-mcp.mjs'), path.join(install, 'claude'));
  fs.copyFileSync(path.resolve('tests/integration/providers/fake-codex-gateway.mjs'), path.join(install, 'codex'));
  for (const f of ['claude', 'codex']) fs.chmodSync(path.join(install, f), 0o755);
  outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { mode: 0o700 });
  decoy = path.join(outside, 'secret.txt');
  fs.writeFileSync(decoy, 'secret', { mode: 0o600 });
  hostTcp = net.createServer((s) => s.end('host'));
  await new Promise<void>((res) => hostTcp.listen(0, '127.0.0.1', () => res()));
  hostAbstract = net.createServer((s) => s.end('host')).listen(`\0${abstractName}`);
  config = { backend: 'unshare', runsRoot: path.join(root, 'runs'), stateRoot: path.join(root, 'state'), nodePath: process.execPath, readOnly: [install], egressAllow: [], authProfileId: 'test-profile', pollMs: 50 };
});
afterAll(async () => {
  hostTcp?.close();
  hostAbstract?.close();
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
async function claimed(s: Awaited<ReturnType<typeof paperWithSelection>>) {
  const { job } = await enqueueJob(pool, { paperId: s.paperId, ownerId, intent: 'revise_selection', idempotencyKey: randomUUID(), payload: { handle_id: s.handleId } });
  const { fencingToken } = (await claimJob(pool, { jobId: job.id, workerId: 'w1', leaseMs: 60_000 }))!;
  return { id: job.id, fencingToken, paperId: s.paperId, ownerId };
}
// the login profile: its credential file, and other things that must never reach a run
function login(provider: 'claude_agent' | 'codex') {
  const p = profile({ [provider === 'codex' ? 'auth.json' : '.credentials.json']: '{"token":"fake-login"}', 'other-paper-transcript.jsonl': 'SECRET OTHER PAPER', 'settings.json': '{"hooks":{}}' });
  for (const f of fs.readdirSync(p)) fs.chmodSync(path.join(p, f), 0o600);
  return p;
}
// test controls go into the paper's own CLI state folder (where the CLI keeps its sessions)
function controls(provider: 'claude_agent' | 'codex', paperId: string, files: Record<string, string>) {
  let d = config.stateRoot;
  for (const part of ['', provider, paperId]) { d = part ? path.join(d, part) : d; if (!fs.existsSync(d)) fs.mkdirSync(d, { mode: 0o700 }); }
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(d, k), v);
  return d;
}
function profile(files: Record<string, string>) {
  const p = fs.mkdtempSync(path.join(root, 'profile-'));
  fs.chmodSync(p, 0o700);
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(p, k), v);
  return p;
}
const edit = (handleId: string) => JSON.stringify({ tool: 'propose_manuscript_edit', arguments: { handle_id: handleId, intent: 'concise', replacement: [{ type: 'text', text: 'clear' }], explanation: 'shorter' } });
const texts = (events: { kind: string; data: unknown }[]) => events.filter((e) => e.kind === 'message_completed' || e.kind === 'text_delta').map((e) => (e.data as { text: string }).text).join('\n');
const leftovers = (needle: string) => fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).filter((n) => { try { return fs.readFileSync(`/proc/${n}/cmdline`, 'latin1').includes(needle); } catch { return false; } });

describe('RFC-010: the worker runs the CLI inside the sandbox', () => {
  test('Claude: a run proposes through the read-only gateway folder, records usage and leaves nothing behind; the CLI reaches nothing outside', async () => {
    const s = await paperWithSelection();
    const job = await claimed(s);
    const prof = login('claude_agent');
    // another paper's state folder, with a transcript in it
    const other = controls('claude_agent', randomUUID(), { 'sessions-marker': 'OTHER PAPER TRANSCRIPT' });
    controls('claude_agent', s.paperId, { 'tool-call.json': edit(s.handleId), 'probe.json': JSON.stringify({ decoy, outsideDir: outside, runsRoot: config.runsRoot, tcpPort: (hostTcp.address() as net.AddressInfo).port, abstract: abstractName, otherState: other, loginExtra: path.join(prof, 'other-paper-transcript.jsonl') }) });
    fs.mkdirSync(path.join(config.runsRoot, 'other-run'), { recursive: true, mode: 0o700 });
    const r = await runProviderTurn(pool, { job, workerId: 'w1', provider: 'claude_agent', decision: claudeDecision(), cmd: path.join(install, 'claude'), profileDir: prof, prompt: 'Make the selection concise.', documentId: s.documentId, handleIds: [s.handleId], tools: ['get_document_slice', 'propose_manuscript_edit'], session: { new: randomUUID() }, config });
    expect(r.supervised).toMatchObject({ reason: 'exited' });
    const all = texts(r.events);
    // the tool call went through the bridge and the gateway (the token never entered the sandbox)
    expect(all).toContain('"status\\":\\"PENDING');
    const proposals = (await pool.query('SELECT origin, status FROM edit_proposals WHERE document_id = $1', [s.documentId])).rows;
    expect(proposals).toEqual([{ origin: 'worker:tool-gateway:claude_agent', status: 'PENDING' }]);
    // inside: no host files, no other runs, a read-only gateway folder, no host loopback or abstract sockets
    const probe = JSON.parse(all.split('PROBE ')[1]!.split('\n')[0]!);
    expect(probe).toMatchObject({ readDecoy: 'ENOENT', writeOutside: 'ENOENT' });
    // RFC-010 review MAJOR: another paper's CLI state and the rest of the login profile are not there;
    // the credential the CLI runs with is (it always can read it — said in the report)
    expect(probe).toMatchObject({ readOtherPaperState: 'ENOENT', readLoginProfileOther: 'ENOENT', credentialReadable: 'OK' });
    // other runs are not there (only the path to its own run folder exists)
    expect(probe.listRunsRoot).not.toContain('other-run');
    expect(probe.listRunsRoot).toHaveLength(1);
    expect(probe.replaceSocket).toMatch(/^(EROFS|EACCES|EPERM)$/);
    expect(probe.writeGatewayDir).toMatch(/^(EROFS|EACCES|EPERM)$/);
    expect(probe.replaceEgressSocket).toMatch(/^(EROFS|EACCES|EPERM)$/); // review nit: its network cannot be pulled away
    expect(probe.hostTcp).not.toBe('CONNECTED');
    expect(probe.abstractSocket).not.toBe('CONNECTED');
    expect(probe.env.some((k: string) => /TOKEN|DATABASE|PG|PW_RUN_MARKER/.test(k))).toBe(false);
    // network only through the run's egress proxy
    expect(probe.env).toEqual(expect.arrayContaining(['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']));
    // the ledger has the run's usage; the token is dead; the run process ended; nothing is left
    expect((await usageSummary(pool, s.paperId)).billed.input_tokens.value).toBeGreaterThan(0);
    expect((await callTool(pool, r.token, 'get_document_slice', { handle_id: s.handleId })).error?.code).toBe('invalid_token');
    expect((await pool.query('SELECT end_reason FROM run_processes WHERE job_id = $1', [job.id])).rows).toEqual([{ end_reason: 'exited' }]);
    expect(fs.readdirSync(config.runsRoot)).toEqual(['other-run']);
    fs.rmdirSync(path.join(config.runsRoot, 'other-run'));
  });

  test('Codex: the app-server runs inside the sandbox; its tool call reaches the gateway; the job\'s run is recorded', async () => {
    const s = await paperWithSelection();
    const job = await claimed(s);
    const prof = login('codex');
    controls('codex', s.paperId, { 'tool-call.json': edit(s.handleId) });
    const r = await runProviderTurn(pool, { job, workerId: 'w1', provider: 'codex', decision: codexDecision(), cmd: path.join(install, 'codex'), profileDir: prof, prompt: 'Make the selection concise.', documentId: s.documentId, handleIds: [s.handleId], tools: ['get_document_slice', 'propose_manuscript_edit'], config });
    expect(r.events.at(-1)).toMatchObject({ kind: 'turn_completed' });
    expect(r.nativeSessionId).toMatch(/^th-/);
    expect((await pool.query('SELECT origin, status FROM edit_proposals WHERE document_id = $1', [s.documentId])).rows).toEqual([{ origin: 'worker:tool-gateway:codex', status: 'PENDING' }]);
    expect((await usageSummary(pool, s.paperId)).billed.input_tokens).toEqual({ value: 900, unknown: false });
    expect((await pool.query('SELECT end_reason FROM run_processes WHERE job_id = $1', [job.id])).rows).toEqual([{ end_reason: 'exited' }]);
    expect(fs.readdirSync(config.runsRoot)).toEqual([]);
  });

  test('cancel: the run ends inside the sandbox too, including a process that left the session; the token dies', async () => {
    const s = await paperWithSelection();
    const job = await claimed(s);
    const needle = `0.${randomInt(1e8, 1e9)}`;
    const prof = login('claude_agent');
    controls('claude_agent', s.paperId, { grandchild: needle, slow: '' });
    const run = runProviderTurn(pool, { job, workerId: 'w1', provider: 'claude_agent', decision: claudeDecision(), cmd: path.join(install, 'claude'), profileDir: prof, prompt: 'x', documentId: s.documentId, handleIds: [s.handleId], tools: ['get_document_slice'], session: { new: randomUUID() }, config: { ...config, interruptGraceMs: 300, killGraceMs: 300 } });
    await expect.poll(() => leftovers(needle).length, { timeout: 15_000 }).toBeGreaterThan(0);
    await cancelJob(pool, { paperId: s.paperId, jobId: job.id, ownerId });
    const r = await run;
    expect(r.supervised.reason).toBe('cancelled');
    await expect.poll(() => leftovers(needle).length, { timeout: 5_000 }).toBe(0);
    expect((await callTool(pool, r.token, 'get_document_slice', { handle_id: s.handleId })).error?.code).toBe('invalid_token');
    expect(fs.readdirSync(config.runsRoot)).toEqual([]);
  });

  test('after a worker restart: a sandboxed run whose job no longer runs is recognised and ended by reconcile', async () => {
    const s = await paperWithSelection();
    const job = await claimed(s);
    const needle = `0.${randomInt(1e8, 1e9)}`;
    const prof = login('claude_agent');
    controls('claude_agent', s.paperId, { grandchild: needle, slow: '' });
    // a supervisor that would not look in time (as if its worker were gone)
    const run = runProviderTurn(pool, { job, workerId: 'w-dead', provider: 'claude_agent', decision: claudeDecision(), cmd: path.join(install, 'claude'), profileDir: prof, prompt: 'x', documentId: s.documentId, handleIds: [s.handleId], tools: ['get_document_slice'], session: { new: randomUUID() }, config: { ...config, pollMs: 600_000, killGraceMs: 300 } });
    await expect.poll(() => leftovers(needle).length, { timeout: 15_000 }).toBeGreaterThan(0);
    await cancelJob(pool, { paperId: s.paperId, jobId: job.id, ownerId }); // the dead worker's supervisor does not see it
    expect(await reconcileRunProcesses(pool, { workerId: 'w-new', graceMs: 300 })).toMatchObject({ ended: 1 });
    await expect.poll(() => leftovers(needle).length, { timeout: 5_000 }).toBe(0);
    // (the old supervisor, still in this process, may see the exit first and record it as such)
    expect(['reconciled', 'exited']).toContain((await pool.query('SELECT end_reason FROM run_processes WHERE job_id = $1', [job.id])).rows[0].end_reason);
    await run;
    expect(fs.readdirSync(config.runsRoot)).toEqual([]);
  });
});

describe('RFC-010: adapters start a CLI only inside the sandbox', () => {
  const run = () => {
    const dir = fs.mkdtempSync(path.join(root, 'adhoc-'));
    const r = { dir, cwd: path.join(dir, 'work'), homeDir: path.join(dir, 'home'), tmpDir: path.join(dir, 'tmp'), mcpConfigPath: path.join(dir, 'mcp.json') };
    for (const x of [r.cwd, r.homeDir, r.tmpDir]) fs.mkdirSync(x, { mode: 0o700 });
    fs.writeFileSync(r.mcpConfigPath, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
    return r;
  };
  const host: Launcher = { sandboxed: false, kind: null, version: directLauncherForTests.version, spawn: directLauncherForTests.spawn };
  const fakeSandboxed: Launcher = { sandboxed: true, kind: 'bubblewrap', version: directLauncherForTests.version, spawn: directLauncherForTests.spawn };
  test('no launcher, or a launcher that starts on the host, is refused before anything runs', async () => {
    const prof = profile({ '.credentials.json': 'x' });
    const base = { decision: claudeDecision(), cmd: path.join(install, 'claude'), run: run(), profileDir: prof, prompt: 'x', session: { new: randomUUID() } };
    expect(() => startClaudeTurn(base as never)).toThrow(/inside the sandbox/);
    expect(() => startClaudeTurn({ ...base, launcher: host })).toThrow(/inside the sandbox/);
    await expect(startCodexServer({ decision: codexDecision(), cmd: path.join(install, 'codex'), run: run(), profileDir: profile({}), launcher: host })).rejects.toThrow(/inside the sandbox/);
  });
  test('Codex: the run starts in the kind of sandbox the admission verified', async () => {
    await expect(startCodexServer({ decision: codexDecision('userns'), cmd: path.join(install, 'codex'), run: run(), profileDir: profile({}), launcher: fakeSandboxed })).rejects.toThrow(/bubblewrap.*userns|verified/);
  });
  test('only tests start a CLI on the host: the test launcher is not used in shipped code', () => {
    const out = execFileSync('grep', ['-rl', '--exclude-dir=node_modules', 'directLauncherForTests', 'apps', 'packages', 'infra'], { encoding: 'utf8' }).trim().split('\n');
    expect(out).toEqual(['packages/providers/src/core/launch.ts']);
  });
});

describe('RFC-010 review: a paper\'s CLI state is its own; the login profile gives only its credential', () => {
  test('each paper has its own state folder; transcripts stay there; a token refresh reaches the login profile', async () => {
    const s = await paperWithSelection();
    const job = await claimed(s);
    const prof = login('claude_agent');
    const mine = controls('claude_agent', s.paperId, { refresh: '{"token":"refreshed"}' });
    const session = randomUUID();
    await runProviderTurn(pool, { job, workerId: 'w1', provider: 'claude_agent', decision: claudeDecision(), cmd: path.join(install, 'claude'), profileDir: prof, prompt: 'x', documentId: s.documentId, handleIds: [s.handleId], tools: ['get_document_slice'], session: { new: session }, config });
    expect(fs.existsSync(path.join(mine, 'sessions', `${session}.json`))).toBe(true);
    expect(fs.existsSync(path.join(prof, 'sessions'))).toBe(false);
    // the refreshed token was written through the bind into the login profile's file
    expect(fs.readFileSync(path.join(prof, '.credentials.json'), 'utf8')).toBe('{"token":"refreshed"}');
  });

  test('instructions, hooks or settings planted in a paper\'s state folder stop the next start; a missing login is said', async () => {
    const s = await paperWithSelection();
    const prof = login('claude_agent');
    for (const planted of ['settings.json', 'CLAUDE.md', 'AGENTS.md', 'hooks']) {
      const dir = controls('claude_agent', s.paperId, {});
      if (planted === 'hooks') fs.mkdirSync(path.join(dir, 'hooks')); else fs.writeFileSync(path.join(dir, planted), 'x');
      const job = await claimed(s);
      await expect(runProviderTurn(pool, { job, workerId: 'w1', provider: 'claude_agent', decision: claudeDecision(), cmd: path.join(install, 'claude'), profileDir: prof, prompt: 'x', documentId: s.documentId, handleIds: [s.handleId], tools: ['get_document_slice'], session: { new: randomUUID() }, config })).rejects.toThrow(new RegExp(planted));
      fs.rmSync(path.join(dir, planted), { recursive: true });
      expect((await pool.query('SELECT count(*)::int AS n FROM run_processes WHERE job_id = $1', [job.id])).rows[0].n).toBe(0);
    }
    const job = await claimed(s);
    await expect(runProviderTurn(pool, { job, workerId: 'w1', provider: 'codex', decision: codexDecision(), cmd: path.join(install, 'codex'), profileDir: profile({}), prompt: 'x', documentId: s.documentId, handleIds: [s.handleId], tools: ['get_document_slice'], config })).rejects.toThrow(/no auth\.json; log in/);
    expect(fs.readdirSync(config.runsRoot)).toEqual([]);
  });

  test('MINOR: a run that fails half-way leaves no process and no folder (start recorded or not)', async () => {
    const s = await paperWithSelection();
    const prof = login('claude_agent');
    // (a) the start cannot be recorded: the started CLI is still ended
    let needle = `0.${randomInt(1e8, 1e9)}`;
    controls('claude_agent', s.paperId, { grandchild: needle, slow: '' });
    let job = await claimed(s);
    await expect(runProviderTurn(pool, { job, workerId: 'w'.repeat(300), provider: 'claude_agent', decision: claudeDecision(), cmd: path.join(install, 'claude'), profileDir: prof, prompt: 'x', documentId: s.documentId, handleIds: [s.handleId], tools: ['get_document_slice'], session: { new: randomUUID() }, config })).rejects.toThrow();
    await expect.poll(() => leftovers(needle).length, { timeout: 5_000 }).toBe(0);
    await expect.poll(() => leftovers(path.join(install, 'claude')).length, { timeout: 5_000 }).toBe(0); // the CLI itself
    expect(fs.readdirSync(config.runsRoot)).toEqual([]);
    // (b) handling an event fails: the recorded run is ended
    needle = `0.${randomInt(1e8, 1e9)}`;
    controls('claude_agent', s.paperId, { grandchild: needle, slow: '' });
    job = await claimed(s);
    await expect(runProviderTurn(pool, { job, workerId: 'w1', provider: 'claude_agent', decision: claudeDecision(), cmd: path.join(install, 'claude'), profileDir: prof, prompt: 'x', documentId: s.documentId, handleIds: [s.handleId], tools: ['get_document_slice'], session: { new: randomUUID() }, config: { ...config, killGraceMs: 300 }, onEvent: () => { throw new Error('event handling failed'); } })).rejects.toThrow(/event handling failed/);
    await expect.poll(() => leftovers(needle).length, { timeout: 5_000 }).toBe(0);
    await expect.poll(() => leftovers(path.join(install, 'claude')).length, { timeout: 5_000 }).toBe(0);
    expect(fs.readdirSync(config.runsRoot)).toEqual([]);
    for (const f of ['grandchild', 'slow']) fs.rmSync(path.join(config.stateRoot, 'claude_agent', s.paperId, f));
  });
});
