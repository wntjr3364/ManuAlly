// One real provider turn on the worker's run path (RFC-010). For a claimed job:
//   1. a fresh run folder, and inside it a host-made gateway folder that the sandbox sees read-only
//   2. a run token bound to the job and its fencing token (the token stays in the worker)
//   3. the tool gateway: Claude reaches it through the MCP bridge and a socket in the gateway folder;
//      Codex asks through its app-server, answered here with the same gateway
//   4. the run's egress proxy (only the allowlisted provider hosts)
//   5. the adapter, given a launcher that starts the CLI inside the sandbox; the started process is
//      recorded as the job's run process and supervised (cancel or a lost lease → interrupt → group end)
//   6. events: usage → the ledger, quota → quota observations
//   7. always: token revoked, socket and proxy closed, the run process ended, folders removed
// Nothing here applies anything: tool calls create proposals only (PW-017/027).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TxPool } from '@pw/domain/shared/db.ts';
import { callTool, issueRunToken, revokeRunToken } from '@pw/domain/tool-policy/index.ts';
import { recordQuota, recordUsage } from '@pw/domain/usage/index.ts';
import type { RunDecision } from '@pw/providers/core/index.ts';
import { startClaudeTurn, type SessionChoice, type ClaudeTurnResult } from '@pw/providers/claude/index.ts';
import { startCodexServer } from '@pw/providers/codex/index.ts';
import type { ProviderEvent } from '../../../../packages/contracts/src/provider/index.ts';
import type { Backend, Limits } from '../../../../infra/sandbox/sandbox.ts';
import { startEgressProxy, type EgressProxy, type EgressTarget } from '../../../../infra/sandbox/egress-proxy.ts';
import { prepareRun, removeRun } from '../runner/run-dirs.ts';
import { recordRunProcess, superviseRun, terminateRunGroup, type RunProcessRecord, type SuperviseResult } from '../lifecycle/index.ts';
import { sandboxedLauncher } from './sandboxed-launcher.ts';
import { serveToolSocket } from './tool-socket.ts';

// Hosts the CLIs need (API and login refresh), port 443 only. To be confirmed by the live smoke inside
// the sandbox; a host missing here makes the CLI fail to connect (the safe direction).
export const PROVIDER_EGRESS: Record<'claude_agent' | 'codex', EgressTarget[]> = {
  claude_agent: [{ host: 'api.anthropic.com', port: 443 }, { host: 'console.anthropic.com', port: 443 }],
  codex: [{ host: 'chatgpt.com', port: 443 }, { host: 'api.openai.com', port: 443 }, { host: 'auth.openai.com', port: 443 }],
};

export interface ProviderRunConfig {
  backend: Backend;
  runsRoot: string;
  nodePath: string; // absolute; its install folder is bound read-only
  readOnly: string[]; // the CLI's install folder(s)
  egressAllow: EgressTarget[];
  authProfileId: string; // names the login profile in quota observations
  limits?: Limits;
  tokenTtlMs?: number;
  pollMs?: number;
  interruptGraceMs?: number;
  killGraceMs?: number;
}

export interface ProviderTurnOutcome {
  events: ProviderEvent[];
  supervised: SuperviseResult;
  nativeSessionId: string | null;
  claude: ClaudeTurnResult | null;
  token: string; // revoked by now
}

export async function runProviderTurn(pool: TxPool, a: {
  job: { id: string; fencingToken: number; paperId: string; ownerId: string };
  workerId: string;
  provider: 'claude_agent' | 'codex';
  decision: RunDecision;
  cmd: string;
  profileDir: string;
  prompt: string;
  documentId: string | null;
  handleIds: string[];
  tools: string[];
  session?: SessionChoice; // Claude: the session id we chose, or a stored one to resume
  thread?: string; // Codex: a stored thread id to resume
  config: ProviderRunConfig;
  homes?: string[];
  onEvent?: (e: ProviderEvent) => void;
}): Promise<ProviderTurnOutcome> {
  const c = a.config;
  if (a.provider === 'claude_agent' && !a.session) throw new Error('refused: a Claude turn needs a chosen or stored session id');
  const run = prepareRun({ runsRoot: c.runsRoot, runId: randomUUID() });
  const gwDir = path.join(run.dir, 'gateway');
  let token: { id: string; token: string } | null = null;
  let socket: { close(): Promise<void> } | null = null;
  let egress: EgressProxy | null = null;
  let record: RunProcessRecord | null = null;
  let startedPid: number | null = null;
  let supervising: Promise<SuperviseResult> | null = null;
  const events: ProviderEvent[] = [];
  let n = 0;
  let nativeSessionId: string | null = null;
  const handle = async (e: ProviderEvent) => {
    events.push(e);
    a.onEvent?.(e);
    const key = `${a.job.id}:${a.job.fencingToken}:${n++}`;
    if (e.kind === 'usage') await recordUsage(pool, { paperId: a.job.paperId, jobId: a.job.id, provider: a.provider, nativeSessionId, eventKey: key, data: e.data });
    if (e.kind === 'quota') await recordQuota(pool, { provider: a.provider, authProfileId: c.authProfileId, bucket: 'reported', eventKey: key, data: e.data });
  };
  try {
    fs.mkdirSync(gwDir, { mode: 0o700 });
    token = await issueRunToken(pool, {
      ownerId: a.job.ownerId, paperId: a.job.paperId, documentId: a.documentId, handleIds: a.handleIds, provider: a.provider, tools: a.tools,
      ttlMs: c.tokenTtlMs ?? 30 * 60_000, jobId: a.job.id, fencingToken: a.job.fencingToken,
    });
    egress = await startEgressProxy({ socketPath: path.join(run.dir, 'egress.sock'), allow: c.egressAllow });
    const parentEnv = { PATH: `${path.dirname(c.nodePath)}:/usr/bin:/bin` };
    const launcher = sandboxedLauncher({ backend: c.backend, run: { ...run, gatewayDir: gwDir }, egressSocket: egress.socketPath, nodePath: c.nodePath, readOnly: c.readOnly, writable: [a.profileDir], limits: c.limits });
    const supervise = async (interrupt: () => Promise<void>) => {
      const st = launcher.started();
      if (!st) throw new Error('the CLI did not start');
      startedPid = st.pid;
      record = await recordRunProcess(pool, { jobId: a.job.id, fencingToken: a.job.fencingToken, workerId: a.workerId, pid: st.pid, ticks: st.ticks, marker: st.marker });
      supervising = superviseRun(pool, { jobId: a.job.id, fencingToken: a.job.fencingToken, record, child: st.child, interrupt, pollMs: c.pollMs, interruptGraceMs: c.interruptGraceMs, killGraceMs: c.killGraceMs });
    };

    let claude: ClaudeTurnResult | null = null;
    if (a.provider === 'claude_agent') {
      const sock = path.join(gwDir, 'gateway.sock');
      socket = await serveToolSocket({ pool, socketPath: sock, token: token.token });
      const bridge = path.join(gwDir, 'mcp-bridge.mjs');
      fs.copyFileSync(new URL('./mcp-bridge.mjs', import.meta.url), bridge);
      fs.chmodSync(bridge, 0o444);
      // in the read-only gateway folder: the CLI cannot add servers to it
      const mcpConfigPath = path.join(gwDir, 'mcp.json');
      fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { paper: { command: c.nodePath, args: [bridge, sock] } } }), { mode: 0o600 });
      const turn = startClaudeTurn({
        decision: a.decision, cmd: a.cmd, run: { dir: run.dir, cwd: run.cwd, homeDir: run.homeDir, tmpDir: run.tmpDir, mcpConfigPath },
        profileDir: a.profileDir, prompt: a.prompt, session: a.session!, parentEnv, homes: a.homes, launcher,
      });
      nativeSessionId = 'new' in a.session! ? a.session!.new : a.session!.resume;
      await supervise(async () => { await turn.cancel({ graceMs: c.interruptGraceMs ?? 5000 }); });
      for await (const e of turn.events) await handle(e);
      claude = await turn.done;
    } else {
      const server = await startCodexServer({
        decision: a.decision, cmd: a.cmd, run: { dir: run.dir, cwd: run.cwd, homeDir: run.homeDir, tmpDir: run.tmpDir }, profileDir: a.profileDir, parentEnv, homes: a.homes, launcher,
        // the model's tool call → the gateway with this run's token (the token never reaches the CLI)
        onToolCall: async (name, args) => {
          const out = await callTool(pool, token!.token, name, args);
          return { content: [{ type: 'text', text: JSON.stringify(out.ok ? out.result : out.error) }], isError: !out.ok };
        },
      });
      let thread: string | null = null;
      await supervise(async () => { if (thread) await server.interrupt(thread); });
      try {
        thread = a.thread ? await server.resumeThread(a.thread) : await server.startThread();
        nativeSessionId = thread;
        for await (const e of server.runTurn(thread, a.prompt)) await handle(e);
      } finally {
        await server.close();
      }
    }
    const supervised = await supervising!;
    return { events, supervised, nativeSessionId, claude, token: token.token };
  } finally {
    if (token) await revokeRunToken(pool, token.id).catch(() => {});
    // the run process never outlives its run (also when this turn failed half-way): whatever is left of
    // it is ended, and the supervisor settled, before the folders go
    const rec = record as RunProcessRecord | null;
    if (rec) await terminateRunGroup(pool, rec, { graceMs: c.killGraceMs ?? 2000, descendants: true }).catch(() => null);
    else if (startedPid) { try { process.kill(-startedPid, 'SIGKILL'); } catch { /* gone */ } }
    if (supervising) await (supervising as Promise<SuperviseResult>).catch(() => null);
    await socket?.close().catch(() => {});
    await egress?.close().catch(() => {});
    removeRun(run);
  }
}
