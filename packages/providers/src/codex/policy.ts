// Codex app-server RPC policy (PW-025; P00 PW-002, pinned to Codex CLI 0.161.0, generated schema
// inventory). Only allowlisted client requests are ever sent; server requests are answered by policy:
// approvals and credential/attestation requests are declined, a tool call goes to the paper tool
// gateway, anything else gets a JSON-RPC "method not found" error.
import policy from './rpc-policy.json' with { type: 'json' };
import { Refused } from '../claude/args.ts';

export const PINNED_CODEX_VERSION: string = policy.pinned_codex_cli_version;
const ALLOWED = new Set<string>(policy.client_request_allowlist);
const NOTIFICATIONS = new Set<string>(policy.client_notification_allowlist);
const HANDLING = policy.server_request_handling as Record<string, 'decline' | 'route_to_tool_gateway'>;
export const THREAD_DEFAULTS = policy.thread_defaults as { sandbox: string; approvalPolicy: string; ephemeral: boolean };
export const DISABLED_FEATURES: readonly string[] = policy.feature_flags.disabled;

export function guardClientRequest(method: string): string {
  if (!ALLOWED.has(method)) throw new Refused(`codex method ${method} is not allowlisted`);
  return method;
}
export function guardClientNotification(method: string): string {
  if (!NOTIFICATIONS.has(method)) throw new Refused(`codex notification ${method} is not allowlisted`);
  return method;
}

export type ServerAnswer = { result: unknown } | { error: { code: number; message: string } } | { route: 'tool_gateway' };
// v2 approval requests take `decline`; the older applyPatchApproval/execCommandApproval take `denied`
// (ReviewDecision). Credential refresh, attestation, user input and elicitation get a JSON-RPC error
// rather than a guessed "no". These shapes are from the generated 0.161.0 schema, not verified live.
const LEGACY_APPROVALS = new Set(['applyPatchApproval', 'execCommandApproval']);
const V2_APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']);
export function serverRequestAnswer(method: string): ServerAnswer {
  const h = Object.hasOwn(HANDLING, method) ? HANDLING[method] : undefined;
  if (h === 'decline' && V2_APPROVALS.has(method)) return { result: { decision: 'decline' } };
  if (h === 'decline' && LEGACY_APPROVALS.has(method)) return { result: { decision: 'denied' } };
  if (h === 'decline') return { error: { code: -32000, message: `${method} is declined by this client` } };
  if (h === 'route_to_tool_gateway') return { route: 'tool_gateway' };
  return { error: { code: -32601, message: `${method} is not supported by this client` } };
}
