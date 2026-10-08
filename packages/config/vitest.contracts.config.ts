import { defineConfig } from 'vitest/config';
import { repoRoot, commonExclude } from './vitest.shared.ts';
import { CONTRACTS_INCLUDE } from './test-patterns.ts';

export default defineConfig({
  root: repoRoot,
  test: { include: CONTRACTS_INCLUDE, exclude: commonExclude },
});
