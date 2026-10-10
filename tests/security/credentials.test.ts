// PW-059 audit finding F-01: the login profile whose credential file is bound into every AI run must not be
// the developer's own CLI state (~/.claude, ~/.codex) or a home folder (constitution: no sharing of existing
// home or credential directories; RFC-010: a separate runtime login profile).
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareStateDir, StateRefused } from '../../apps/worker/src/provider-runs/index.ts';

function world() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pw059-cred-'));
  const home = path.join(base, 'home');
  const state = path.join(base, 'state');
  for (const d of [home, path.join(home, '.claude'), path.join(home, '.codex'), path.join(base, 'runtime-profile')]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const f of [path.join(home, '.claude', '.credentials.json'), path.join(home, '.codex', 'auth.json'), path.join(base, 'runtime-profile', '.credentials.json'), path.join(home, '.credentials.json')]) fs.writeFileSync(f, '{"synthetic":true}', { mode: 0o600 });
  return { base, home, state };
}

describe('F-01: the run\'s login profile is never the developer\'s CLI state', () => {
  test('~/.claude, ~/.codex, a folder inside them, or the home folder itself is refused; a separate runtime profile is used', () => {
    const w = world();
    try {
      const paper = randomUUID();
      for (const bad of [path.join(w.home, '.claude'), path.join(w.home, '.codex'), w.home]) {
        const provider = bad.endsWith('.codex') ? 'codex' : 'claude_agent';
        expect(() => prepareStateDir(w.state, provider, paper, bad, [w.home]), bad).toThrow(StateRefused);
      }
      const ok = prepareStateDir(w.state, 'claude_agent', paper, path.join(w.base, 'runtime-profile'), [w.home]);
      expect(ok.binds).toEqual([{ source: path.join(fs.realpathSync(w.base), 'runtime-profile', '.credentials.json'), target: path.join(ok.dir, '.credentials.json') }]);
    } finally {
      fs.rmSync(w.base, { recursive: true, force: true });
    }
  });
  test('a symlink to the developer\'s state is refused too', () => {
    const w = world();
    try {
      const link = path.join(w.base, 'looks-separate');
      fs.symlinkSync(path.join(w.home, '.claude'), link);
      expect(() => prepareStateDir(w.state, 'claude_agent', randomUUID(), link, [w.home])).toThrow(StateRefused);
    } finally {
      fs.rmSync(w.base, { recursive: true, force: true });
    }
  });
});
