import { defineConfig } from 'vitest/config';
import { repoRoot, commonExclude } from './vitest.shared.ts';

export default defineConfig({
  root: repoRoot,
  test: {
    include: ['tests/**/*.int.test.ts', 'apps/*/src/**/*.int.test.ts', 'packages/*/src/**/*.int.test.ts'],
    exclude: commonExclude,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
