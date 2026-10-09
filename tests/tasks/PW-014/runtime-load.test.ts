// PW-014 — the API and worker sources load under the runtime they are started with in development
// (node --experimental-strip-types). Vitest transpiles everything, so without this test a syntax that
// only works when compiled (e.g. TypeScript parameter properties) breaks `pnpm dev` unnoticed.
import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

describe('dev runtime', () => {
  test.each(['apps/api/src/server.ts', 'apps/worker/src/queue/index.ts', 'packages/editor-core/src/index.ts'])('%s loads with node --experimental-strip-types', (file) => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', `import(${JSON.stringify(path.resolve(file))}).then(() => console.log('ok'))`], { encoding: 'utf8', timeout: 60_000 });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('ok');
  }, 60_000);
});
