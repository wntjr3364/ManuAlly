// PW-025 — Codex app-server adapter against a stand-in server (tests/tasks/PW-025/fake-codex.mjs).
// TST-025A: initialize → thread → turn works and every event is normalized to the provider_event contract.
// TST-025B: the server is private stdio (never a port), only allowlisted client methods are sent,
//   approval/unknown server requests are declined, and tool calls go only to the tool gateway.
// Codex stays non-admitted until an outer filesystem sandbox is verified (RFC-004).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCodexArgs, decideCodexCall, guardClientRequest, startCodexServer, serverRequestAnswer, type CodexRun, type CodexSentinel, type OuterSandbox } from '../../../packages/providers/src/codex/index.ts';
import { FEATURES, loadRegistry, type Registry } from '../../../packages/providers/src/core/index.ts';
import { validateProviderEvent } from '../../../packages/contracts/src/provider/index.ts';
import { directLauncherForTests } from '../../../packages/providers/src/core/launch.ts';

const FAKE = path.resolve('tests/tasks/PW-025/fake-codex.mjs');
const host = os.hostname();
const now = Date.now();
let root: string;
let profile: string;
const sentinel = (over: Record<string, unknown> = {}) => ({ provider: 'codex', status: 'isolated', host, checked_at: new Date(now - 60e3).toISOString(), ...over }) as CodexSentinel;
const sandbox = (over: Record<string, unknown> = {}) => ({ kind: 'bubblewrap', verified: true, host, checked_at: new Date(now - 60e3).toISOString(), ...over }) as OuterSandbox;
const KEY = { version: 'codex-cli 0.161.0', auth_mode: 'chatgpt_login', deployment_profile: 'PERSONAL_LOCAL' as const };
// the registry after a passed live smoke on this machine (the shipped one is requires_verification)
const APPROVED: Registry = loadRegistry({ entries: [{
  capability: { provider: 'codex', ...KEY, admission: 'approved', features: Object.fromEntries(FEATURES.map((f) => [f, 'unknown'])) },
  evidence: { live_evidence: { checked_at: new Date(now).toISOString(), cli_version: KEY.version, host, tests: ['PW-025 live'], passed: true, ran_inside_sandbox: true } },
}] });
const approval = { approved: true, max_turns: 10, budget_usd: 1 };
const decision = (over: Record<string, unknown> = {}, reg = APPROVED) => decideCodexCall(reg, { key: KEY, purpose: 'paper_work', approval, sentinel: sentinel(), sandbox: sandbox(), now, host, ...over });

function newRun(): CodexRun {
  const dir = fs.mkdtempSync(path.join(root, 'run-'));
  const r = { dir, cwd: path.join(dir, 'work'), homeDir: path.join(dir, 'home'), tmpDir: path.join(dir, 'tmp') };
  for (const d of [r.cwd, r.homeDir, r.tmpDir]) fs.mkdirSync(d, { mode: 0o700 });
  return r;
}
const seen = (run: CodexRun) => JSON.parse(fs.readFileSync(path.join(run.homeDir, 'seen.json'), 'utf8'));
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw025-'));
  profile = path.join(root, 'profile');
  fs.mkdirSync(profile, { mode: 0o700 });
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

async function server(run = newRun(), profileDir = profile, onToolCall?: (name: string, args: unknown) => Promise<unknown>) {
  return { run, s: await startCodexServer({ launcher: directLauncherForTests, decision: decision(), cmd: FAKE, run, profileDir, homes: [os.homedir()], parentEnv: { PATH: process.env.PATH!, OPENAI_API_KEY: 'sk-not-real' }, onToolCall }) };
}

describe('TST-025A: initialize → thread → turn, normalized events', () => {
  test('a turn streams deltas, the message, usage and completion; every event matches the contract', async () => {
    const { run, s } = await server();
    const thread = await s.startThread();
    expect(thread).toBe('th-1');
    const events = [];
    for await (const e of s.runTurn(thread, 'hello paper')) events.push(e);
    await s.close();
    // turn/started and fs/changed are not interpreted (unrecognized)
    expect(events.map((e) => e.kind)).toEqual(['unrecognized', 'text_delta', 'text_delta', 'message_completed', 'usage', 'unrecognized', 'turn_completed']);
    expect(events.find((e) => e.kind === 'message_completed')).toMatchObject({ data: { text: 'Echo: hello paper' } });
    expect(events.at(-1)).toMatchObject({ data: { outcome: 'success' } });
    for (const e of events) expect(validateProviderEvent(e).ok).toBe(true);
    const sent = seen(run).client;
    expect(sent.slice(0, 4)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
  });

  test('resume uses the stored thread id only; an unknown id fails', async () => {
    const { s } = await server();
    await expect(s.resumeThread('th-404')).rejects.toThrow(/thread not found/);
    const id = await s.startThread();
    expect(await s.resumeThread(id)).toBe(id);
    await s.close();
  });

  test('interrupt ends the open turn as interrupted', async () => {
    const slow = path.join(root, 'profile-slow');
    fs.mkdirSync(slow, { mode: 0o700 });
    fs.writeFileSync(path.join(slow, 'slow'), '');
    const { s } = await server(newRun(), slow);
    const thread = await s.startThread();
    const it = s.runTurn(thread, 'long');
    const kinds: string[] = [];
    const collecting = (async () => { for await (const e of it) kinds.push(e.kind === 'turn_completed' ? `done:${e.data.outcome}` : e.kind); })();
    await new Promise((r) => setTimeout(r, 200));
    await s.interrupt(thread);
    await collecting;
    expect(kinds.at(-1)).toBe('done:interrupted');
    await s.close();
  });
});

describe('TST-025B: private stdio, allowlisted methods, declined server requests', () => {
  test('the server only listens on private stdio and runs read-only with shell features off', () => {
    expect(() => buildCodexArgs({ listen: 'ws://127.0.0.1:4500' } as never)).toThrow(/private stdio/);
    const args = buildCodexArgs();
    expect(args.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    expect(args).toContain('sandbox_mode="read-only"');
    expect(args).toContain('features.shell_tool=false');
  });

  test('client methods outside the allowlist are refused before anything is sent', async () => {
    for (const m of ['thread/shellCommand', 'command/exec', 'fs/writeFile', 'fs/readFile', 'account/rateLimitResetCredit/consume', 'config/value/write', 'plugin/install', 'thread/delete', 'made/up']) {
      expect(() => guardClientRequest(m)).toThrow(/not allowlisted/);
    }
    expect(guardClientRequest('turn/start')).toBe('turn/start');
    const { s } = await server();
    // review MAJOR-1: no raw RPC at all (an allowlisted method with free parameters could override the
    // sandbox, approval policy or working folder); only the typed calls exist
    expect(Object.keys(s).sort()).toEqual(['close', 'interrupt', 'resumeThread', 'runTurn', 'startThread']);
    expect((s as Record<string, unknown>).request).toBeUndefined();
    await s.close();
  });

  test('approval and unknown server requests are declined; the server sees the decline', async () => {
    const { run, s } = await server();
    const t = await s.startThread();
    for await (const e of s.runTurn(t, 'x')) void e;
    await s.close();
    const answers = seen(run).answers;
    expect(answers['item/commandExecution/requestApproval']).toEqual({ decision: 'decline' });
    expect(answers['made/up/request']).toMatchObject({ error: { code: -32601 } });
    expect(serverRequestAnswer('item/fileChange/requestApproval')).toEqual({ result: { decision: 'decline' } });
    // review: each request gets the answer its own schema takes (legacy approvals: `denied`); requests
    // that are not approvals get an error rather than a guessed "decline"
    expect(serverRequestAnswer('execCommandApproval')).toEqual({ result: { decision: 'denied' } });
    expect(serverRequestAnswer('applyPatchApproval')).toEqual({ result: { decision: 'denied' } });
    expect(serverRequestAnswer('account/chatgptAuthTokens/refresh')).toMatchObject({ error: { code: -32000 } });
  });

  test('a tool call goes to the tool gateway only; without a gateway it is declined', async () => {
    const withTool = path.join(root, 'profile-tool');
    fs.mkdirSync(withTool, { mode: 0o700 });
    fs.writeFileSync(path.join(withTool, 'ask-tool'), '');
    const calls: unknown[] = [];
    const a = await server(newRun(), withTool, async (name, args) => { calls.push([name, args]); return { content: [{ type: 'text', text: 'slice' }] }; });
    for await (const e of a.s.runTurn(await a.s.startThread(), 'x')) void e;
    await a.s.close();
    expect(calls).toEqual([['get_document_slice', { block: 'x' }]]);
    expect(seen(a.run).answers['item/tool/call']).toEqual({ content: [{ type: 'text', text: 'slice' }] });
    const b = await server(newRun(), withTool);
    for await (const e of b.s.runTurn(await b.s.startThread(), 'x')) void e;
    await b.s.close();
    expect(seen(b.run).answers['item/tool/call']).toMatchObject({ error: { code: -32601 } });
  });

  test('the child gets CODEX_HOME and run folders, nothing else (no API key)', async () => {
    const { run, s } = await server();
    await s.close();
    expect(seen(run).env).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'PATH', 'TMPDIR', 'TZ']);
  });

  test('a different CLI version or a non-absolute command is refused (the RPC policy is pinned to 0.161.0)', async () => {
    const other = path.join(root, 'codex-other');
    fs.writeFileSync(other, '#!/bin/sh\necho "codex-cli 0.170.0"\n', { mode: 0o755 });
    await expect(startCodexServer({ launcher: directLauncherForTests, decision: decision(), cmd: other, run: newRun(), profileDir: profile, parentEnv: { PATH: process.env.PATH! } })).rejects.toThrow(/0\.170\.0, but the admission is for codex-cli 0\.161\.0/);
    await expect(startCodexServer({ launcher: directLauncherForTests, decision: decision(), cmd: 'codex', run: newRun(), profileDir: profile })).rejects.toThrow(/absolute path/);
  });
  test('review MAJOR-2: a second turn while one is running is refused (events cannot cross turns)', async () => {
    const slow = path.join(root, 'profile-slow2');
    fs.mkdirSync(slow, { mode: 0o700 });
    fs.writeFileSync(path.join(slow, 'slow'), '');
    const { s } = await server(newRun(), slow);
    const t1 = await s.startThread();
    const t2 = await s.startThread();
    const first = s.runTurn(t1, 'one');
    await first.next();
    await expect(s.runTurn(t2, 'two').next()).rejects.toThrow(/already running/);
    await s.interrupt(t1);
    for await (const e of first) void e;
    // once the first turn ended, the next one may start
    const again = s.runTurn(t2, 'three');
    expect((await again.next()).done).toBe(false);
    await s.interrupt(t2);
    for await (const e of again) void e;
    await s.close();
  });

  test('re-review MINOR: a turn the consumer walks away from is interrupted and settled before the next turn; its late answer never reaches the next turn', async () => {
    const late = path.join(root, 'profile-late');
    fs.mkdirSync(late, { mode: 0o700 });
    fs.writeFileSync(path.join(late, 'late'), '');
    const run = newRun();
    const s = await startCodexServer({ launcher: directLauncherForTests, decision: decision(), cmd: FAKE, run, profileDir: late, parentEnv: { PATH: process.env.PATH! } });
    const t = await s.startThread();
    for await (const e of s.runTurn(t, 'one')) { void e; break; } // walks away after the first event
    const events = [];
    for await (const e of s.runTurn(t, 'two')) events.push(e);
    await s.close();
    expect(seen(run).client).toContain('turn/interrupt');
    const text = JSON.stringify(events);
    expect(text).toContain('Echo: two');
    expect(text).not.toContain('Echo: one');
    expect(events.at(-1)).toMatchObject({ kind: 'turn_completed' });
  });

  test('re-review MINOR: a turn that will not stop leaves the server refusing further turns', async () => {
    const p = path.join(root, 'profile-ignore');
    fs.mkdirSync(p, { mode: 0o700 });
    fs.writeFileSync(path.join(p, 'slow'), '');
    fs.writeFileSync(path.join(p, 'ignore-interrupt'), '');
    const s = await startCodexServer({ launcher: directLauncherForTests, decision: decision(), cmd: FAKE, run: newRun(), profileDir: p, parentEnv: { PATH: process.env.PATH! }, settleMs: 200 });
    const t = await s.startThread();
    for await (const e of s.runTurn(t, 'one')) { void e; break; }
    await expect(s.runTurn(t, 'two').next()).rejects.toThrow(/did not stop/);
    await s.close();
  });

  test('review minor: a turn that never finishes is interrupted after the turn timeout and ends with an error', async () => {
    const slow = path.join(root, 'profile-slow3');
    fs.mkdirSync(slow, { mode: 0o700 });
    fs.writeFileSync(path.join(slow, 'slow'), '');
    const run = newRun();
    const s = await startCodexServer({ launcher: directLauncherForTests, decision: decision(), cmd: FAKE, run, profileDir: slow, parentEnv: { PATH: process.env.PATH! }, turnTimeoutMs: 300 });
    const events = [];
    for await (const e of s.runTurn(await s.startThread(), 'x')) events.push(e);
    await s.close();
    expect(events.at(-1)).toMatchObject({ kind: 'error', data: { message: expect.stringMatching(/did not finish within 300 ms/) } });
    expect(seen(run).client).toContain('turn/interrupt');
  });

  test('review minor: the server stopping in the middle of a turn ends it with an error, not a silent end', async () => {
    const dies = path.join(root, 'profile-die');
    fs.mkdirSync(dies, { mode: 0o700 });
    fs.writeFileSync(path.join(dies, 'die'), '');
    const { s } = await server(newRun(), dies);
    const events = [];
    for await (const e of s.runTurn(await s.startThread(), 'x')) events.push(e);
    await s.close();
    expect(events.at(-1)).toMatchObject({ kind: 'error', data: { message: expect.stringMatching(/stopped during the turn/) } });
    expect(events.every((e) => validateProviderEvent(e).ok)).toBe(true);
  });

  test('review minor: close() ends a server that ignores SIGTERM (SIGKILL after a grace period)', async () => {
    const stubborn = path.join(root, 'profile-stubborn');
    fs.mkdirSync(stubborn, { mode: 0o700 });
    fs.writeFileSync(path.join(stubborn, 'stubborn'), '');
    const { run, s } = await server(newRun(), stubborn);
    const t0 = Date.now();
    await s.close();
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(() => process.kill(seen(run).pid, 0)).toThrow(/ESRCH/);
  }, 15_000);

  test('review minor: a profile holding agent instructions or configuration is refused', async () => {
    for (const [name, body] of [['AGENTS.md', '# do things'], ['config.toml', '[mcp_servers.x]\ncommand = "x"\n']] as const) {
      const p = fs.mkdtempSync(path.join(root, 'profile-cfg-'));
      fs.chmodSync(p, 0o700);
      fs.writeFileSync(path.join(p, name), body);
      await expect(server(newRun(), p)).rejects.toThrow(new RegExp(`holds ${name.replace('.', '\\.')}|has a config\\.toml`));
    }
    const comments = fs.mkdtempSync(path.join(root, 'profile-cfg-'));
    fs.chmodSync(comments, 0o700);
    fs.writeFileSync(path.join(comments, 'config.toml'), '# written by codex login\n\n');
    const ok = await server(newRun(), comments);
    await ok.s.close();
    expect(buildCodexArgs()).toContain('mcp_servers={}');
  });

  test('PW-024 review nit: a refused or used-up decision runs nothing, not even --version', async () => {
    const marker = path.join(root, 'codex-spy-ran');
    const spy = path.join(root, 'codex-spy');
    fs.writeFileSync(spy, `#!/bin/sh\ntouch '${marker}'\necho "codex-cli 0.161.0"\n`, { mode: 0o755 });
    const one = decision({ approval: { approved: true, max_turns: 1, budget_usd: 1 } });
    const s = await startCodexServer({ launcher: directLauncherForTests, decision: one, cmd: FAKE, run: newRun(), profileDir: profile, parentEnv: { PATH: process.env.PATH! } });
    for await (const e of s.runTurn(await s.startThread(), 'x')) void e;
    await s.close();
    for (const d of [decision({ sandbox: null }), { ...decision() }, one]) {
      await expect(startCodexServer({ launcher: directLauncherForTests, decision: d as never, cmd: spy, run: newRun(), profileDir: profile, parentEnv: { PATH: process.env.PATH! } })).rejects.toThrow(/refused|not issued|outer filesystem sandbox/);
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('each turn spends one approved turn', async () => {
    const d = decision({ approval: { approved: true, max_turns: 1, budget_usd: 1 } });
    const s = await startCodexServer({ launcher: directLauncherForTests, decision: d, cmd: FAKE, run: newRun(), profileDir: profile, parentEnv: { PATH: process.env.PATH! } });
    const t = await s.startThread();
    for await (const e of s.runTurn(t, 'one')) void e;
    await expect((async () => { for await (const e of s.runTurn(t, 'two')) void e; })()).rejects.toThrow(/used up/);
    await s.close();
  });
});

describe('admission: Codex needs a verified outer sandbox on top of everything Claude needs', () => {
  test('the shipped registry (requires_verification) refuses paper work', () => {
    expect(decision({}, loadRegistry()).reason).toMatch(/admission is requires_verification/);
  });
  test.each([
    ['no outer sandbox', { sandbox: null }, /outer filesystem sandbox/],
    ['unverified sandbox', { sandbox: sandbox({ verified: false }) }, /outer filesystem sandbox/],
    ['sandbox from another host', { sandbox: sandbox({ host: 'elsewhere' }) }, /outer filesystem sandbox/],
    ['no approval', { approval: { ...approval, approved: false } }, /not approved/],
    ['no budget', { approval: { approved: true, max_turns: 0, budget_usd: 0 } }, /budget/],
    ['sentinel leak', { sentinel: sentinel({ status: 'leak' }) }, /sentinel is leak/],
    ['stale sentinel', { sentinel: sentinel({ checked_at: new Date(now - 25 * 3600e3).toISOString() }) }, /stale/],
  ])('%s → refused', (_n, over, why) => {
    const d = decision(over);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(why);
  });
  test('a refused or forged decision cannot start the server', async () => {
    await expect(startCodexServer({ launcher: directLauncherForTests, decision: decision({ sandbox: null }), cmd: FAKE, run: newRun(), profileDir: profile })).rejects.toThrow(/outer filesystem sandbox/);
    await expect(startCodexServer({ launcher: directLauncherForTests, decision: { ...decision() }, cmd: FAKE, run: newRun(), profileDir: profile })).rejects.toThrow(/not issued/);
  });
});
