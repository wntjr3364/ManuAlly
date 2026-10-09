// The run folder of a provider run (PW-024 review; P00 PW-004 prepareRun/assertSafeRunsRoot). Until the
// isolated runner (PW-026) prepares folders, this layer still refuses folders it cannot trust:
//   * the run folder is the runtime user's own, private (no group/other permissions), not a symlink,
//     and its parent (the runs root) is the user's own and not group/world-writable
//   * work, home and tmp folders are private folders inside it
//   * the MCP config (it can start any stdio server) is a regular file inside it, the user's own, not
//     writable by others, and a JSON object with only `mcpServers`
import fs from 'node:fs';
import path from 'node:path';
import { Refused } from './args.ts';

const refuse = (m: string): never => { throw new Refused(m); };
const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

function privateDir(p: string, uid: number | null, what: string): string {
  if (!path.isAbsolute(p)) refuse(`${what} must be an absolute path`);
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!st) refuse(`${what} ${p} is missing`);
  if (st!.isSymbolicLink() || !st!.isDirectory()) refuse(`${what} ${p} must be a real folder`);
  if (uid !== null && st!.uid !== uid) refuse(`${what} ${p} is not the runtime user's own`);
  if (st!.mode & 0o077) refuse(`${what} ${p} must be private (mode 700)`);
  return fs.realpathSync(p);
}

export function assertPrivateRunFolder(run: { dir: string; cwd: string; homeDir: string; tmpDir: string; mcpConfigPath?: string }, ownerUid: number | null = process.getuid?.() ?? null): void {
  const dir = privateDir(run.dir, ownerUid, 'run folder');
  const root = path.dirname(dir);
  const rst = fs.lstatSync(root);
  if (rst.isSymbolicLink() || (ownerUid !== null && rst.uid !== ownerUid) || rst.mode & 0o022) refuse(`runs root ${root} must be the runtime user's own and not writable by others`);
  for (const [p, what] of [[run.cwd, 'work folder'], [run.homeDir, 'home folder'], [run.tmpDir, 'tmp folder']] as const) {
    const real = privateDir(p, ownerUid, what);
    if (!within(real, dir) || real === dir) refuse(`${what} ${p} must be inside the run folder`);
  }
  if (run.mcpConfigPath !== undefined) {
    const p = run.mcpConfigPath;
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || !st.isFile()) refuse(`MCP config ${p} must be a regular file`);
    if (!within(fs.realpathSync(p), dir)) refuse(`--mcp-config ${p} is outside the run directory`);
    if ((ownerUid !== null && st!.uid !== ownerUid) || st!.mode & 0o022) refuse(`MCP config ${p} must be the runtime user's own and not writable by others`);
    let cfg: unknown;
    try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { refuse(`MCP config ${p} is not JSON`); }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || Object.keys(cfg as object).some((k) => k !== 'mcpServers')) refuse(`MCP config ${p} may only hold mcpServers`);
  }
}
