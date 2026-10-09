// Raw provider events → normalized provider events (PW-023, contract provider_event v1).
// Field paths follow the providers' documented formats (Claude Code `-p --output-format stream-json`;
// Codex app-server JSON-RPC notifications, generated schema of 0.161.0); only the Claude init →
// assistant → rate_limit_event → result order was observed live (P00). So:
//   * a value is taken only when present with the documented type and a sane range; otherwise null,
//     listed in unknown_fields or explained in unknown_reason — never 0 or an invented time
//   * a reset time is accepted only as an ISO 8601 string; another format is kept raw, unparsed
//   * an event type we do not know is `unrecognized` (kept, not interpreted)
import type { ProviderEvent, ProviderEventData, ProviderId, UsageField } from '../../../contracts/src/provider/index.ts';

type O = Record<string, unknown>;
const obj = (v: unknown): O | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as O) : null);
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const money = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const ev = <K extends keyof ProviderEventData>(provider: ProviderId, kind: K, data: ProviderEventData[K]) => ({ schema_version: 1 as const, provider, kind, data }) as ProviderEvent;
const unrecognized = (provider: ProviderId, raw: unknown) => ev(provider, 'unrecognized', { raw_type: str(obj(raw)?.type ?? obj(raw)?.method)?.slice(0, 200) ?? null });

// scope: what the counts cover — one message, one whole turn, or the session so far (summing usage
// events of different scopes double counts)
function usage(provider: ProviderId, scope: ProviderEventData['usage']['scope'], v: { input_tokens: unknown; output_tokens: unknown; cost_usd_estimate: unknown; context_window: unknown }) {
  const d = { input_tokens: count(v.input_tokens), output_tokens: count(v.output_tokens), cost_usd_estimate: money(v.cost_usd_estimate), context_window: count(v.context_window) || null };
  const unknown_fields = (Object.keys(d) as UsageField[]).filter((k) => d[k] === null);
  return ev(provider, 'usage', { scope, ...d, unknown_fields });
}

// Claude reports cached prompt tokens separately from input_tokens; the prompt size is their sum. A
// cache field present in a form we do not understand makes the input size unknown, not small.
function claudeInput(u: O | null): number | null {
  if (!u) return null;
  const base = count(u.input_tokens);
  if (base === null) return null;
  let total = base;
  for (const k of ['cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (u[k] === undefined) continue;
    const n = count(u[k]);
    if (n === null) return null;
    total += n;
  }
  return total;
}

function resetTime(raw: unknown): { resets_at: string | null; raw_resets_at: string | null; why: string | null } {
  if (raw === undefined || raw === null) return { resets_at: null, raw_resets_at: null, why: 'reset time not reported' };
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw) && !Number.isNaN(Date.parse(raw))) {
    return { resets_at: new Date(raw).toISOString(), raw_resets_at: null, why: null };
  }
  return { resets_at: null, raw_resets_at: String(raw).slice(0, 100), why: 'reset time in an unverified format' };
}
const percent = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null);

// ---- Claude Code stream-json ------------------------------------------------------------------
const CLAUDE_STATUS: Record<string, ProviderEventData['quota']['status']> = { allowed: 'allowed', rejected: 'rejected' };

export function normalizeClaude(raw: unknown): ProviderEvent[] {
  const m = obj(raw);
  if (!m) return [unrecognized('claude_agent', raw)];
  const P = 'claude_agent';
  switch (m.type) {
    case 'system':
      if (m.subtype !== 'init') return [unrecognized(P, raw)];
      return [ev(P, 'session_started', {
        native_session_id: str(m.session_id),
        tools: Array.isArray(m.tools) && m.tools.every((t) => typeof t === 'string') ? (m.tools as string[]) : null,
        model: str(m.model),
      })];
    case 'assistant': {
      const msg = obj(m.message);
      const out: ProviderEvent[] = [];
      for (const c of Array.isArray(msg?.content) ? msg!.content : []) {
        const b = obj(c);
        if (b?.type === 'text' && typeof b.text === 'string') out.push(ev(P, 'message_completed', { text: b.text }));
        else if (b?.type === 'tool_use' && typeof b.name === 'string') out.push(ev(P, 'tool_requested', { tool: b.name, call_id: str(b.id), input: b.input ?? null }));
        else out.push(unrecognized(P, c));
      }
      const u = obj(msg?.usage);
      if (u) out.push(usage(P, 'message', { input_tokens: claudeInput(u), output_tokens: u.output_tokens, cost_usd_estimate: undefined, context_window: undefined }));
      return out;
    }
    case 'stream_event': {
      const e = obj(m.event);
      const d = obj(e?.delta);
      if (e?.type === 'content_block_delta' && d?.type === 'text_delta' && typeof d.text === 'string') return [ev(P, 'text_delta', { text: d.text })];
      return [unrecognized(P, e ?? raw)];
    }
    case 'rate_limit_event': {
      // observed to exist (P00); its fields are not verified: only a known status word and an ISO time count
      const info = obj(m.rate_limit_info);
      const status = CLAUDE_STATUS[String(info?.status)] ?? 'unknown';
      const r = resetTime(info?.resetsAt);
      return [ev(P, 'quota', { status, used_percent: null, resets_at: r.resets_at, raw_resets_at: r.raw_resets_at, unknown_reason: r.why, source: 'official_adapter_event' })];
    }
    case 'result': {
      const u = obj(m.usage);
      const outcome = m.subtype === 'success' && m.is_error !== true ? 'success' : typeof m.subtype === 'string' && m.subtype.startsWith('error') ? 'error' : 'unknown';
      return [
        usage(P, 'turn', { input_tokens: claudeInput(u), output_tokens: u?.output_tokens, cost_usd_estimate: m.total_cost_usd, context_window: undefined }),
        ev(P, 'turn_completed', { outcome, stop_reason: str(m.subtype) }),
      ];
    }
    default:
      return [unrecognized(P, raw)];
  }
}

// ---- Codex app-server notifications --------------------------------------------------------------
const CODEX_TURN: Record<string, ProviderEventData['turn_completed']['outcome']> = { completed: 'success', interrupted: 'interrupted', failed: 'error' };

export function normalizeCodex(raw: unknown): ProviderEvent[] {
  const m = obj(raw);
  const P = 'codex';
  if (!m || typeof m.method !== 'string') return [unrecognized(P, raw)];
  const p = obj(m.params) ?? {};
  switch (m.method) {
    case 'thread/started':
      return [ev(P, 'session_started', { native_session_id: str(obj(p.thread)?.id), tools: null, model: null })];
    case 'item/agentMessage/delta':
      return typeof p.delta === 'string' ? [ev(P, 'text_delta', { text: p.delta })] : [unrecognized(P, raw)];
    case 'item/completed': {
      const item = obj(p.item);
      if (item?.type === 'agentMessage' && typeof item.text === 'string') return [ev(P, 'message_completed', { text: item.text })];
      return [unrecognized(P, raw)];
    }
    case 'thread/tokenUsage/updated': {
      const t = obj(p.tokenUsage);
      const total = obj(t?.total);
      return [usage(P, 'session', { input_tokens: total?.inputTokens, output_tokens: total?.outputTokens, cost_usd_estimate: undefined, context_window: t?.modelContextWindow })];
    }
    case 'account/rateLimits/updated': {
      const primary = obj(obj(p.rateLimits)?.primary);
      if (!primary) return [ev(P, 'quota', { status: 'unknown', used_percent: null, resets_at: null, raw_resets_at: null, unknown_reason: 'not reported', source: 'official_adapter_event' })];
      const r = resetTime(primary.resetsAt);
      return [ev(P, 'quota', { status: 'unknown', used_percent: percent(primary.usedPercent), resets_at: r.resets_at, raw_resets_at: r.raw_resets_at, unknown_reason: r.why, source: 'official_adapter_event' })];
    }
    case 'thread/compacted':
      return [ev(P, 'compacted', {} as Record<string, never>)];
    case 'turn/completed':
      return [ev(P, 'turn_completed', { outcome: CODEX_TURN[String(obj(p.turn)?.status)] ?? 'unknown', stop_reason: str(obj(p.turn)?.status) })];
    case 'error':
      return [ev(P, 'error', { kind: 'unknown', message: (str(obj(p.error)?.message) ?? 'provider error').slice(0, 2000) })];
    default:
      return [unrecognized(P, raw)];
  }
}
