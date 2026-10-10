// Provider and run errors, classified (PW-052, spec 08 "오류 종류별 동작"):
//   429 quota → WAITING_QUOTA; 401/403 credential → WAITING_AUTH (never a quota wait, never retried);
//   transient network → bounded retry; provider overload → bounded retry and a circuit breaker;
//   hard budget → WAITING_BUDGET; evidence missing → WAITING_USER; schema violation (after the one allowed
//   repair) → FAILED; document conflict → STALE; disk full → a safe stop (FAILED) with a notice.
// Anything else is FAILED and reported: an unknown error is not retried blindly (it may cost a model call
// each time). Structured fields decide first (HTTP status, API error type, system error code); a message is
// read only when nothing structured says more, with conservative patterns. The owner sees a fixed notice
// with the next step; the provider's own message is kept only as a short detail.
import type { ProviderEvent } from '../../../contracts/src/provider/index.ts';

export type ErrorClass = 'quota' | 'auth' | 'network' | 'overloaded' | 'budget' | 'evidence_missing' | 'schema' | 'conflict' | 'disk_full' | 'invalid_request' | 'unknown';
export type NextState = 'WAITING_QUOTA' | 'WAITING_AUTH' | 'WAITING_BUDGET' | 'WAITING_USER' | 'FAILED' | 'STALE' | 'RETRY';
export type NextAction = 'wait_for_reset' | 'log_in_again' | 'set_budget' | 'add_evidence' | 'ask_again' | 'free_disk_space' | 'report' | 'none';
export interface Classified {
  class: ErrorClass; next: NextState; action: NextAction; retry: boolean; retry_after_s: number | null;
  notice: string; detail: string;
}
export interface ErrorInput {
  provider: string; httpStatus?: number | null; errorType?: string | null; code?: string | null; message?: string | null; retryAfterS?: number | null; error?: unknown;
}

const RULES: Record<ErrorClass, { next: NextState; action: NextAction; retry: boolean; notice: string }> = {
  quota: { next: 'WAITING_QUOTA', action: 'wait_for_reset', retry: false, notice: 'The provider\'s usage limit was reached. The job waits for the limit to reset (and resumes only if auto-resume is allowed).' },
  auth: { next: 'WAITING_AUTH', action: 'log_in_again', retry: false, notice: 'The provider login is missing, expired or not allowed. Log in again with the provider\'s CLI on the machine that runs the worker; the job is not retried until then.' },
  network: { next: 'RETRY', action: 'none', retry: true, notice: 'A network error reached the provider. The job is retried a few times with a growing delay.' },
  overloaded: { next: 'RETRY', action: 'none', retry: true, notice: 'The provider is overloaded. The job is retried a few times with a growing delay; repeated overload pauses calls to it for a while.' },
  budget: { next: 'WAITING_BUDGET', action: 'set_budget', retry: false, notice: 'The budget for this run is used up or not set. Set a budget, then ask again.' },
  evidence_missing: { next: 'WAITING_USER', action: 'add_evidence', retry: false, notice: 'The plan lacks the verified evidence this step needs. Add or verify it, then ask again.' },
  schema: { next: 'FAILED', action: 'ask_again', retry: false, notice: 'The answer did not match the required form, also after the one allowed repair. Nothing was stored; ask again.' },
  conflict: { next: 'STALE', action: 'ask_again', retry: false, notice: 'The text changed while the job ran. Nothing was overwritten; ask again on the current text.' },
  disk_full: { next: 'FAILED', action: 'free_disk_space', retry: false, notice: 'The disk is full. The job stopped safely and nothing was half-stored; free space, then ask again.' },
  invalid_request: { next: 'FAILED', action: 'report', retry: false, notice: 'The provider refused the request as invalid. This is likely a bug; it is not retried.' },
  unknown: { next: 'FAILED', action: 'report', retry: false, notice: 'An unexpected error stopped the job. It is not retried automatically.' },
};

const TYPE: Record<string, ErrorClass> = {
  rate_limit_error: 'quota', rate_limited: 'quota', usage_limit_exceeded: 'quota', quota_exceeded: 'quota',
  authentication_error: 'auth', permission_error: 'auth', unauthorized: 'auth', invalid_api_key: 'auth',
  overloaded_error: 'overloaded', api_error: 'overloaded', server_error: 'overloaded',
  invalid_request_error: 'invalid_request', not_found_error: 'invalid_request', request_too_large: 'invalid_request',
  budget_exhausted: 'budget', evidence_missing: 'evidence_missing', schema_violation: 'schema', document_conflict: 'conflict',
};
const NETWORK_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'];
// read only without a structured signal; conservative (a wrong "retry" is worse than a wrong "report").
// Login before limit: a message naming both is a login problem, which stops without a call (review m1).
const MESSAGE: [RegExp, ErrorClass][] = [
  // a credit balance is the API-key billing of the provider, which v1 does not use: log in with the subscription
  [/\b(invalid api key|please (?:run )?\/?log ?in|log in again|not logged in|refresh token (?:has )?expired|unauthori[sz]ed|authentication failed|credit balance is too low)\b/i, 'auth'],
  [/\b(usage limit|rate limit|rate-limited|quota (?:exceeded|reached)|hit your usage limit|too many requests)\b/i, 'quota'],
  [/\b(overloaded|service unavailable)\b/i, 'overloaded'],
  [/\bno space left on device\b/i, 'disk_full'],
  [/\b(stream ended unexpectedly|socket hang up|premature close|other side closed|connection reset)\b/i, 'network'],
];
const str = (v: unknown) => (typeof v === 'string' ? v : null);
// what may never be stored from a provider's message: keys and tokens — known prefixes (sk-…, ghp_…, AKIA…),
// the value after a key/token/secret/password/authorization label, Bearer tokens, and long opaque strings
// (base64 included). Conservative: a long path or id may be redacted too (review m2).
const OPAQUE = 'A-Za-z0-9_+/=-';
export const redact = (t: string) => t
  .replace(/\b(?:sk|pk|rk|sess|xai|xox[abp])-[A-Za-z0-9_-]{4,}/gi, '[redacted]')
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{3,}|github_pat_[A-Za-z0-9_]{4,}|AKIA[0-9A-Z]{12,})/g, '[redacted]')
  .replace(/\b((?:x-)?api[-_ ]?key|key|token|secret|password|passwd|authorization|cookie)(\s*[:=]\s*)(["']?)(?:(?:Basic|Bearer)\s+)?[^\s"';,]+/gi, '$1$2$3[redacted]')
  .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
  .replace(new RegExp(`(?<![${OPAQUE}])[${OPAQUE}]{32,}`, 'g'), '[redacted]');
function fromError(e: unknown): Partial<ErrorInput> {
  if (!e || typeof e !== 'object') return { message: typeof e === 'string' ? e : null };
  const o = e as Record<string, unknown>;
  const inner = (o.error && typeof o.error === 'object' ? o.error : {}) as Record<string, unknown>;
  const status = typeof o.status === 'number' ? o.status : typeof o.statusCode === 'number' ? o.statusCode : null;
  return { httpStatus: status, code: str(o.code), errorType: str(inner.type) ?? str(o.type), message: str(o.message) };
}

function classOf(i: ErrorInput): ErrorClass {
  // the HTTP status decides the account questions: 401/403 is a login problem, 429 a limit — whatever the
  // message says (TST-052B)
  if (i.httpStatus === 401 || i.httpStatus === 403) return 'auth';
  if (i.httpStatus === 429) return 'quota';
  if (i.errorType && TYPE[i.errorType]) return TYPE[i.errorType]!;
  if (i.code === 'ENOSPC') return 'disk_full';
  if (i.code && NETWORK_CODES.includes(i.code)) return 'network';
  if (i.httpStatus === 529 || i.httpStatus === 503) return 'overloaded';
  if (i.httpStatus === 500 || i.httpStatus === 502 || i.httpStatus === 504) return 'network';
  if (i.httpStatus && i.httpStatus >= 400 && i.httpStatus < 500) return 'invalid_request';
  for (const [re, cls] of MESSAGE) if (i.message && re.test(i.message)) return cls;
  return 'unknown';
}

export function classifyError(input: ErrorInput): Classified {
  const e = input.error !== undefined ? fromError(input.error) : {};
  const i: ErrorInput = {
    provider: input.provider, httpStatus: input.httpStatus ?? e.httpStatus ?? null, errorType: input.errorType ?? e.errorType ?? null,
    code: input.code ?? e.code ?? null, message: input.message ?? e.message ?? null, retryAfterS: input.retryAfterS ?? null,
  };
  const cls = classOf(i);
  const r = RULES[cls];
  const retryAfter = (cls === 'quota' || cls === 'overloaded') && typeof i.retryAfterS === 'number' && i.retryAfterS >= 0 ? Math.round(i.retryAfterS) : null;
  return { class: cls, next: r.next, action: r.action, retry: r.retry, retry_after_s: retryAfter, notice: r.notice, detail: `${i.provider}: ${redact((i.message ?? i.errorType ?? i.code ?? (i.httpStatus ? `HTTP ${i.httpStatus}` : 'error')).replace(/\s+/g, ' '))}`.slice(0, 500) };
}

// a provider's error event: its kind when the adapter knew it, else its message
export function classifyEvent(provider: string, e: Extract<ProviderEvent, { kind: 'error' }>): Classified {
  const k = e.data.kind;
  const errorType = k === 'auth' ? 'authentication_error' : k === 'quota' ? 'rate_limit_error' : null;
  return classifyError({ provider, errorType, code: k === 'network' ? 'ECONNRESET' : null, message: e.data.message });
}
