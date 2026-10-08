// Contract smoke: the starter JSON Schemas compile (draft 2020-12) and accept/reject their examples.
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';

// ajv-formats is CommonJS (module.exports = plugin, exports.default = plugin)
const addFormats = ((formatsModule as unknown as { default: FormatsPlugin }).default ?? (formatsModule as unknown as FormatsPlugin));

const read = (p: string) => JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
const manifest = read('examples/EXAMPLE_MANIFEST.json') as { examples: { schema: string; file: string; valid: boolean }[] };

describe('starter contracts', () => {
  test('manifest lists both valid and invalid examples', () => {
    expect(manifest.examples.some((e) => e.valid)).toBe(true);
    expect(manifest.examples.some((e) => !e.valid)).toBe(true);
  });
  for (const ex of manifest.examples) {
    test(`${ex.file} is ${ex.valid ? 'accepted' : 'rejected'} by ${ex.schema}`, () => {
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      addFormats(ajv);
      const validate = ajv.compile(read(ex.schema));
      expect(validate(read(ex.file)), JSON.stringify(validate.errors)).toBe(ex.valid);
    });
  }
});
