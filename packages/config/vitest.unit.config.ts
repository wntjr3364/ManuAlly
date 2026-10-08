import { defineConfig } from 'vitest/config';
import { repoRoot, commonExclude } from './vitest.shared.ts';

export default defineConfig({
  root: repoRoot,
  test: {
    include: ['tests/tasks/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}', 'packages/*/src/**/*.test.ts'],
    exclude: [...commonExclude, '**/*.int.test.ts', '**/*.contract.test.ts'],
  },
});
