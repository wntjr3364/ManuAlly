// One Claude turn (PW-024): starts the CLI with an issued decision (one turn of it), the run's private
// folders, the locked-down argv and environment, writes the prompt to stdin, and streams normalized
// provider events. The binary is an absolute path whose `--version` must match the admitted version.
// The session id we chose (or resumed) is authoritative: if the CLI reports another one the turn is
// stopped. Reported cost counts against the approved budget; reaching it stops the turn. Cancel signals
// only the run's own process group (fuller reconciliation: PW-028).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import type { ProviderEvent } from '../../../contracts/src/provider/index.ts';
import { normalizeClaude } from '../core/events.ts';
import { Refused, assertSafeClaudeArgs, buildClaudeArgs, type EFFORTS, type SessionChoice } from './args.ts';
import { assertNoAgentConfigAbove, buildClaudeEnv, type ClaudeRun } from './env.ts';
import { type ClaudeDecision } from './admission.ts';
import { addCost, spendTurn } from '../core/admission.ts';
import { assertPrivateRunFolder } from './run-folder.ts';

// the CLI version as `claude --version` prints it ("2.1.294 (Claude Code)"), in registry form
export function claudeCliVersion(cmd: string, env: Record<string, string>, cwd: string): string {
  const r = spawnSync(cmd, ['--version'], { env, cwd, encoding: 'utf8', timeout: 15_000 });
  const v = /^(\d+\.\d+\.\d+)\b/.exec((r.stdout ?? '').trim());
  if (r.status !== 0 || !v) throw new Refused(`could not read the version of ${cmd}`);
  return `claude-code ${v[1]}`;
}
function assertBinary(cmd: string): string {
  if (typeof cmd !== 'string' || !path.isAbsolute(cmd)) throw new Refused('the CLI must be given as an absolute path');
  const real = fs.realpathSync(cmd);
  const st = fs.statSync(real);
  if (!st.isFile() || !(st.mode & 0o111)) throw new Refused(`${cmd} is not an executable file`);
  if (st.mode & 0o022) throw new Refused(`${cmd} is writable by others`);
  return real;
}

// stopped: why the adapter ended the turn itself (session id mismatch, budget reached), else null
export interface ClaudeTurnResult { exitCode: number | null; signal: string | null; nativeSessionId: string; reportedSessionId: string | null; sessionMismatch: boolean; authFailed: boolean; stopped: string | null; stderrTail: string }
export interface ClaudeTurn {
  events: AsyncIterable<ProviderEvent>;
  done: Promise<ClaudeTurnResult>;
  cancel(opts?: { graceMs?: number }): Promise<{ signals: string[]; exited: boolean }>;
}

const MAX_PROMPT = 200_000;

export function startClaudeTurn(a: {
  decision: ClaudeDecision; cmd: string; run: ClaudeRun; profileDir: string; prompt: string; session: SessionChoice;
  effort?: (typeof EFFORTS)[number] | null; model?: string | null; parentEnv?: Record<string, string | undefined>; homes?: string[]; ownerUid?: number | null;
}): ClaudeTurn {
  if (typeof a.prompt !== 'string' || !a.prompt.trim() || a.prompt.length > MAX_PROMPT) throw new Refused('the prompt must be non-empty text');
  assertPrivateRunFolder(a.run, a.ownerUid === undefined ? (process.getuid?.() ?? null) : a.ownerUid);
  assertNoAgentConfigAbove(a.run.cwd);
  const args = buildClaudeArgs({ session: a.session, mcpConfigPath: a.run.mcpConfigPath, effort: a.effort, model: a.model });
  assertSafeClaudeArgs(args, { runDir: a.run.dir });
  const env = buildClaudeEnv({ profileDir: a.profileDir, run: a.run, parentEnv: a.parentEnv, homes: a.homes, ownerUid: a.ownerUid });
  const cmd = assertBinary(a.cmd);
  const version = claudeCliVersion(cmd, env, a.run.cwd);
  if (version !== a.decision?.key?.version) throw new Refused(`${a.cmd} is ${version}, but the admission is for ${String(a.decision?.key?.version)}`);
  const decision = spendTurn(a.decision, 'claude_agent'); // last: an invalid call never spends a turn
  const expected = 'new' in a.session ? a.session.new : a.session.resume;

  const child = spawn(cmd, args, { env, cwd: a.run.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
  let stopped: string | null = null;
  const events = (async function* () {
    if (!child.stdout) return;
    const rl = readline.createInterface({ input: child.stdout });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { yield* normalizeClaude({ type: 'unparsed' }); continue; }
      const o = raw as { type?: string; subtype?: string; session_id?: unknown; is_error?: boolean; result?: unknown };
      if (o.type === 'system' && o.subtype === 'init' && typeof o.session_id === 'string') {
        reported = o.session_id;
        if (reported !== expected) {
          // never continue in a session we did not choose: stop before it uses quota or gets stored
          stopped = 'session id mismatch';
          void cancel({ graceMs: 2000 });
          yield { schema_version: 1, provider: 'claude_agent', kind: 'error', data: { kind: 'provider', message: 'the CLI reported a different session id; the turn was stopped' } } as ProviderEvent;
          rl.close();
          return;
        }
      }
      if (o.type === 'result' && o.is_error && typeof o.result === 'string' && /not logged in|\/login|invalid api key|authentication/i.test(o.result)) authFailed = true;
      for (const e of normalizeClaude(raw)) {
        yield e;
        if (e.kind === 'usage' && e.data.scope === 'turn' && e.data.cost_usd_estimate !== null && addCost(decision, e.data.cost_usd_estimate) && !stopped) {
          stopped = 'budget reached';
          void cancel({ graceMs: 2000 }); // the approved budget is spent
        }
      }
    }
  })();

  const done = exited.then(({ code, signal }) => ({
    exitCode: code, signal, nativeSessionId: expected, reportedSessionId: reported,
    sessionMismatch: reported !== null && reported !== expected, authFailed, stopped, stderrTail: stderr,
  }));

  async function cancel({ graceMs = 5000 } = {}) {
    const signals: string[] = [];
    const wait = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
      if (leaderExited || !child.pid) break;
      try { process.kill(-child.pid, sig); } catch { break; }
      signals.push(sig);
      if (await wait(graceMs)) break;
    }
    return { signals, exited: leaderExited || (await wait(graceMs)) };
  }
  return { events, done, cancel };
}
