// PW-052 — the classification of provider and run errors (spec 08 "오류 종류별 동작"). Synthetic fixtures in
// the shapes the adapters and Node give: an HTTP status, an API error type, a system error code, a CLI
// message. Structured fields decide first; a message is read only when nothing structured says more.
// TST-052A: each error gets its state and the owner's next step.
// TST-052B: a login problem (401/403) is never a quota wait and never retried.
import { describe, expect, test } from 'vitest';
import { classifyError, classifyEvent } from '../../../packages/providers/src/error-normalization/index.ts';

const c = (o: Parameters<typeof classifyError>[0]) => classifyError(o);

describe('TST-052A: each error gets its state and the owner\'s next step', () => {
  test.each([
    // quota / rate limits
    [{ provider: 'claude_agent', httpStatus: 429, errorType: 'rate_limit_error' }, 'quota', 'WAITING_QUOTA', 'wait_for_reset'],
    [{ provider: 'claude_agent', message: 'Claude AI usage limit reached|1760000000' }, 'quota', 'WAITING_QUOTA', 'wait_for_reset'],
    [{ provider: 'codex', message: "You've hit your usage limit. Upgrade or try again later." }, 'quota', 'WAITING_QUOTA', 'wait_for_reset'],
    // login
    [{ provider: 'claude_agent', httpStatus: 401, errorType: 'authentication_error' }, 'auth', 'WAITING_AUTH', 'log_in_again'],
    [{ provider: 'claude_agent', message: 'Invalid API key · Please run /login' }, 'auth', 'WAITING_AUTH', 'log_in_again'],
    [{ provider: 'codex', message: 'Your refresh token has expired. Please log in again.' }, 'auth', 'WAITING_AUTH', 'log_in_again'],
    [{ provider: 'claude_agent', httpStatus: 403, errorType: 'permission_error' }, 'auth', 'WAITING_AUTH', 'log_in_again'],
    // transient network
    [{ provider: 'codex', code: 'ECONNRESET' }, 'network', 'RETRY', 'none'],
    [{ provider: 'codex', code: 'ETIMEDOUT' }, 'network', 'RETRY', 'none'],
    [{ provider: 'claude_agent', code: 'EAI_AGAIN' }, 'network', 'RETRY', 'none'],
    [{ provider: 'claude_agent', httpStatus: 502 }, 'network', 'RETRY', 'none'],
    // provider overload
    [{ provider: 'claude_agent', httpStatus: 529, errorType: 'overloaded_error' }, 'overloaded', 'RETRY', 'none'],
    [{ provider: 'codex', httpStatus: 503 }, 'overloaded', 'RETRY', 'none'],
    // budget, evidence, schema, conflict, disk
    [{ provider: 'mock', errorType: 'budget_exhausted' }, 'budget', 'WAITING_BUDGET', 'set_budget'],
    [{ provider: 'mock', errorType: 'evidence_missing' }, 'evidence_missing', 'WAITING_USER', 'add_evidence'],
    [{ provider: 'mock', errorType: 'schema_violation' }, 'schema', 'FAILED', 'ask_again'],
    [{ provider: 'mock', errorType: 'document_conflict' }, 'conflict', 'STALE', 'ask_again'],
    [{ provider: 'mock', code: 'ENOSPC' }, 'disk_full', 'FAILED', 'free_disk_space'],
    // anything else: not retried blindly
    [{ provider: 'codex', message: 'something odd happened' }, 'unknown', 'FAILED', 'report'],
    [{ provider: 'claude_agent', httpStatus: 400, errorType: 'invalid_request_error' }, 'invalid_request', 'FAILED', 'report'],
  ] as const)('%j → %s', (input, cls, next, action) => {
    const r = c(input);
    expect(r).toMatchObject({ class: cls, next, action });
    expect(r.notice.length).toBeGreaterThan(10);
  });

  test('retry-after is kept for a quota or overload error', () => {
    expect(c({ provider: 'claude_agent', httpStatus: 429, retryAfterS: 90 })).toMatchObject({ class: 'quota', retry_after_s: 90 });
    expect(c({ provider: 'claude_agent', httpStatus: 529, retryAfterS: 30 })).toMatchObject({ class: 'overloaded', retry_after_s: 30 });
  });

  test('a provider error event is classified by its message (the adapters give kind unknown)', () => {
    expect(classifyEvent('codex', { schema_version: 1, provider: 'codex', kind: 'error', data: { kind: 'unknown', message: "You've hit your usage limit." } })).toMatchObject({ class: 'quota' });
    expect(classifyEvent('codex', { schema_version: 1, provider: 'codex', kind: 'error', data: { kind: 'auth', message: 'x' } })).toMatchObject({ class: 'auth' });
  });

  test('an Error object with status, code or type fields is read the same way', () => {
    const e = Object.assign(new Error('Request failed'), { status: 401, error: { type: 'authentication_error' } });
    expect(c({ provider: 'claude_agent', error: e })).toMatchObject({ class: 'auth' });
    expect(c({ provider: 'claude_agent', error: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })).toMatchObject({ class: 'network' });
  });
});

describe('TST-052B: a login problem is never a quota wait and never retried', () => {
  test('a 401 or 403 is auth even when the message mentions limits or quota', () => {
    expect(c({ provider: 'claude_agent', httpStatus: 401, message: 'usage limit reached' })).toMatchObject({ class: 'auth', next: 'WAITING_AUTH', retry: false });
    expect(c({ provider: 'codex', httpStatus: 403, message: 'quota exceeded for this account' })).toMatchObject({ class: 'auth', next: 'WAITING_AUTH', retry: false });
  });
  test('a 429 is quota even when the message mentions login', () => {
    expect(c({ provider: 'claude_agent', httpStatus: 429, message: 'please log in again later' })).toMatchObject({ class: 'quota' });
  });
  test('only network and overload errors are retried', () => {
    const all = ['quota', 'auth', 'budget', 'evidence_missing', 'schema', 'conflict', 'disk_full', 'unknown', 'invalid_request'];
    for (const errorType of ['rate_limit_error', 'authentication_error', 'budget_exhausted', 'evidence_missing', 'schema_violation', 'document_conflict', 'invalid_request_error']) {
      const r = c({ provider: 'mock', errorType });
      expect(all).toContain(r.class);
      expect(r.retry).toBe(false);
    }
    expect(c({ provider: 'mock', code: 'ECONNRESET' }).retry).toBe(true);
    expect(c({ provider: 'mock', httpStatus: 529 }).retry).toBe(true);
  });
  test('a message is never stored whole: the notice is fixed text, the detail clipped and without keys', () => {
    // a long message of ordinary words (a single long token would be redacted whole)
    const r = c({ provider: 'codex', message: 'the request failed '.repeat(300) });
    expect(r.detail.length).toBeLessThanOrEqual(500);
    const k = c({ provider: 'claude_agent', httpStatus: 401, message: 'bad key sk-ant-api03-AbCdEf123456 and Bearer eyJhbGciOi.abc.def, session 0123456789abcdef0123456789abcdef' });
    expect(k.detail).not.toMatch(/sk-ant|eyJhbGci|0123456789abcdef0123/);
    expect(k.detail).toContain('[redacted]');
  });
});
