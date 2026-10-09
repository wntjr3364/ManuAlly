import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_DIR, E2E_MATCH } from './test-patterns.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: path.join(repoRoot, E2E_DIR),
  testMatch: E2E_MATCH,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: { headless: true, launchOptions: executablePath ? { executablePath } : {} },
});
