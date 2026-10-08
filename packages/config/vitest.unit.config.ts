import { defineConfig } from 'vitest/config';
import { repoRoot, commonExclude } from './vitest.shared.ts';
import { UNIT_EXCLUDE, UNIT_INCLUDE } from './test-patterns.ts';

export default defineConfig({
  root: repoRoot,
  test: { include: UNIT_INCLUDE, exclude: [...commonExclude, ...UNIT_EXCLUDE] },
});
