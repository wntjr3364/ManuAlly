// PW-007 — TST-007A / TST-007B
// Run: pnpm test:unit -- tests/tasks/PW-007
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readJson = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const REQUIRED_SCRIPTS = ['lint', 'typecheck', 'test:unit', 'test:integration', 'test:e2e', 'test:contracts', 'test:evals', 'test:spikes', 'pack-check', 'test'];
const WORKSPACES = ['apps/api', 'apps/web', 'apps/worker', 'packages/config', 'packages/contracts', 'packages/editor-core', 'packages/domain', 'packages/providers', 'packages/search', 'packages/exports'];

describe('TST-007A: registered commands and workspace boundaries', () => {
  test('root package.json registers every verification command', () => {
    const pkg = readJson('package.json');
    expect(pkg.private).toBe(true);
    for (const s of REQUIRED_SCRIPTS) expect(pkg.scripts[s], s).toBeTypeOf('string');
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  test('every workspace package exists, is private ESM and scoped @pw/*', () => {
    for (const ws of WORKSPACES) {
      const pkg = readJson(`${ws}/package.json`);
      expect(pkg.name, ws).toBe(`@pw/${path.basename(ws)}`);
      expect(pkg.private, ws).toBe(true);
      expect(pkg.type, ws).toBe('module');
    }
  });

  test('dependency versions are exact pins (no ^, ~, latest)', () => {
    for (const p of ['package.json', ...WORKSPACES.map((w) => `${w}/package.json`)]) {
      const pkg = readJson(p);
      for (const field of ['dependencies', 'devDependencies']) {
        for (const [name, v] of Object.entries<string>(pkg[field] ?? {})) {
          if (v.startsWith('workspace:')) continue;
          expect(v, `${p} ${name}`).toMatch(/^\d+\.\d+\.\d+$/);
        }
      }
    }
  });

  test('the worker defaults to the mock provider and refuses real providers without an admission', async () => {
    const { selectProvider } = await import('../../../apps/worker/src/index.ts');
    expect(selectProvider({}).id).toBe('mock');
    expect(selectProvider({ PW_PROVIDER: 'mock' }).id).toBe('mock');
    for (const p of ['claude_agent', 'codex', 'anthropic_api']) {
      expect(() => selectProvider({ PW_PROVIDER: p }), p).toThrow(/admission/);
    }
  });

  test('typecheck passes on a clean tree', () => {
    const r = spawnSync('pnpm', ['run', '-s', 'typecheck'], { cwd: root, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  }, 240_000);
});

describe('TST-007B: missing secrets never switch providers or silently skip suites', () => {
  test('no secret-shaped environment variable changes the provider', async () => {
    const { selectProvider } = await import('../../../apps/worker/src/index.ts');
    const env = { ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'x' };
    expect(selectProvider(env).id).toBe('mock');
  });

  test('test files never skip on missing credentials, and suites do not pass with no tests', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.test\.(ts|tsx|mjs)$/.test(e.name)) files.push(p);
      }
    };
    for (const d of ['tests', 'apps', 'packages']) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
    expect(files.length).toBeGreaterThan(0);
    const secretSkip = /(skipIf|runIf|\.skip|todo)\s*\([^)]*(API_KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL)/;
    for (const f of files) expect(secretSkip.test(fs.readFileSync(f, 'utf8')), f).toBe(false);
    const pkg = readJson('package.json');
    for (const s of REQUIRED_SCRIPTS) expect(pkg.scripts[s], s).not.toMatch(/passWithNoTests/);
  });

  test('integration tests fail loudly (not skip) when PostgreSQL is unavailable', async () => {
    const { requireTestDatabaseUrl } = await import('../../../packages/config/src/test-db.ts');
    expect(() => requireTestDatabaseUrl({})).toThrow(/PW_TEST_DATABASE_URL/);
    expect(() => requireTestDatabaseUrl({ PW_TEST_DATABASE_URL: 'postgres://u@localhost/pw_prod' })).toThrow(/test database/);
    expect(requireTestDatabaseUrl({ PW_TEST_DATABASE_URL: 'postgres://u@localhost:54329/pw_test' })).toContain('pw_test');
  });
});
