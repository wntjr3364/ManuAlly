// PW-024 — Claude Code adapter against a stand-in CLI (tests/tasks/PW-024/fake-claude.mjs).
// TST-024A (automated part): an explicit native session id is used, reported back, stored by the caller
//   and resumed; the response is limited to the run (no built-in tools, own MCP config only).
// TST-024B: without approval, budget or a fresh isolated sentinel the run is refused; the developer's
//   Claude config/session is never used (profile checks, scrubbed env, no --continue).
// The real live smoke is tests/tasks/PW-024/live-smoke.manual.ts (user's machine; not run here).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildClaudeArgs, buildClaudeEnv, decideClaudeCall, isIssuedDecision, startClaudeTurn, type ClaudeRun, type Sentinel } from '../../../packages/providers/src/claude/index.ts';
import { loadRegistry, resolveCapability } from '../../../packages/providers/src/core/index.ts';

const FAKE = path.resolve('tests/tasks/PW-024/fake-claude.mjs');
let root: string;
let profile: string;
const host = os.hostname();
const now = Date.now();
const sentinel = (over: Record<string, unknown> = {}) => ({ provider: 'claude_agent', status: 'isolated', host, checked_at: new Date(now - 3600e3).toISOString(), ...over }) as Sentinel;
const approvedCap = () => ({ ...resolveCapability(loadRegistry(), { provider: 'claude_agent', version: 'claude-code 2.1.294', auth_mode: 'subscription_cli_login', deployment_profile: 'PERSONAL_LOCAL' }), admission: 'approved' as const, live_evidence: { host, checked_at: new Date(now).toISOString() } });
const approval = { approved: true, max_turns: 3, budget_usd: 1 };

function newRun(): ClaudeRun {
  const dir = fs.mkdtempSync(path.join(root, 'run-'));
  const r = { dir, cwd: path.join(dir, 'work'), homeDir: path.join(dir, 'home'), tmpDir: path.join(dir, 'tmp'), mcpConfigPath: path.join(dir, 'mcp.json') };
  for (const d of [r.cwd, r.homeDir, r.tmpDir]) fs.mkdirSync(d, { mode: 0o700 });
  fs.writeFileSync(r.mcpConfigPath, JSON.stringify({ mcpServers: {} }));
  return r;
}
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw024-'));
  profile = path.join(root, 'profile');
  fs.mkdirSync(profile, { mode: 0o700 });
  fs.writeFileSync(path.join(profile, 'logged-in'), '');
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

const decision = () => {
  const d = decideClaudeCall({ capability: approvedCap(), purpose: 'paper_work', approval, sentinel: sentinel(), now, host });
  expect(d).toMatchObject({ allowed: true });
  return d;
};
// a separate logged-in profile with test controls (files the stand-in CLI reads)
function profileWith(files: Record<string, string>) {
  const p = fs.mkdtempSync(path.join(root, 'profile-'));
  fs.chmodSync(p, 0o700);
  fs.writeFileSync(path.join(p, 'logged-in'), '');
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(p, k), v);
  return p;
}
async function turn(run: ClaudeRun, prompt: string, session: { new: string } | { resume: string }, env: Record<string, string> = {}, profileDir = profile) {
  const t = startClaudeTurn({ decision: decision(), cmd: process.execPath, cmdPrefix: [FAKE], run, profileDir, prompt, session, parentEnv: { PATH: process.env.PATH!, ...env }, homes: [os.homedir()] });
  const events = [];
  for await (const e of t.events) events.push(e);
  return { events, result: await t.done };
}

describe('TST-024A: explicit native session id, stored and resumed; the run is scoped', () => {
  test('a new session uses the id we chose; resume continues exactly that one', async () => {
    const id = randomUUID();
    const first = await turn(newRun(), 'remember the word ALPHA', { new: id });
    expect(first.result).toMatchObject({ exitCode: 0, nativeSessionId: id, sessionMismatch: false });
    expect(first.events.map((e) => e.kind)).toEqual(['session_started', 'message_completed', 'usage', 'quota', 'usage', 'turn_completed']);
    expect(first.events[0]).toMatchObject({ data: { native_session_id: id, tools: [] } });
    // the caller stores `id` (agent_sessions) and resumes it explicitly in a fresh run
    const second = await turn(newRun(), 'what was the word?', { resume: id });
    expect(second.events.find((e) => e.kind === 'message_completed')).toMatchObject({ data: { text: 'turn 2: what was the word? (previous: remember the word ALPHA)' } });
  });

  test('a provider reporting another session id is flagged, not adopted', async () => {
    const id = randomUUID();
    const r = await turn(newRun(), 'x', { new: id }, {}, profileWith({ 'report-other': randomUUID() }));
    expect(r.result).toMatchObject({ nativeSessionId: id, sessionMismatch: true });
  });

  test('the CLI gets the locked-down flags, the run folders and nothing else', async () => {
    const run = newRun();
    await turn(run, 'hello', { new: randomUUID() }, { ANTHROPIC_API_KEY: 'sk-test-not-real', SECRET_DB_URL: 'postgres://x', CLAUDE_CODE_OAUTH_TOKEN: 'nope' });
    const seen = JSON.parse(fs.readFileSync(path.join(run.homeDir, 'seen.json'), 'utf8'));
    expect(seen.args).toEqual(expect.arrayContaining(['-p', '--tools', '', '--restricted', '--strict-mcp-config', '--mcp-config', run.mcpConfigPath, '--allowedTools', 'mcp__paper', '--permission-mode', 'dontAsk', '--disable-slash-commands']));
    expect(seen.env).toEqual(['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CONFIG_DIR', 'HOME', 'LANG', 'PATH', 'TMPDIR', 'TZ']);
    expect(seen.cwd).toBe(fs.realpathSync(run.cwd));
    expect(seen.home).toBe(run.homeDir);
    expect(seen.config).toBe(fs.realpathSync(profile));
  });
});

describe('TST-024B: no approval/budget/sentinel → refused; the developer\'s Claude state is never used', () => {
  const base = () => ({ capability: approvedCap(), purpose: 'paper_work' as const, approval, sentinel: sentinel(), now, host });
  test.each([
    ['registry not approved', { capability: { ...approvedCap(), admission: 'requires_verification' as const } }, /admission is requires_verification/],
    ['disabled combination', { capability: { ...approvedCap(), admission: 'disabled' as const } }, /disabled/],
    ['no user approval', { approval: { ...approval, approved: false } }, /not approved/],
    ['no budget', { approval: { approved: true, max_turns: 0, budget_usd: 0 } }, /budget/],
    ['no sentinel', { sentinel: null }, /sentinel missing/],
    ['sentinel leak', { sentinel: sentinel({ status: 'leak' }) }, /sentinel is leak/],
    ['sentinel from another host', { sentinel: sentinel({ host: 'elsewhere' }) }, /another host|not this host/],
    ['stale sentinel', { sentinel: sentinel({ checked_at: new Date(now - 25 * 3600e3).toISOString() }) }, /stale/],
    ['future-dated sentinel', { sentinel: sentinel({ checked_at: new Date(now + 3600e3).toISOString() }) }, /stale/],
  ])('%s', (_name, over, why) => {
    const d = decideClaudeCall({ ...base(), ...over } as never);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(why);
  });

  test('the live smoke may run before approval (requires_verification), but only as a live smoke', () => {
    const cap = { ...approvedCap(), admission: 'requires_verification' as const, live_evidence: null };
    expect(decideClaudeCall({ capability: cap, purpose: 'live_smoke', approval, sentinel: sentinel(), now, host })).toMatchObject({ allowed: true, purpose: 'live_smoke' });
    expect(decideClaudeCall({ capability: cap, purpose: 'paper_work', approval, sentinel: sentinel(), now, host }).allowed).toBe(false);
    expect(decideClaudeCall({ capability: { ...cap, admission: 'disabled' }, purpose: 'live_smoke', approval, sentinel: sentinel(), now, host }).allowed).toBe(false);
  });

  test('a refused or forged decision cannot start a run', () => {
    const refused = decideClaudeCall({ ...base(), approval: { ...approval, approved: false } });
    expect(() => startClaudeTurn({ decision: refused, cmd: process.execPath, cmdPrefix: [FAKE], run: newRun(), profileDir: profile, prompt: 'x', session: { new: randomUUID() } })).toThrow(/not approved|refused/);
    const forged = { ...decision() };
    expect(isIssuedDecision(forged)).toBe(false);
    expect(() => startClaudeTurn({ decision: forged as never, cmd: process.execPath, cmdPrefix: [FAKE], run: newRun(), profileDir: profile, prompt: 'x', session: { new: randomUUID() } })).toThrow(/not issued/);
  });

  test('the developer\'s ~/.claude, HOME or a symlink to them is never a profile', () => {
    const fakeHome = fs.mkdtempSync(path.join(root, 'home-'));
    fs.mkdirSync(path.join(fakeHome, '.claude'), { mode: 0o700 });
    const run = newRun();
    expect(() => buildClaudeEnv({ profileDir: path.join(fakeHome, '.claude'), run, homes: [fakeHome] })).toThrow(/developer CLI state/);
    expect(() => buildClaudeEnv({ profileDir: fakeHome, run, homes: [fakeHome] })).toThrow(/home directory/);
    const link = path.join(root, 'link-profile');
    fs.symlinkSync(path.join(fakeHome, '.claude'), link);
    expect(() => buildClaudeEnv({ profileDir: link, run, homes: [fakeHome] })).toThrow(/symlink/);
    const loose = path.join(root, 'loose');
    fs.mkdirSync(loose, { mode: 0o777 });
    fs.chmodSync(loose, 0o777);
    expect(() => buildClaudeEnv({ profileDir: loose, run, homes: [fakeHome] })).toThrow(/writable/);
  });

  test('no implicit continuation: --continue, a latest-session lookup or a non-uuid id are refused', () => {
    const mcp = path.join(newRun().dir, 'mcp.json');
    expect(() => buildClaudeArgs({ session: { new: 'latest' } as never, mcpConfigPath: mcp })).toThrow(/uuid/);
    expect(() => buildClaudeArgs({ session: {} as never, mcpConfigPath: mcp })).toThrow(/explicit session/);
    const args = buildClaudeArgs({ session: { new: randomUUID() }, mcpConfigPath: mcp });
    expect(args).not.toContain('--continue');
    expect(() => buildClaudeArgs({ session: { new: randomUUID() }, mcpConfigPath: mcp, extra: ['--continue'] } as never)).toThrow(/not allowlisted/);
  });

  test('a run below a folder with agent instructions (CLAUDE.md) is refused', () => {
    const run = newRun();
    fs.writeFileSync(path.join(run.dir, 'CLAUDE.md'), 'do things');
    expect(() => startClaudeTurn({ decision: decision(), cmd: process.execPath, cmdPrefix: [FAKE], run, profileDir: profile, prompt: 'x', session: { new: randomUUID() } })).toThrow(/agent instructions/);
  });

  test('an MCP config outside the run folder is refused', () => {
    const run = { ...newRun(), mcpConfigPath: path.join(root, 'elsewhere.json') };
    fs.writeFileSync(run.mcpConfigPath, '{}');
    expect(() => startClaudeTurn({ decision: decision(), cmd: process.execPath, cmdPrefix: [FAKE], run, profileDir: profile, prompt: 'x', session: { new: randomUUID() } })).toThrow(/outside the run/);
  });

  test('a profile that is not logged in fails the turn as an auth error (no fallback to other credentials)', async () => {
    const empty = path.join(root, 'empty-profile');
    fs.mkdirSync(empty, { mode: 0o700 });
    const t = startClaudeTurn({ decision: decision(), cmd: process.execPath, cmdPrefix: [FAKE], run: newRun(), profileDir: empty, prompt: 'x', session: { new: randomUUID() }, parentEnv: { PATH: process.env.PATH!, ANTHROPIC_API_KEY: 'sk-test' } });
    const kinds = [];
    for await (const e of t.events) kinds.push(e.kind === 'turn_completed' ? `${e.kind}:${e.data.outcome}` : e.kind);
    expect(kinds).toContain('turn_completed:error');
    expect(await t.done).toMatchObject({ exitCode: 1, authFailed: true });
  });
});

describe('cancel', () => {
  test('cancel stops the run\'s own process group', async () => {
    const t = startClaudeTurn({ decision: decision(), cmd: process.execPath, cmdPrefix: [FAKE], run: newRun(), profileDir: profileWith({ 'delay-ms': '10000' }), prompt: 'slow', session: { new: randomUUID() } });
    await new Promise((r) => setTimeout(r, 300)); // running and waiting before its answer
    const c = await t.cancel({ graceMs: 2000 });
    expect(c.exited).toBe(true);
    expect(c.signals[0]).toBe('SIGINT');
    const d = await t.done;
    expect(d.exitCode === 0).toBe(false);
  });
});
