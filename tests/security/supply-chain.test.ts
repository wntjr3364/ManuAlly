// PW-059 security audit — supply chain (spec 09 "공급망과 운영": lockfile, license allowlist; constitution:
// no latest tags). The production dependency closure is read from pnpm itself.
// TST-059A: every production dependency has a license on the allowlist; no dependency is taken from "latest",
//   "*", git or a URL; the lockfile is tracked.
import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// permissive licenses (no copyleft obligation on the app). System programs the app starts as separate
// processes (LibreOffice MPL-2.0, poppler GPL, bubblewrap LGPL, PostgreSQL) are not linked and are listed in
// the audit report, not here.
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', '(MIT OR CC0-1.0)', 'Unlicense', 'Python-2.0']);

describe('TST-059A: supply chain', () => {
  test('every production dependency is under an allowed license', () => {
    const out = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], { encoding: 'utf8', timeout: 120_000 });
    const byLicense = JSON.parse(out) as Record<string, { name: string; versions: string[] }[]>;
    const total = Object.values(byLicense).reduce((n, xs) => n + xs.length, 0);
    expect(total).toBeGreaterThan(50);
    const bad = Object.entries(byLicense).filter(([l]) => !ALLOWED.has(l)).flatMap(([l, xs]) => xs.map((x) => `${x.name}@${x.versions.join('/')}: ${l}`));
    expect(bad).toEqual([]);
  });
  test('no dependency comes from latest, *, git or a URL; the lockfile is tracked', () => {
    const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n');
    expect(tracked).toContain('pnpm-lock.yaml');
    const manifests = tracked.filter((f) => /(^|\/)package\.json$/.test(f) && !f.includes('node_modules'));
    expect(manifests.length).toBeGreaterThan(3);
    for (const f of manifests) {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')) as Record<string, Record<string, string> | undefined>;
      for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [name, spec] of Object.entries(pkg[kind] ?? {})) {
          expect(spec, `${f} ${kind} ${name}`).not.toMatch(/^(latest|\*|x)$|^(git\+|git:|github:|https?:|file:)/);
        }
      }
    }
  });
});
