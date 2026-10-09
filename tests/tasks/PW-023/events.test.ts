// PW-023 — raw provider events become normalized domain events. Fields a provider did not report are
// null with the reason (never 0 or an invented time); unknown event types are kept as `unrecognized`
// and never interpreted. Every normalized event validates against the provider_event contract.
import { describe, expect, test } from 'vitest';
import { normalizeClaude, normalizeCodex } from '../../../packages/providers/src/core/index.ts';
import { validateProviderEvent } from '../../../packages/contracts/src/provider/index.ts';

const valid = (evs: unknown[]) => { for (const e of evs) { const r = validateProviderEvent(e); expect(r.ok, JSON.stringify(r)).toBe(true); } return evs; };

describe('Claude Code stream-json', () => {
  test('init, text, tool request, usage and result', () => {
    const evs = valid([
      ...normalizeClaude({ type: 'system', subtype: 'init', session_id: 's-1', tools: [], model: 'm' }),
      ...normalizeClaude({ type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 't1', name: 'get_document_slice', input: { id: 'x' } }], usage: { input_tokens: 10, output_tokens: 3 } } }),
      ...normalizeClaude({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'He' } } }),
      ...normalizeClaude({ type: 'result', subtype: 'success', is_error: false, result: 'Hello', usage: { input_tokens: 10, output_tokens: 3 }, total_cost_usd: 0.009, session_id: 's-1' }),
    ]);
    expect(evs.map((e) => (e as { kind: string }).kind)).toEqual(['session_started', 'message_completed', 'tool_requested', 'usage', 'text_delta', 'usage', 'turn_completed']);
    expect(evs[0]).toMatchObject({ provider: 'claude_agent', data: { native_session_id: 's-1', tools: [] } });
    expect(evs.at(-2)).toMatchObject({ kind: 'usage', data: { input_tokens: 10, output_tokens: 3, cost_usd_estimate: 0.009, context_window: null } });
    expect(evs.at(-1)).toMatchObject({ kind: 'turn_completed', data: { outcome: 'success' } });
  });

  test('TST-023B: a rate limit event without a reset time does not invent one; missing usage is unknown, not 0', () => {
    const [q] = valid(normalizeClaude({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }));
    expect(q).toMatchObject({ kind: 'quota', data: { status: 'allowed', used_percent: null, resets_at: null, unknown_reason: 'reset time not reported' } });
    const [q2] = valid(normalizeClaude({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1760000000 } }));
    expect(q2).toMatchObject({ kind: 'quota', data: { status: 'unknown', resets_at: null, raw_resets_at: '1760000000', unknown_reason: 'reset time in an unverified format' } });
    const [q3] = valid(normalizeClaude({ type: 'rate_limit_event' }));
    expect(q3).toMatchObject({ kind: 'quota', data: { status: 'unknown', resets_at: null } });
    const evs = valid(normalizeClaude({ type: 'result', subtype: 'success', is_error: false, result: 'x' }));
    expect(evs.find((e) => (e as { kind: string }).kind === 'usage')).toMatchObject({ data: { input_tokens: null, output_tokens: null, cost_usd_estimate: null, unknown_fields: ['input_tokens', 'output_tokens', 'cost_usd_estimate', 'context_window'] } });
  });

  test('errors and unknown events', () => {
    expect(valid(normalizeClaude({ type: 'result', subtype: 'error_during_execution', is_error: true }))).toContainEqual(expect.objectContaining({ kind: 'turn_completed', data: expect.objectContaining({ outcome: 'error' }) }));
    expect(valid(normalizeClaude({ type: 'brand_new_thing', x: 1 }))).toEqual([expect.objectContaining({ kind: 'unrecognized', data: { raw_type: 'brand_new_thing' } })]);
    expect(valid(normalizeClaude('not an object'))).toEqual([expect.objectContaining({ kind: 'unrecognized', data: { raw_type: null } })]);
    // a negative or non-finite token count is not a count
    expect(valid(normalizeClaude({ type: 'result', subtype: 'success', usage: { input_tokens: -1, output_tokens: Number.NaN } }))[0]).toMatchObject({ data: { input_tokens: null, output_tokens: null } });
  });
});

describe('Codex app-server notifications', () => {
  test('thread, deltas, completion, usage, compaction', () => {
    const evs = valid([
      ...normalizeCodex({ method: 'thread/started', params: { thread: { id: 'th-1' } } }),
      ...normalizeCodex({ method: 'item/agentMessage/delta', params: { delta: 'Hi' } }),
      ...normalizeCodex({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Hi there' } } }),
      ...normalizeCodex({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 5, outputTokens: 2 }, modelContextWindow: 200000 } } }),
      ...normalizeCodex({ method: 'thread/compacted', params: {} }),
      ...normalizeCodex({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } }),
    ]);
    expect(evs.map((e) => (e as { kind: string }).kind)).toEqual(['session_started', 'text_delta', 'message_completed', 'usage', 'compacted', 'turn_completed']);
    expect(evs[3]).toMatchObject({ data: { input_tokens: 5, output_tokens: 2, context_window: 200000, cost_usd_estimate: null } });
    expect(evs.at(-1)).toMatchObject({ data: { outcome: 'interrupted' } });
  });
  test('TST-023B: rate limits keep only what was reported, as reported', () => {
    const [q] = valid(normalizeCodex({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 42.5, resetsAt: '2026-10-09T12:00:00Z' } } } }));
    expect(q).toMatchObject({ kind: 'quota', data: { used_percent: 42.5, resets_at: '2026-10-09T12:00:00.000Z', status: 'unknown' } });
    const [q2] = valid(normalizeCodex({ method: 'account/rateLimits/updated', params: { rateLimits: {} } }));
    expect(q2).toMatchObject({ data: { used_percent: null, resets_at: null, unknown_reason: 'not reported' } });
    const [q3] = valid(normalizeCodex({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 140 } } } }));
    expect(q3).toMatchObject({ data: { used_percent: null } }); // out of range: not a percentage
  });
  test('errors and the many other notifications are not interpreted', () => {
    expect(valid(normalizeCodex({ method: 'error', params: { error: { message: 'boom' } } }))).toEqual([expect.objectContaining({ kind: 'error', data: { kind: 'unknown', message: 'boom' } })]);
    expect(valid(normalizeCodex({ method: 'fs/changed', params: {} }))).toEqual([expect.objectContaining({ kind: 'unrecognized', data: { raw_type: 'fs/changed' } })]);
    expect(valid(normalizeCodex({ id: 3, result: {} }))).toEqual([expect.objectContaining({ kind: 'unrecognized' })]);
  });
});

test('the contract refuses an event that claims a value without a basis', () => {
  expect(validateProviderEvent({ schema_version: 1, provider: 'claude_agent', kind: 'quota', data: { status: 'allowed', used_percent: 0, resets_at: 'tomorrow', raw_resets_at: null, unknown_reason: null, source: 'official_adapter_event' } }).ok).toBe(false);
  expect(validateProviderEvent({ schema_version: 1, provider: 'claude_agent', kind: 'made_up', data: {} }).ok).toBe(false);
});
