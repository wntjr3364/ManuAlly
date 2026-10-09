// How an adapter starts its CLI (RFC-010). The worker hands the adapter a launcher that runs the CLI
// inside the verified sandbox (apps/worker/src/provider-runs); the adapter never spawns on its own.
// An adapter refuses a launcher that does not say it is sandboxed, except the one launcher below,
// which starts on the host and exists only for the adapters' own tests (a source check keeps it out of
// shipped code). For Codex the launcher's sandbox kind must be the one the admission verified.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { RunDecision } from './admission.ts';

export interface Launcher {
  readonly sandboxed: boolean;
  readonly kind: 'bubblewrap' | 'userns' | null;
  // runs `cmd args` to completion (the `--version` check), inside the same sandbox as the run
  version(cmd: string, args: string[], o: { env: Record<string, string>; cwd: string; timeoutMs: number }): { status: number | null; stdout: string };
  // starts the run's process in its own process group, stdio piped
  spawn(cmd: string, args: string[], o: { env: Record<string, string>; cwd: string }): ChildProcess;
}

const direct: Launcher = {
  sandboxed: false,
  kind: null,
  version(cmd: string, args: string[], o: { env: Record<string, string>; cwd: string; timeoutMs: number }) {
    const r = spawnSync(cmd, args, { env: o.env, cwd: o.cwd, encoding: 'utf8', timeout: o.timeoutMs });
    return { status: r.status, stdout: r.stdout ?? '' };
  },
  spawn(cmd: string, args: string[], o: { env: Record<string, string>; cwd: string }) {
    return spawn(cmd, args, { env: o.env, cwd: o.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  },
};
export const directLauncherForTests: Launcher = Object.freeze(direct);

export class NotSandboxed extends Error {}

export function assertLauncher(l: unknown, d: RunDecision): Launcher {
  if (l === directLauncherForTests) return directLauncherForTests;
  const x = l as Launcher | null | undefined;
  if (!x || x.sandboxed !== true || typeof x.spawn !== 'function' || typeof x.version !== 'function') throw new NotSandboxed('refused: a provider CLI runs only inside the sandbox (RFC-010)');
  if (d.key.provider === 'codex' && x.kind !== d.sandbox_kind) throw new NotSandboxed(`refused: the run would start in a ${String(x.kind)} sandbox, but the admission verified ${String(d.sandbox_kind)}`);
  return x;
}
