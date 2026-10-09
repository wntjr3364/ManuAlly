// `codex app-server` argv (PW-025; P00 PW-004): private stdio only (never a TCP/WebSocket port that
// another local process could reach), read-only sandbox, approvals on request (and then declined),
// shell/browser/computer-use features off. `unified_exec` cannot be disabled in 0.161.0, which is why
// Codex needs an outer filesystem sandbox before admission (RFC-004).
import { Refused } from '../claude/args.ts';
import { DISABLED_FEATURES } from './policy.ts';

export function buildCodexArgs(opts: { listen?: 'stdio://' } = {}): string[] {
  if (opts.listen !== undefined && opts.listen !== 'stdio://') throw new Refused(`app-server must use private stdio, not ${String(opts.listen)}`);
  return [
    'app-server', '--listen', 'stdio://',
    '-c', 'sandbox_mode="read-only"',
    '-c', 'approval_policy="on-request"',
    // no MCP servers from the profile's config (the paper tool gateway is added by PW-027)
    '-c', 'mcp_servers={}',
    ...DISABLED_FEATURES.flatMap((f) => ['-c', `features.${f}=false`]),
  ];
}
