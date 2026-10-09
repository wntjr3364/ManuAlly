// @pw/contracts — typed access to the JSON Schema contracts in /contracts (server side).
// The schemas are the source of truth; these types mirror them and the validators compile them.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';

// ajv-formats is CommonJS (module.exports = plugin, exports.default = plugin)
const addFormats = (formatsModule as unknown as { default: FormatsPlugin }).default ?? (formatsModule as unknown as FormatsPlugin);
const contractsDir = fileURLToPath(new URL('../../../contracts/', import.meta.url));

export type ReplacementItem =
  | { type: 'text'; text: string; marks?: ('bold' | 'italic' | 'subscript' | 'superscript')[] }
  | { type: 'citation'; reference_id: string; locator?: string | null }
  | { type: 'preserve_atom'; atom_index: number };

export interface EditProposalV2 {
  schema_version: 2;
  proposal_id: string;
  paper_id: string;
  document_id: string;
  base_revision_id: string;
  // null only for a pre-approval conservative correction (RFC-003)
  outline_revision_id: string | null;
  intent?: 'grammar' | 'concise' | 'rewrite';
  operation: {
    type: 'replace_selection';
    selection_handle_id: string;
    block_id: string;
    expected_block_hash: string;
    selected_slice_hash: string;
    from: number;
    to: number;
    replacement: ReplacementItem[];
  };
  source_evidence_ids: string[];
  checks: { check: string; result: 'pass' | 'fail' | 'unknown' | 'not_applicable'; details?: string }[];
  explanation?: string;
}

export interface AiReplacementV1 {
  schema_version: 1;
  selection_handle_id: string;
  outcome: 'replacement' | 'needs_evidence' | 'no_change';
  replacement?: ReplacementItem[];
  missing?: string[];
  explanation?: string;
}

export type ContractResult<T> = { ok: true; value: T } | { ok: false; errors: { path: string; message: string }[] };

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const compiled = new Map<string, ValidateFunction>();
function validator(file: string): ValidateFunction {
  let v = compiled.get(file);
  if (!v) {
    v = ajv.compile(JSON.parse(fs.readFileSync(`${contractsDir}${file}`, 'utf8')));
    compiled.set(file, v);
  }
  return v;
}
const errorsOf = (errs: ErrorObject[] | null | undefined) => (errs ?? []).map((e) => ({ path: e.instancePath || '/', message: e.message ?? 'invalid' }));

function check<T>(file: string, value: unknown): ContractResult<T> {
  const v = validator(file);
  return v(value) ? { ok: true, value: value as T } : { ok: false, errors: errorsOf(v.errors) };
}

export const validateEditProposal = (v: unknown) => check<EditProposalV2>('edit_proposal.schema.json', v);
// model output is untrusted: anything outside this contract (positions, ids, approvals …) is refused
export const validateAiReplacement = (v: unknown) => check<AiReplacementV1>('ai_replacement.schema.json', v);
