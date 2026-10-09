// One Claude turn (PW-024): starts the CLI with an issued decision, the run's folders, the locked-down
// argv and environment, writes the prompt to stdin, and streams normalized provider events. The session
// id we chose (or resumed) stays authoritative: a different id reported by the CLI is flagged, not
// adopted. Cancel signals only the run's own process group (fuller reconciliation: PW-028).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import type { ProviderEvent } from '../../../contracts/src/provider/index.ts';
import { normalizeClaude } from '../core/events.ts';
import { Refused, assertSafeClaudeArgs, buildClaudeArgs, type EFFORTS, type SessionChoice } from './args.ts';
import { assertNoAgentConfigAbove, buildClaudeEnv, type ClaudeRun } from './env.ts';
import { isIssuedDecision, type ClaudeDecision } from './admission.ts';

export interface ClaudeTurnResult { exitCode: number | null; signal: string | null; nativeSessionId: string; reportedSessionId: string | null; sessionMismatch: boolean; authFailed: boolean; stderrTail: string }
export interface ClaudeTurn {
  events: AsyncIterable<ProviderEvent>;
  done: Promise<ClaudeTurnResult>;
  cancel(opts?: { graceMs?: number }): Promise<{ signals: string[]; exited: boolean }>;
}

const MAX_PROMPT = 200_000;

export function startClaudeTurn(a: {
  decision: ClaudeDecision; cmd: string; cmdPrefix?: string[]; run: ClaudeRun; profileDir: string; prompt: string; session: SessionChoice;
  effort?: (typeof EFFORTS)[number] | null; model?: string | null; parentEnv?: Record<string, string | undefined>; homes?: string[]; ownerUid?: number | null;
}): ClaudeTurn {
  if (!isIssuedDecision(a.decision)) throw new Refused('decision was not issued by decideClaudeCall');
  if (!a.decision.allowed) throw new Refused(a.decision.reason);
  if (typeof a.prompt !== 'string' || !a.prompt.trim() || a.prompt.length > MAX_PROMPT) throw new Refused('the prompt must be non-empty text');
  for (const p of a.cmdPrefix ?? []) {
    if (typeof p !== 'string' || p.startsWith('-') || !path.isAbsolute(p) || !fs.statSync(p, { throwIfNoEntry: false })?.isFile()) throw new Refused(`cmdPrefix entry ${JSON.stringify(p)} must be an absolute path to a file`);
  }
  for (const d of [a.run.dir, a.run.cwd, a.run.homeDir, a.run.tmpDir]) if (!path.isAbsolute(d) || !fs.statSync(d, { throwIfNoEntry: false })?.isDirectory()) throw new Refused(`run folder ${d} is missing`);
  assertNoAgentConfigAbove(a.run.cwd);
  const args = buildClaudeArgs({ session: a.session, mcpConfigPath: a.run.mcpConfigPath, effort: a.effort, model: a.model });
  assertSafeClaudeArgs(args, { runDir: a.run.dir });
  const env = buildClaudeEnv({ profileDir: a.profileDir, run: a.run, parentEnv: a.parentEnv, homes: a.homes, ownerUid: a.ownerUid });
  const expected = 'new' in a.session ? a.session.new : a.session.resume;

  const child = spawn(a.cmd, [...(a.cmdPrefix ?? []), ...args], { env, cwd: a.run.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let leaderExited = false;
  let stderr = '';
  child.stderr?.on('data', (d) => { stderr = (stderr + String(d)).slice(-2000); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('error', () => resolve({ code: null, signal: null }));
    child.on('exit', (code, signal) => { leaderExited = true; resolve({ code, signal }); });
  });
  child.stdin?.on('error', () => {}); // the CLI may exit before reading everything
  child.stdin?.end(a.prompt);

  let reported: string | null = null;
  let authFailed = false;
  const events = (async function* () {
    if (!child.stdout) return;
    const rl = readline.createInterface({ input: child.stdout });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { yield* normalizeClaude({ type: 'unparsed' }); continue; }
      const o = raw as { type?: string; subtype?: string; session_id?: unknown; is_error?: boolean; result?: unknown };
      if (o.type === 'system' && o.subtype === 'init' && typeof o.session_id === 'string') reported = o.session_id;
      if (o.type === 'result' && o.is_error && typeof o.result === 'string' && /not logged in|\/login|invalid api key|authentication/i.test(o.result)) authFailed = true;
      yield* normalizeClaude(raw);
    }
  })();

  const done = exited.then(({ code, signal }) => ({
    exitCode: code, signal, nativeSessionId: expected, reportedSessionId: reported,
    sessionMismatch: reported !== null && reported !== expected, authFailed, stderrTail: stderr,
  }));

  const cancel = async ({ graceMs = 5000 } = {}) => {
    const signals: string[] = [];
    const wait = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
      if (leaderExited || !child.pid) break;
      try { process.kill(-child.pid, sig); } catch { break; }
      signals.push(sig);
      if (await wait(graceMs)) break;
    }
    return { signals, exited: leaderExited || (await wait(graceMs)) };
  };
  return { events, done, cancel };
}
