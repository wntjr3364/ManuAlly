// Records provider CLI versions with `--version` only (scrubbed HOME, no prompt, no model call).
// Usage: node spikes/provider-admission/tools/probe-cli-versions.mjs [claudeBin] [codexBin]
import { probeCliVersion } from '../admission.mjs';

const [claudeBin = 'claude', codexBin = 'codex'] = process.argv.slice(2);
console.log(JSON.stringify({
  probed_at: new Date().toISOString(),
  note: '--version only; no prompt, scrubbed HOME',
  claude: probeCliVersion(claudeBin),
  codex: probeCliVersion(codexBin),
}, null, 1));
