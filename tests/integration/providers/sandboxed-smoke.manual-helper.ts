// RFC-010: what the manual live smokes share — the real CLI runs inside the sandbox exactly as the
// worker runs it (sandboxedLauncher, the run's egress proxy with the provider's hosts only, the profile
// as the only other writable folder). MANUAL ONLY (imported by *.manual.ts; never part of `pnpm test`).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultRunsRoot, prepareRun, removeRun, type Run } from '../../../apps/worker/src/runner/index.ts';
import { sandboxedLauncher, type SandboxedLauncher } from '../../../apps/worker/src/provider-runs/sandboxed-launcher.ts';
import { PROVIDER_EGRESS } from '../../../apps/worker/src/provider-runs/index.ts';
import { startEgressProxy } from '../../../infra/sandbox/egress-proxy.ts';
import type { Backend } from '../../../infra/sandbox/sandbox.ts';

export const smokeBackend = (): Backend => (spawnSync('bwrap', ['--version']).status === 0 ? 'bwrap' : 'unshare');

// cliRoot: the CLI's install folder (default: the folder of the resolved binary)
export async function withSandboxedRun<T>(a: { provider: 'claude_agent' | 'codex'; cli: string; cliRoot?: string; profile: string; backend: Backend },
  fn: (x: { run: Run & { gatewayDir: string }; launcher: SandboxedLauncher; parentEnv: Record<string, string> }) => Promise<T>): Promise<{ value: T; egress: { target: string; allowed: boolean }[] }> {
  const run = prepareRun({ runsRoot: defaultRunsRoot(), runId: crypto.randomUUID() });
  const gatewayDir = path.join(run.dir, 'gateway');
  fs.mkdirSync(gatewayDir, { mode: 0o700 });
  const egress = await startEgressProxy({ socketPath: path.join(run.dir, 'egress.sock'), allow: PROVIDER_EGRESS[a.provider] });
  try {
    const launcher = sandboxedLauncher({
      backend: a.backend, run: { ...run, gatewayDir }, egressSocket: egress.socketPath, nodePath: process.execPath,
      readOnly: [a.cliRoot ?? path.dirname(fs.realpathSync(a.cli))], writable: [a.profile],
    });
    const value = await fn({ run: { ...run, gatewayDir }, launcher, parentEnv: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` } });
    return { value, egress: egress.log.map((l) => ({ target: l.target, allowed: l.allowed })) };
  } finally {
    await egress.close();
    removeRun(run);
  }
}
