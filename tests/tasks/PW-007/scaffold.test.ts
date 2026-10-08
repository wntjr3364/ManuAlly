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
const IGNORE = new Set(['node_modules', '.git', 'dist', 'coverage', 'playwright-report', 'test-results', 'spikes']);
function allTestFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (IGNORE.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (/\.(test\.(ts|tsx|mjs|js)|e2e\.ts)$/.test(e.name)) out.push(r);
    }
  };
  walk('');
  return out;
}

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

  test('no test can skip itself conditionally, and no suite passes with no tests', () => {
    // Any conditional skip could hide a missing credential/DB; skips need an explicit, reviewed marker.
    const conditionalSkip = /\b(skipIf|runIf)\s*\(|\b(ctx|context|t)\.skip\s*\(|\b(test|it|describe)\.skip\b|\b(test|it|describe)\.todo\b/;
    for (const f of allTestFiles()) {
      for (const [i, line] of fs.readFileSync(path.join(root, f), 'utf8').split('\n').entries()) {
        if (/allowed-skip:/.test(line) || /conditionalSkip =/.test(line)) continue;
        expect(conditionalSkip.test(line), `${f}:${i + 1}: ${line.trim()}`).toBe(false);
      }
    }
    const pkg = readJson('package.json');
    for (const s of REQUIRED_SCRIPTS) expect(pkg.scripts[s], s).not.toMatch(/passWithNoTests/);
    for (const c of fs.readdirSync(path.join(root, 'packages/config')).filter((n) => /\.config\.ts$/.test(n))) {
      expect(fs.readFileSync(path.join(root, 'packages/config', c), 'utf8'), c).not.toMatch(/passWithNoTests/);
    }
  });

  test('every test file in the repo is collected by exactly one registered command', async () => {
    const { commandFor } = await import('../../../packages/config/test-patterns.ts');
    const files = allTestFiles();
    expect(files.length).toBeGreaterThan(10);
    const orphans = files.filter((f) => commandFor(f) === null);
    expect(orphans, 'test files no command runs').toEqual([]);
    // probes: names that previously slipped through every command
    for (const probe of ['tests/tasks/PW-099/a.test.tsx', 'tests/misc.test.ts', 'packages/domain/src/d.test.tsx']) expect(commandFor(probe), probe).toBe('unit');
    expect(commandFor('tests/tasks/PW-012/x.contract.test.ts')).toBe('contracts');
    expect(commandFor('apps/api/src/x/c.contract.test.ts')).toBe('contracts');
    expect(commandFor('tests/tasks/PW-099/e.test.mjs')).toBeNull();
  });

  test('integration tests fail loudly (not skip) when PostgreSQL is unavailable', async () => {
    const { requireTestDatabaseUrl } = await import('../../../packages/config/src/test-db.ts');
    expect(() => requireTestDatabaseUrl({})).toThrow(/PW_TEST_DATABASE_URL/);
    expect(() => requireTestDatabaseUrl({ PW_TEST_DATABASE_URL: 'postgres://u@localhost/pw_prod' })).toThrow(/test database/);
    expect(requireTestDatabaseUrl({ PW_TEST_DATABASE_URL: 'postgres://u@localhost:54329/pw_test' })).toContain('pw_test');
    expect(requireTestDatabaseUrl({ PW_TEST_DATABASE_URL: 'postgres://u@x:5432/pw_test?host=/tmp/sock' })).toContain('pw_test');
    expect(() => requireTestDatabaseUrl({ PW_TEST_DATABASE_URL: 'postgres://u@db.example.com:5432/pw_test' })).toThrow(/non-local/);
  });
});
