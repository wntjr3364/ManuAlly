// The launcher the worker gives an adapter (RFC-010): the CLI runs inside the Linux sandbox (PW-026)
// with the run's folder, the read-only folders it needs (CLI install, Node, the gateway folder), the
// isolated auth profile as its only other writable folder, and network only through the run's egress
// proxy. The `--version` check runs in the same sandbox without network. The started process carries
// the run's marker in its own environment (the sandbox clears the CLI's), so the supervisor can
// recognise and end it; ending it ends the sandbox's PID namespace and everything inside.
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { Launcher } from '@pw/providers/core/launch.ts';
import { prepareSandboxCommand, type Backend, type Limits, type SandboxRun } from '../../../../infra/sandbox/sandbox.ts';
import { MARKER_ENV, identifyRunProcess, newRunMarker } from '../lifecycle/index.ts';

export interface StartedRunProcess { child: ChildProcess; pid: number; ticks: number; marker: string }
export interface SandboxedLauncher extends Launcher { started(): StartedRunProcess | null }

export function sandboxedLauncher(a: {
  backend: Backend; run: SandboxRun; egressSocket: string; nodePath: string; readOnly: string[]; writable: string[]; limits?: Limits;
}): SandboxedLauncher {
  if (!path.isAbsolute(a.nodePath)) throw new Error('refused: the node binary must be an absolute path');
  // the Node install the forwarder (and a Node-based CLI) needs, read-only
  const readOnly = [...new Set([...a.readOnly, path.dirname(path.dirname(a.nodePath))])];
  const spec = (env: Record<string, string>, cwd: string, program: string[]) => {
    if (path.resolve(cwd) !== path.resolve(a.run.cwd)) throw new Error('refused: a sandboxed CLI runs in its run\'s work folder');
    return { backend: a.backend, run: a.run, readOnly, writable: a.writable, env, limits: a.limits, program };
  };
  let started: StartedRunProcess | null = null;
  return Object.freeze({
    sandboxed: true as const,
    kind: a.backend === 'bwrap' ? ('bubblewrap' as const) : ('userns' as const),
    version(cmd: string, args: string[], o: { env: Record<string, string>; cwd: string; timeoutMs: number }) {
      const c = prepareSandboxCommand({ ...spec(o.env, o.cwd, [cmd, ...args]), network: 'none' });
      try {
        const r = spawnSync(c.cmd, c.args, { env: c.env, cwd: c.cwd, encoding: 'utf8', timeout: o.timeoutMs, killSignal: 'SIGKILL' });
        return { status: r.status, stdout: r.stdout ?? '' };
      } finally {
        c.cleanup();
      }
    },
    spawn(cmd: string, args: string[], o: { env: Record<string, string>; cwd: string }) {
      if (started) throw new Error('refused: one run process per launcher');
      const c = prepareSandboxCommand({ ...spec(o.env, o.cwd, [cmd, ...args]), network: 'proxy', proxy: { socket: a.egressSocket, node: a.nodePath } });
      const marker = newRunMarker();
      let child: ChildProcess;
      try {
        child = spawn(c.cmd, c.args, { env: { ...c.env, [MARKER_ENV]: marker }, cwd: c.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        c.cleanup();
        throw e;
      }
      child.once('close', () => c.cleanup());
      const id = identifyRunProcess(child, marker);
      started = { child, ...id };
      return child;
    },
    started: () => started,
  });
}
