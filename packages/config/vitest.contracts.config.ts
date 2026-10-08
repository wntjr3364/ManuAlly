import { defineConfig } from 'vitest/config';
import { repoRoot, commonExclude } from './vitest.shared.ts';

export default defineConfig({
  root: repoRoot,
  test: {
    include: ['tests/contracts/**/*.test.ts', 'packages/*/src/**/*.contract.test.ts'],
    exclude: commonExclude,
  },
});
