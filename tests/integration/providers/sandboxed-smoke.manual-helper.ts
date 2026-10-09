// RFC-010: what the manual live smokes share — the real CLI runs inside the sandbox exactly as the
// worker runs it (sandboxedLauncher, the run's egress proxy with the provider's hosts only, a CLI state
// folder of its own with only the login credential bound in from the profile — RFC-010 review). MANUAL ONLY (imported by *.manual.ts; never part of `pnpm test`).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultRunsRoot, prepareRun, removeRun, type Run } from '../../../apps/worker/src/runner/index.ts';
import { sandboxedLauncher, type SandboxedLauncher } from '../../../apps/worker/src/provider-runs/sandboxed-launcher.ts';
import { PROVIDER_EGRESS, prepareStateDir } from '../../../apps/worker/src/provider-runs/index.ts';
import { startEgressProxy } from '../../../infra/sandbox/egress-proxy.ts';
import type { Backend } from '../../../infra/sandbox/sandbox.ts';

const SMOKE_PAPER = '00000000-0000-4000-8000-00000000510e';
export const smokeBackend = (): Backend => (spawnSync('bwrap', ['--version']).status === 0 ? 'bwrap' : 'unshare');

// cliRoot: the CLI's install folder (default: the folder of the resolved binary)
export async function withSandboxedRun<T>(a: { provider: 'claude_agent' | 'codex'; cli: string; cliRoot?: string; profile: string; backend: Backend },
  fn: (x: { run: Run & { gatewayDir: string }; launcher: SandboxedLauncher; parentEnv: Record<string, string>; stateDir: string }) => Promise<T>): Promise<{ value: T; egress: { target: string; allowed: boolean }[] }> {
  const runsRoot = defaultRunsRoot();
  const run = prepareRun({ runsRoot, runId: crypto.randomUUID() });
  // the smoke's own CLI state (a fixed synthetic "paper", so a resume finds its session)
  const state = prepareStateDir(path.join(path.dirname(runsRoot), 'smoke-state'), a.provider, SMOKE_PAPER, a.profile);
  const gatewayDir = path.join(run.dir, 'gateway');
  fs.mkdirSync(gatewayDir, { mode: 0o700 });
  const egress = await startEgressProxy({ socketPath: path.join(gatewayDir, 'egress.sock'), allow: PROVIDER_EGRESS[a.provider] });
  try {
    const launcher = sandboxedLauncher({
      backend: a.backend, run: { ...run, gatewayDir }, egressSocket: egress.socketPath, nodePath: process.execPath,
      readOnly: [a.cliRoot ?? path.dirname(fs.realpathSync(a.cli))], writable: [state.dir], fileBinds: state.binds,
    });
    const value = await fn({ run: { ...run, gatewayDir }, launcher, parentEnv: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` }, stateDir: state.dir });
    return { value, egress: egress.log.map((l) => ({ target: l.target, allowed: l.allowed })) };
  } finally {
    await egress.close();
    removeRun(run);
  }
}
