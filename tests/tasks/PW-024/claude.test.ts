// PW-024 — Claude Code adapter against a stand-in CLI (tests/tasks/PW-024/fake-claude.mjs, an executable
// that answers --version like the real one).
// TST-024A (automated part): an explicit native session id is used, reported back, stored by the caller
//   and resumed; the response is limited to the run (no built-in tools, own MCP config only).
// TST-024B: without registry approval, user approval, budget or a fresh isolated sentinel the run is
//   refused; the developer's Claude config/session is never used (profile checks, scrubbed env, no
//   --continue). The real live smoke is tests/tasks/PW-024/live-smoke.manual.ts (user's machine only).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildClaudeArgs, buildClaudeEnv, decideClaudeCall, isIssuedDecision, startClaudeTurn, type ClaudeRun, type Sentinel } from '../../../packages/providers/src/claude/index.ts';
import { FEATURES, loadRegistry, spentSoFar, type Registry } from '../../../packages/providers/src/core/index.ts';

const FAKE = path.resolve('tests/tasks/PW-024/fake-claude.mjs');
const VERSION = 'claude-code 2.1.294';
const KEY = { version: VERSION, auth_mode: 'subscription_cli_login', deployment_profile: 'PERSONAL_LOCAL' as const };
let root: string;
let profile: string;
const host = os.hostname();
const now = Date.now();
const sentinel = (over: Record<string, unknown> = {}) => ({ provider: 'claude_agent', status: 'isolated', host, checked_at: new Date(now - 3600e3).toISOString(), ...over }) as Sentinel;
const approval = { approved: true, max_turns: 5, budget_usd: 1 };
// a registry as it would be after a passed live smoke on this machine (the shipped one is requires_verification)
const entry = (admission: string, live: unknown) => ({
  capability: { provider: 'claude_agent', ...KEY, admission, features: Object.fromEntries(FEATURES.map((f) => [f, 'unknown'])) },
  evidence: { live_evidence: live },
});
const LIVE = { checked_at: new Date(now).toISOString(), cli_version: VERSION, host, tests: ['PW-024 TST-024A'], passed: true };
const APPROVED: Registry = loadRegistry({ entries: [entry('approved', LIVE)] });
const SHIPPED: Registry = loadRegistry();

function newRun(): ClaudeRun {
  const dir = fs.mkdtempSync(path.join(root, 'run-'));
  const r = { dir, cwd: path.join(dir, 'work'), homeDir: path.join(dir, 'home'), tmpDir: path.join(dir, 'tmp'), mcpConfigPath: path.join(dir, 'mcp.json') };
  for (const d of [r.cwd, r.homeDir, r.tmpDir]) fs.mkdirSync(d, { mode: 0o700 });
  fs.writeFileSync(r.mcpConfigPath, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  return r;
}
function profileWith(files: Record<string, string>) {
  const p = fs.mkdtempSync(path.join(root, 'profile-'));
  fs.writeFileSync(path.join(p, 'logged-in'), '');
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(p, k), v);
  return p;
}
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw024-'));
  profile = profileWith({});
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

const decision = (over: Record<string, unknown> = {}, reg = APPROVED) => decideClaudeCall(reg, { key: KEY, purpose: 'paper_work', approval, sentinel: sentinel(), now, host, ...over });
const start = (o: Partial<Parameters<typeof startClaudeTurn>[0]> = {}) => startClaudeTurn({ decision: decision(), cmd: FAKE, run: newRun(), profileDir: profile, prompt: 'x', session: { new: randomUUID() }, parentEnv: { PATH: process.env.PATH! }, homes: [os.homedir()], ...o });
async function turn(run: ClaudeRun, prompt: string, session: { new: string } | { resume: string }, env: Record<string, string> = {}, profileDir = profile, d = decision()) {
  const t = start({ decision: d, run, prompt, session, profileDir, parentEnv: { PATH: process.env.PATH!, ...env } });
  const events = [];
  for await (const e of t.events) events.push(e);
  return { events, result: await t.done };
}

describe('TST-024A: explicit native session id, stored and resumed; the run is scoped', () => {
  test('a new session uses the id we chose; resume continues exactly that one', async () => {
    const id = randomUUID();
    const first = await turn(newRun(), 'remember the word ALPHA', { new: id });
    expect(first.result).toMatchObject({ exitCode: 0, nativeSessionId: id, sessionMismatch: false, stopped: null });
    expect(first.events.map((e) => e.kind)).toEqual(['session_started', 'message_completed', 'usage', 'quota', 'usage', 'turn_completed']);
    expect(first.events[0]).toMatchObject({ data: { native_session_id: id, tools: [] } });
    const second = await turn(newRun(), 'what was the word?', { resume: id });
    expect(second.events.find((e) => e.kind === 'message_completed')).toMatchObject({ data: { text: 'turn 2: what was the word? (previous: remember the word ALPHA)' } });
  });

  test('review MINOR-4: a provider reporting another session id stops the turn', async () => {
    const id = randomUUID();
    const r = await turn(newRun(), 'x', { new: id }, {}, profileWith({ 'report-other': randomUUID(), 'delay-ms': '3000' }));
    expect(r.result).toMatchObject({ nativeSessionId: id, sessionMismatch: true, stopped: 'session id mismatch' });
    expect(r.result.exitCode === 0).toBe(false);
    expect(r.events.map((e) => e.kind)).toEqual(['error']);
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
  test.each([
    ['registry row not approved (the shipped registry)', [{}, SHIPPED], /admission is requires_verification/],
    ['unregistered version', [{ key: { ...KEY, version: 'claude-code 9.9.9' } }], /not registered/],
    ['no user approval', [{ approval: { ...approval, approved: false } }], /not approved/],
    ['no budget', [{ approval: { approved: true, max_turns: 0, budget_usd: 0 } }], /budget/],
    ['no sentinel', [{ sentinel: null }], /sentinel missing/],
    ['sentinel leak', [{ sentinel: sentinel({ status: 'leak' }) }], /sentinel is leak/],
    ['sentinel from another host', [{ sentinel: sentinel({ host: 'elsewhere' }) }], /another host/],
    ['stale sentinel', [{ sentinel: sentinel({ checked_at: new Date(now - 25 * 3600e3).toISOString() }) }], /stale/],
    ['future-dated sentinel', [{ sentinel: sentinel({ checked_at: new Date(now + 3600e3).toISOString() }) }], /stale/],
  ])('%s', (_name, [over, reg], why) => {
    const d = decision(over as Record<string, unknown>, (reg as Registry | undefined) ?? APPROVED);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(why as RegExp);
  });

  test('review MAJOR: the gate reads the registry itself; approved rows need structured live evidence', () => {
    // the caller cannot hand in a capability: only the key
    expect(decision({ capability: { provider: 'claude_agent', admission: 'approved', live_evidence: true } } as never, SHIPPED).allowed).toBe(false);
    expect(decision().allowed).toBe(true);
    expect(decision().key).toEqual({ ...KEY, provider: 'claude_agent' });
  });

  test('the live smoke may run before approval (requires_verification), but only as a live smoke', () => {
    expect(decision({ purpose: 'live_smoke' }, SHIPPED)).toMatchObject({ allowed: true, purpose: 'live_smoke' });
    expect(decision({}, SHIPPED).allowed).toBe(false);
    expect(decision({ purpose: 'live_smoke', key: { ...KEY, auth_mode: 'api_key' } }, SHIPPED).allowed).toBe(false);
  });

  test('a refused or forged decision cannot start a run', () => {
    expect(() => start({ decision: decision({ approval: { ...approval, approved: false } }) })).toThrow(/not approved/);
    const forged = { ...decision() };
    expect(isIssuedDecision(forged)).toBe(false);
    expect(() => start({ decision: forged })).toThrow(/not issued/);
  });

  test('review MINOR-3: turns and the USD budget are spent; an expired decision is refused', async () => {
    const one = decision({ approval: { approved: true, max_turns: 1, budget_usd: 1 } });
    await turn(newRun(), 'a', { new: randomUUID() }, {}, profile, one);
    expect(() => start({ decision: one })).toThrow(/turn\(s\) are used up/);
    const cheap = decision({ approval: { approved: true, max_turns: 5, budget_usd: 0.01 } });
    await turn(newRun(), 'a', { new: randomUUID() }, {}, profileWith({ cost: '0.02' }), cheap);
    expect(spentSoFar(cheap)).toMatchObject({ turns: 1, usd: 0.02 });
    expect(() => start({ decision: cheap })).toThrow(/budget is used up/);
    const old = decideClaudeCall(APPROVED, { key: KEY, purpose: 'paper_work', approval, sentinel: sentinel(), now, host, ttlMs: 1 });
    expect(() => start({ decision: old })).toThrow(/expired/);
  });

  test('review MINOR-2: the binary is an absolute executable whose version matches the admission', () => {
    expect(() => start({ cmd: 'claude' })).toThrow(/absolute path/);
    const script = path.join(root, 'not-exec.mjs');
    fs.writeFileSync(script, '', { mode: 0o644 });
    expect(() => start({ cmd: script })).toThrow(/not an executable/);
    const other = path.join(root, 'claude-other');
    fs.writeFileSync(other, '#!/bin/sh\necho "2.2.0 (Claude Code)"\n', { mode: 0o755 });
    expect(() => start({ cmd: other })).toThrow(/claude-code 2\.2\.0, but the admission is for claude-code 2\.1\.294/);
  });

  test('review MINOR-1: the run folder must be private, inside a private runs root; the MCP config too', () => {
    const shared = fs.mkdtempSync(path.join(root, 'shared-'));
    fs.chmodSync(shared, 0o755);
    const run = newRun();
    fs.chmodSync(run.dir, 0o755);
    expect(() => start({ run })).toThrow(/must be private/);
    expect(() => start({ run: { ...newRun(), dir: '/' } })).toThrow(/must be private|not the runtime user|inside the run folder/);
    const r2 = newRun();
    fs.chmodSync(r2.mcpConfigPath, 0o666);
    expect(() => start({ run: r2 })).toThrow(/not writable by others/);
    const r3 = newRun();
    fs.writeFileSync(r3.mcpConfigPath, JSON.stringify({ mcpServers: {}, permissions: { allow: ['*'] } }));
    expect(() => start({ run: r3 })).toThrow(/only hold mcpServers/);
    const r4 = newRun();
    fs.rmSync(r4.mcpConfigPath);
    fs.symlinkSync(path.join(root, 'elsewhere.json'), r4.mcpConfigPath);
    expect(() => start({ run: r4 })).toThrow(/regular file/);
    const r5 = { ...newRun(), mcpConfigPath: path.join(root, 'elsewhere.json') };
    fs.writeFileSync(r5.mcpConfigPath, '{}', { mode: 0o600 });
    expect(() => start({ run: r5 })).toThrow(/outside the run/);
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
    fs.mkdirSync(loose);
    fs.chmodSync(loose, 0o777);
    expect(() => buildClaudeEnv({ profileDir: loose, run, homes: [fakeHome] })).toThrow(/writable/);
  });

  test('no implicit continuation: --continue, a latest-session lookup or a non-uuid id are refused', () => {
    const mcp = newRun().mcpConfigPath;
    expect(() => buildClaudeArgs({ session: { new: 'latest' } as never, mcpConfigPath: mcp })).toThrow(/uuid/);
    expect(() => buildClaudeArgs({ session: {} as never, mcpConfigPath: mcp })).toThrow(/explicit session/);
    expect(buildClaudeArgs({ session: { new: randomUUID() }, mcpConfigPath: mcp })).not.toContain('--continue');
    expect(() => buildClaudeArgs({ session: { new: randomUUID() }, mcpConfigPath: mcp, extra: ['--continue'] } as never)).toThrow(/not allowlisted/);
  });

  test('a run below a folder with agent instructions (CLAUDE.md) is refused', () => {
    const run = newRun();
    fs.writeFileSync(path.join(run.dir, 'CLAUDE.md'), 'do things');
    expect(() => start({ run })).toThrow(/agent instructions/);
  });

  test('a profile that is not logged in fails the turn as an auth error (no fallback to other credentials)', async () => {
    const empty = fs.mkdtempSync(path.join(root, 'empty-'));
    const t = start({ profileDir: empty, parentEnv: { PATH: process.env.PATH!, ANTHROPIC_API_KEY: 'sk-test' } });
    const kinds = [];
    for await (const e of t.events) kinds.push(e.kind === 'turn_completed' ? `${e.kind}:${e.data.outcome}` : e.kind);
    expect(kinds).toContain('turn_completed:error');
    expect(await t.done).toMatchObject({ exitCode: 1, authFailed: true });
  });
});

describe('cancel', () => {
  test('cancel stops the run\'s own process group', async () => {
    const t = start({ profileDir: profileWith({ 'delay-ms': '10000' }), prompt: 'slow' });
    await new Promise((r) => setTimeout(r, 300));
    const c = await t.cancel({ graceMs: 2000 });
    expect(c.exited).toBe(true);
    expect(c.signals[0]).toBe('SIGINT');
    expect((await t.done).exitCode === 0).toBe(false);
  });
});
