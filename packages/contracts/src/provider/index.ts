// Provider contracts (PW-023): the normalized provider event every adapter emits.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';

const addFormats = (formatsModule as unknown as { default: FormatsPlugin }).default ?? (formatsModule as unknown as FormatsPlugin);

export type ProviderId = 'mock' | 'claude_agent' | 'codex';
export type UsageField = 'input_tokens' | 'output_tokens' | 'cost_usd_estimate' | 'context_window';
export type ProviderEventData = {
  session_started: { native_session_id: string | null; tools: string[] | null; model: string | null };
  text_delta: { text: string };
  message_completed: { text: string };
  tool_requested: { tool: string; call_id: string | null; input: unknown };
  usage: { scope: 'message' | 'turn' | 'session'; input_tokens: number | null; output_tokens: number | null; cost_usd_estimate: number | null; context_window: number | null; unknown_fields: UsageField[] };
  quota: { status: 'allowed' | 'warning' | 'rejected' | 'unknown'; used_percent: number | null; resets_at: string | null; raw_resets_at: string | null; unknown_reason: string | null; source: 'official_adapter_event' };
  turn_completed: { outcome: 'success' | 'error' | 'interrupted' | 'unknown'; stop_reason: string | null };
  compacted: Record<string, never>;
  error: { kind: 'auth' | 'quota' | 'network' | 'provider' | 'unknown'; message: string };
  unrecognized: { raw_type: string | null };
};
export type ProviderEventKind = keyof ProviderEventData;
export type ProviderEvent = { [K in ProviderEventKind]: { schema_version: 1; provider: ProviderId; kind: K; data: ProviderEventData[K] } }[ProviderEventKind];

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const schema = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./provider_event.schema.json', import.meta.url)), 'utf8'));
const validate = ajv.compile(schema);

export function validateProviderEvent(v: unknown): { ok: true; value: ProviderEvent } | { ok: false; errors: { path: string; message: string }[] } {
  if (validate(v)) return { ok: true, value: v as ProviderEvent };
  return { ok: false, errors: (validate.errors ?? []).map((e) => ({ path: e.instancePath, message: e.message ?? 'invalid' })) };
}
