// PW-027 — the gateway's published tool schemas are valid JSON Schema (2020-12, ajv strict) and the
// gateway's own closed-schema validator agrees with ajv on accepted and refused arguments.
import { describe, expect, test } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { publishedSchemas, toolInputSchema, validateToolArgs } from '../../../packages/domain/src/tool-policy/index.ts';

const U = '00000000-0000-4000-8000-0000000000a1';
const SAMPLES: Record<string, unknown[]> = {
  get_approved_outline: [{}, { paper_id: U }, null, [], 'x'],
  get_document_slice: [{ handle_id: U }, { block_id: U }, { handle_id: 'nope' }, { handle_id: U, paper_id: U }, { block_id: 7 }],
  get_fact_records: [{}, { fact_ids: [U] }, { fact_ids: [U, U] }, { fact_ids: Array(51).fill(U) }, { fact_ids: [U], verified: true }],
  get_reference_excerpt: [{ reference_ids: [U] }, {}, { reference_ids: [] }, { reference_ids: [U], include_all: true }],
  get_figure_metadata: [{}, { kind: 'figure' }],
  propose_manuscript_edit: [
    { handle_id: U, intent: 'concise', replacement: [{ type: 'text', text: 'x' }] },
    { handle_id: U, intent: 'concise', replacement: [{ type: 'text', text: 'x' }], explanation: 'why' },
    { handle_id: U, intent: 'apply', replacement: [{ type: 'text', text: 'x' }] },
    { handle_id: U, intent: 'concise', replacement: [] },
    { handle_id: U, intent: 'concise', replacement: [{ type: 'text', text: 'x' }], approved_by: U },
    { handle_id: U, intent: 'concise', replacement: [{ type: 'text', text: 'x', a: 1, b: 2, c: 3 }] },
    { intent: 'concise', replacement: [{ type: 'text', text: 'x' }] },
  ],
};

describe('published tool schemas', () => {
  test('every schema compiles in strict mode and is closed', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: false });
    for (const [name, schema] of Object.entries(publishedSchemas())) {
      expect(schema, name).toMatchObject({ type: 'object', additionalProperties: false });
      expect(() => ajv.compile(schema), name).not.toThrow();
    }
  });

  test('the gateway validator and ajv agree on every sample', () => {
    const ajv = new Ajv2020({ strict: true });
    const schemas = publishedSchemas();
    for (const [name, samples] of Object.entries(SAMPLES)) {
      const check = ajv.compile(schemas[name]!);
      for (const s of samples) expect(validateToolArgs(toolInputSchema(name)!, s) === null, `${name} ${JSON.stringify(s)}`).toBe(check(s));
    }
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(schemas).sort());
  });
});
