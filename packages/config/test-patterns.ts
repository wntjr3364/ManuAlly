// Single source of truth for which command runs which test file. A guard test
// (tests/tasks/PW-007/scaffold.test.ts) checks every *.test.* / *.e2e.* file matches exactly one.
export const IGNORE_DIRS = ['node_modules', '.git', 'dist', 'coverage', 'playwright-report', 'test-results'];

export const UNIT_INCLUDE = ['**/*.test.{ts,tsx}'];
export const UNIT_EXCLUDE = ['**/*.int.test.{ts,tsx}', '**/*.contract.test.{ts,tsx}'];
export const INTEGRATION_INCLUDE = ['**/*.int.test.{ts,tsx}'];
export const CONTRACTS_INCLUDE = ['**/*.contract.test.{ts,tsx}'];
// browser tests live under tests/ (shared suites in tests/e2e, task suites in tests/tasks/PW-xxx)
export const E2E_DIR = 'tests';
export const E2E_MATCH = /\.e2e\.ts$/;
// node:test spike suites (P00); anything else ending in .test.mjs is an error
export const SPIKE_MJS = /^tests\/tasks\/PW-00[1-6]\/[^/]+\.test\.mjs$/;

export type Command = 'unit' | 'integration' | 'contracts' | 'e2e' | 'spikes';

// Classifies a repo-relative path; null when no command would run it.
export function commandFor(rel: string): Command | null {
  if (rel.startsWith('spikes/')) return null;
  if (/\.int\.test\.tsx?$/.test(rel)) return 'integration';
  if (/\.contract\.test\.tsx?$/.test(rel)) return 'contracts';
  if (/\.test\.tsx?$/.test(rel)) return 'unit';
  if (E2E_MATCH.test(rel)) return rel.startsWith(`${E2E_DIR}/`) ? 'e2e' : null;
  if (/\.test\.mjs$/.test(rel)) return SPIKE_MJS.test(rel) ? 'spikes' : null;
  return null;
}
