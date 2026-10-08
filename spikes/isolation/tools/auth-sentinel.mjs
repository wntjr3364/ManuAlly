// Runs the auth isolation sentinel against the real CLIs on this host. No model call:
// Claude → `claude auth status --json`, Codex → app-server `initialize` + `account/read`.
// Run it as the runtime OS user before admitting a provider on a host (RFC-004).
// Usage: node spikes/isolation/tools/auth-sentinel.mjs <runsRoot> [claudeBin] [codexBin]
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareRun, checkAuthIsolation } from '../runner.mjs';

const [runsRoot, claudeBin = 'claude', codexBin = 'codex'] = process.argv.slice(2);
if (!runsRoot) throw new Error('usage: auth-sentinel.mjs <absolute runsRoot> [claudeBin] [codexBin]');
const out = { host: process.env.PW_HOST_LABEL || null, checked_at: new Date().toISOString() };
for (const [provider, cmd] of [['claude_agent', claudeBin], ['codex', codexBin]]) {
  const run = prepareRun({ runsRoot: path.resolve(runsRoot), runId: randomUUID(), inputs: [] });
  out[provider] = await checkAuthIsolation({ provider, cmd, run });
}
console.log(JSON.stringify(out, null, 1));
