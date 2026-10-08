// Runs the auth isolation sentinel against the real CLIs on this host. No model call:
// Claude → `claude auth status --json`, Codex → app-server `initialize` + `account/read`.
// Run it as yourself (no sudo) before admitting a provider on a host, and again after CLI upgrades.
// Usage: node spikes/isolation/tools/auth-sentinel.mjs [runsRoot] [claudeBin] [codexBin]
//   runsRoot defaults to $XDG_RUNTIME_DIR/paper-workspace/runs or a private tmp folder.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareRun, checkAuthIsolation, defaultRunsRoot } from '../runner.mjs';

const [runsRootArg, claudeBin = 'claude', codexBin = 'codex'] = process.argv.slice(2);
const location = runsRootArg ? { kind: 'argument', runsRoot: path.resolve(runsRootArg) } : defaultRunsRoot();
const out = { host: process.env.PW_HOST_LABEL || null, runs_root: location, checked_at: new Date().toISOString() };
for (const [provider, cmd] of [['claude_agent', claudeBin], ['codex', codexBin]]) {
  const run = prepareRun({ runsRoot: location.runsRoot, runId: randomUUID(), inputs: [] });
  out[provider] = await checkAuthIsolation({ provider, cmd, run });
}
console.log(JSON.stringify(out, null, 1));
