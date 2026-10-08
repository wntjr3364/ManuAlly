import { defineConfig } from 'vitest/config';
import { repoRoot, commonExclude } from './vitest.shared.ts';
import { INTEGRATION_INCLUDE } from './test-patterns.ts';

export default defineConfig({
  root: repoRoot,
  test: { include: INTEGRATION_INCLUDE, exclude: commonExclude, testTimeout: 30_000, hookTimeout: 30_000 },
});
