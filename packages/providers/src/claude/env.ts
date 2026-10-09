// Environment and auth profile for a Claude run (PW-024; P00 PW-002/004, RFC-004).
// The child gets a fresh HOME/TMPDIR in the run folder and a whitelisted environment: nothing is
// inherited (no ANTHROPIC_API_KEY — it would silently replace the subscription login — no DB URLs,
// sockets or tokens). Auth comes only from a runtime profile folder the user logged into for this
// purpose; it must not be, contain or alias the developer's ~/.claude, ~/.claude.json, ~/.codex or HOME,
// must be the runtime user's own, not group/world-writable, and hold no links to files elsewhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Refused } from './args.ts';

const refuse = (m: string): never => { throw new Refused(m); };
const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
const realOrNull = (p: string) => { try { return fs.realpathSync(p); } catch { return null; } };

function assertNoLinksInside(dir: string, depth = 0): void {
  if (depth > 8) refuse(`profile dir nesting too deep at ${dir}`);
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) refuse(`profile contains a symlink ${p}`);
    if (st.isFile() && st.nlink > 1) refuse(`profile file ${p} has a hard link elsewhere`);
    if (st.isDirectory()) assertNoLinksInside(p, depth + 1);
  }
}

export function assertSafeProfileDir(dir: string, opts: { homes?: string[]; ownerUid?: number | null } = {}): string {
  const homes = opts.homes ?? [os.homedir()];
  const ownerUid = opts.ownerUid === undefined ? (process.getuid?.() ?? null) : opts.ownerUid;
  if (!dir || !path.isAbsolute(dir)) refuse('profile dir must be an absolute path');
  const resolved = path.resolve(dir);
  const st = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!st) refuse(`profile dir ${resolved} does not exist`);
  if (st!.isSymbolicLink()) refuse(`profile dir ${resolved} is a symlink`);
  if (!st!.isDirectory()) refuse(`profile dir ${resolved} is not a directory`);
  if (st!.mode & 0o022) refuse(`profile dir ${resolved} is group/world-writable`);
  if (ownerUid !== null && st!.uid !== ownerUid) refuse(`profile dir ${resolved} is not owned by the runtime user`);
  const real = fs.realpathSync(resolved);
  for (const home of homes) {
    const homeForms = new Set([path.resolve(home), realOrNull(home)].filter((x): x is string => !!x));
    for (const h of homeForms) {
      for (const c of [resolved, real]) {
        if (within(h, c)) refuse(`${resolved} is or contains the home directory ${h}`);
        for (const rel of ['.claude', '.claude.json', '.codex', path.join('.config', 'claude')]) {
          for (const d of [path.join(h, rel), realOrNull(path.join(h, rel))]) if (d && within(c, d)) refuse(`${resolved} is inside developer CLI state ${d}`);
        }
      }
    }
  }
  assertNoLinksInside(real);
  return real;
}

export interface ClaudeRun { dir: string; cwd: string; homeDir: string; tmpDir: string; mcpConfigPath: string }

export function buildClaudeEnv(a: { profileDir: string; run: ClaudeRun; parentEnv?: Record<string, string | undefined>; homes?: string[]; ownerUid?: number | null }): Record<string, string> {
  const profile = assertSafeProfileDir(a.profileDir, { homes: a.homes, ownerUid: a.ownerUid });
  const parent = a.parentEnv ?? process.env;
  return {
    PATH: parent.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: a.run.homeDir,
    TMPDIR: a.run.tmpDir,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    CLAUDE_CONFIG_DIR: profile,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

const AGENT_CONFIG_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude', '.mcp.json', '.codex'];
// The CLI loads instruction files from the working folder and its parents: a run never lives below one.
export function assertNoAgentConfigAbove(dir: string): void {
  let d = path.resolve(dir);
  for (;;) {
    for (const n of AGENT_CONFIG_NAMES) if (fs.existsSync(path.join(d, n))) refuse(`${path.join(d, n)}: a run must not live below agent instructions`);
    const parent = path.dirname(d);
    if (parent === d) return;
    d = parent;
  }
}
