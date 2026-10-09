// A private `codex app-server` over stdio JSON-RPC (PW-025). Only typed calls exist: startThread,
// resumeThread (a stored id), runTurn, interrupt, close — plus `request`, which still passes the method
// allowlist. Server requests are answered by policy; notifications are normalized (provider_event v1).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { ProviderEvent } from '../../../contracts/src/provider/index.ts';
import { normalizeCodex } from '../core/events.ts';
import { Refused } from '../claude/args.ts';
import { assertNoAgentConfigAbove, assertSafeProfileDir } from '../claude/env.ts';
import { buildCodexArgs } from './args.ts';
import { PINNED_CODEX_VERSION, THREAD_DEFAULTS, guardClientNotification, guardClientRequest, serverRequestAnswer } from './policy.ts';
import { type CodexDecision } from './admission.ts';
import { checkDecision, spendTurn } from '../core/admission.ts';
import { assertPrivateRunFolder } from '../claude/run-folder.ts';
import { assertLauncher, type Launcher } from '../core/launch.ts';

// `codex --version` → "codex-cli 0.161.0" (registry form)
// (run by the launcher: inside the same sandbox as the server)
export function codexCliVersion(launcher: Launcher, cmd: string, env: Record<string, string>, cwd: string): string {
  const r = launcher.version(cmd, ['--version'], { env, cwd, timeoutMs: 15_000 });
  const v = /(\d+\.\d+\.\d+)/.exec((r.stdout ?? '').trim());
  if (r.status !== 0 || !v) throw new Refused(`could not read the version of ${cmd}`);
  return `codex-cli ${v[1]}`;
}

export interface CodexRun { dir: string; cwd: string; homeDir: string; tmpDir: string }
type Msg = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

// Codex reads instructions (AGENTS.md) and configuration (config.toml: MCP servers, profiles) from
// CODEX_HOME. The runtime profile holds only the login: anything else is refused.
function assertBareCodexProfile(profile: string): void {
  for (const n of ['AGENTS.md', 'AGENTS.override.md']) if (fs.existsSync(path.join(profile, n))) throw new Refused(`the Codex profile ${profile} holds ${n}; it may hold only the login`);
  const cfg = path.join(profile, 'config.toml');
  if (fs.existsSync(cfg) && fs.readFileSync(cfg, 'utf8').split('\n').some((l) => l.trim() && !l.trim().startsWith('#'))) throw new Refused(`the Codex profile ${profile} has a config.toml; it may hold only the login`);
}

export function buildCodexEnv(a: { profileDir: string; run: CodexRun; parentEnv?: Record<string, string | undefined>; homes?: string[]; ownerUid?: number | null }): Record<string, string> {
  const profile = assertSafeProfileDir(a.profileDir, { homes: a.homes, ownerUid: a.ownerUid });
  assertBareCodexProfile(profile);
  return { PATH: (a.parentEnv ?? process.env).PATH || '/usr/local/bin:/usr/bin:/bin', HOME: a.run.homeDir, TMPDIR: a.run.tmpDir, LANG: 'C.UTF-8', TZ: 'UTC', CODEX_HOME: profile };
}

export async function startCodexServer(a: {
  decision: CodexDecision; cmd: string; run: CodexRun; profileDir: string;
  parentEnv?: Record<string, string | undefined>; homes?: string[]; ownerUid?: number | null;
  onToolCall?: (name: string, args: unknown) => Promise<unknown>; timeoutMs?: number; turnTimeoutMs?: number; settleMs?: number;
  // starts the app-server: inside the sandbox the admission verified (RFC-010)
  launcher: Launcher;
}) {
  const d = a.decision;
  // the decision must be issued, allowed, unexpired and for Codex (checked again for every turn)
  checkDecision(d, 'codex'); // before anything runs, even --version
  const launcher = assertLauncher(a.launcher, d);
  assertPrivateRunFolder(a.run, a.ownerUid === undefined ? (process.getuid?.() ?? null) : a.ownerUid);
  assertNoAgentConfigAbove(a.run.cwd);
  const env = buildCodexEnv(a);
  if (typeof a.cmd !== 'string' || !path.isAbsolute(a.cmd)) throw new Refused('the CLI must be given as an absolute path');
  const cmd = fs.realpathSync(a.cmd);
  const st = fs.statSync(cmd);
  if (!st.isFile() || !(st.mode & 0o111) || st.mode & 0o022) throw new Refused(`${a.cmd} is not an executable file the user controls`);
  const version = codexCliVersion(launcher, cmd, env, a.run.cwd);
  if (version !== d.key.version) throw new Refused(`${a.cmd} is ${version}, but the admission is for ${d.key.version}`);
  if (version !== `codex-cli ${PINNED_CODEX_VERSION}`) throw new Refused(`codex ${version} is not the pinned ${PINNED_CODEX_VERSION} (regenerate the schema inventory and RPC policy first)`);
  const timeoutMs = a.timeoutMs ?? 30_000;

  const child = launcher.spawn(cmd, buildCodexArgs(), { env, cwd: a.run.cwd });
  child.stderr?.resume();
  child.stdin?.on('error', () => {});
  let exited = false;
  const exit = new Promise<void>((r) => { child.on('exit', () => { exited = true; r(); }); child.on('error', () => { exited = true; r(); }); });
  const write = (m: Msg) => { if (!exited) child.stdin!.write(JSON.stringify(m) + '\n'); };

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let listener: ((e: ProviderEvent) => void) | null = null;
  const onServerRequest = async (m: Msg) => {
    const ans = serverRequestAnswer(m.method!);
    if ('route' in ans) {
      if (!a.onToolCall) return write({ id: m.id, error: { code: -32601, message: 'no tool gateway for this run' } });
      const p = (m.params ?? {}) as { tool?: unknown; arguments?: unknown };
      try {
        return write({ id: m.id, result: await a.onToolCall(String(p.tool ?? ''), p.arguments ?? null) });
      } catch (e) {
        return write({ id: m.id, error: { code: -32000, message: e instanceof Error ? e.message.slice(0, 500) : 'tool failed' } });
      }
    }
    return write({ id: m.id, ...ans });
  };
  const rl = readline.createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    let m: Msg;
    try { m = JSON.parse(line) as Msg; } catch { return; }
    if (m.method !== undefined && m.id !== undefined) { void onServerRequest(m); return; }
    if (m.method !== undefined) { for (const e of normalizeCodex(m)) listener?.(e); return; }
    if (typeof m.id === 'number' && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  void exit.then(() => { for (const p of pending.values()) p.reject(new Error('codex app-server exited')); pending.clear(); });

  const request = async (method: string, params: unknown): Promise<unknown> => {
    guardClientRequest(method);
    if (exited) return Promise.reject(new Error('codex app-server exited'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      write({ id, method, params });
    });
  };

  const waitExit = (ms: number) => Promise.race([exit.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
  const close = async () => {
    child.stdin?.end();
    for (const sig of [null, 'SIGTERM', 'SIGKILL'] as const) {
      if (sig && child.pid) { try { process.kill(-child.pid, sig); } catch { /* gone */ } }
      if (await waitExit(2000)) return;
    }
  };

  try {
    const init = (await request('initialize', { clientInfo: { name: 'paper-workspace', version: '0.0.0' } })) as { userAgent?: unknown };
    if (typeof init?.userAgent !== 'string' || !init.userAgent.includes(`/${PINNED_CODEX_VERSION}`)) throw new Refused(`codex app-server reports ${String(init?.userAgent)}, not the pinned ${PINNED_CODEX_VERSION}`);
    write({ method: guardClientNotification('initialized') });
  } catch (e) {
    await close();
    throw e;
  }

  const turns = new Map<string, string>(); // thread id -> open turn id
  let turnActive = false;
  let stuck = false; // a turn that would not stop: its late notifications could reach the next turn
  let alive = true;
  void exit.then(() => { alive = false; });
  const turnTimeoutMs = a.turnTimeoutMs ?? 10 * 60_000;
  const settleMs = a.settleMs ?? 5_000;
  // only typed calls: no raw RPC (an allowlisted method with free parameters could override the
  // sandbox, approval policy or working folder)
  return {
    async startThread(): Promise<string> {
      const r = (await request('thread/start', { cwd: a.run.cwd, sandbox: THREAD_DEFAULTS.sandbox, approvalPolicy: THREAD_DEFAULTS.approvalPolicy, ephemeral: THREAD_DEFAULTS.ephemeral })) as { thread?: { id?: unknown } };
      if (typeof r?.thread?.id !== 'string') throw new Error('thread/start returned no thread id');
      return r.thread.id;
    },
    // only a thread id this paper stored (agent_sessions) — never a "latest" thread
    async resumeThread(threadId: string): Promise<string> {
      if (typeof threadId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(threadId)) throw new Refused('resume needs a stored thread id');
      const r = (await request('thread/resume', { threadId })) as { thread?: { id?: unknown } };
      if (r?.thread?.id !== threadId) throw new Error('thread/resume returned another thread');
      return threadId;
    },
    // One turn at a time per server: notifications carry no reliable owner here, so a second turn
    // could receive the first one's answer.
    async *runTurn(threadId: string, text: string): AsyncGenerator<ProviderEvent> {
      if (turnActive) throw new Refused('a turn is already running on this Codex server');
      if (stuck) throw new Refused('an earlier turn on this Codex server did not stop; close it and start a new one');
      spendTurn(d, 'codex'); // one approved turn; refused when expired or used up (no cost is reported by Codex)
      turnActive = true;
      const queue: ProviderEvent[] = [];
      let wake: (() => void) | null = null;
      let ended = false;
      let timedOut = false;
      let completed = false;
      // the thread's own start notice belongs to startThread, not to this turn
      listener = (e) => { if (e.kind === 'session_started') return; queue.push(e); if (e.kind === 'turn_completed') { ended = true; completed = true; } wake?.(); };
      void exit.then(() => { ended = true; wake?.(); });
      const timer = setTimeout(() => { timedOut = true; ended = true; wake?.(); }, turnTimeoutMs);
      const err = (message: string) => ({ schema_version: 1, provider: 'codex', kind: 'error', data: { kind: 'provider', message } }) as ProviderEvent;
      try {
        const r = (await request('turn/start', { threadId, input: [{ type: 'text', text }] })) as { turn?: { id?: unknown } };
        if (typeof r?.turn?.id === 'string') turns.set(threadId, r.turn.id);
        for (;;) {
          while (queue.length) {
            const e = queue.shift()!;
            yield e;
            if (e.kind === 'turn_completed') return;
          }
          if (ended) {
            if (timedOut) {
              await request('turn/interrupt', { threadId, turnId: turns.get(threadId) ?? '' }).catch(() => {});
              yield err(`the turn did not finish within ${turnTimeoutMs} ms and was interrupted`);
            } else yield err('the Codex app-server stopped during the turn');
            return;
          }
          await new Promise<void>((res) => { wake = res; });
          wake = null;
        }
      } finally {
        clearTimeout(timer);
        // Left early (the consumer stopped, a timeout, a failed turn/start): the server may still be
        // running the turn. Interrupt it and wait, bounded, for its completion before the next turn
        // may start; if it never comes, this server takes no more turns.
        if (!completed && alive) {
          let done: () => void = () => {};
          const finished = new Promise<void>((r) => { done = r; });
          listener = (e) => { if (e.kind === 'turn_completed') { completed = true; done(); } };
          const turnId = turns.get(threadId);
          if (turnId) void request('turn/interrupt', { threadId, turnId }).catch(() => {});
          await Promise.race([finished, exit, new Promise((r) => setTimeout(r, settleMs))]);
          if (!completed && alive) stuck = true;
        }
        listener = null;
        turns.delete(threadId);
        turnActive = false;
      }
    },
    async interrupt(threadId: string) {
      const turnId = turns.get(threadId);
      if (!turnId) return;
      await request('turn/interrupt', { threadId, turnId });
    },
    close,
  };
}
export type CodexServer = Awaited<ReturnType<typeof startCodexServer>>;
