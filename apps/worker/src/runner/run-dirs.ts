// Run folders (PW-026; P00 PW-004 prepareRun, reviewed twice). One folder per provider run, never
// reused, below a runs root the runtime user owns and nobody else can write; inside it private work,
// home and tmp folders, and read-only copies of exactly the selected input files. An input that is a
// symlink, has other hard links, leaves its source root, or changes while it is checked is refused,
// and a refused run leaves nothing behind. Runs never live below agent instruction files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const refuse = (m: string): never => { throw new Error(`refused: ${m}`); };
const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
const AGENT_CONFIG_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude', '.mcp.json', '.codex'];

export interface Run { id: string; dir: string; cwd: string; homeDir: string; tmpDir: string; inputsDir: string }
export interface InputFile { sourceRoot: string; relPath: string }

function assertNoAgentConfigAbove(dir: string): void {
  let d = path.resolve(dir);
  for (;;) {
    for (const n of AGENT_CONFIG_NAMES) if (fs.existsSync(path.join(d, n))) refuse(`${path.join(d, n)}: runs must not live below agent instructions`);
    const parent = path.dirname(d);
    if (parent === d) return;
    d = parent;
  }
}

export function assertSafeRunsRoot(runsRoot: string): string {
  if (!path.isAbsolute(runsRoot)) refuse('runs root must be absolute');
  assertNoAgentConfigAbove(runsRoot);
  if (!fs.existsSync(runsRoot)) {
    fs.mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(runsRoot, 0o700);
  }
  const st = fs.lstatSync(runsRoot);
  if (st.isSymbolicLink() || !st.isDirectory()) refuse(`runs root ${runsRoot} must be a real directory`);
  if (st.mode & 0o022) refuse(`runs root ${runsRoot} is group/world-writable`);
  if (process.getuid && st.uid !== process.getuid()) refuse(`runs root ${runsRoot} is not owned by the runtime user`);
  return fs.realpathSync(runsRoot);
}

// Where runs live without sudo: $XDG_RUNTIME_DIR (private, outside HOME), else a private tmp folder.
export function defaultRunsRoot(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? 0, tmp = os.tmpdir()): string {
  const x = env.XDG_RUNTIME_DIR;
  if (x && path.isAbsolute(x)) {
    const st = fs.lstatSync(x, { throwIfNoEntry: false });
    if (st && st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o077) === 0) return path.join(x, 'paper-workspace', 'runs');
  }
  const parent = path.join(tmp, `paper-workspace-${uid}`);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
  const st = fs.lstatSync(parent);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid || st.mode & 0o077) refuse(`${parent} is not a private folder of this user`);
  return path.join(parent, 'runs');
}

function copyInput(run: Run, { sourceRoot, relPath }: InputFile): void {
  if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) refuse(`input path must be relative without '..': ${relPath}`);
  const rootReal = fs.realpathSync(sourceRoot);
  const candidate = path.join(rootReal, relPath);
  const st = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!st) refuse(`input does not exist: ${relPath}`);
  if (st!.isSymbolicLink()) refuse(`input is a symlink: ${relPath}`);
  if (!st!.isFile()) refuse(`input is not a regular file: ${relPath}`);
  if (st!.nlink > 1) refuse(`input has ${st!.nlink} hard links and may alias a file outside the source root: ${relPath}`);
  const real = fs.realpathSync(candidate);
  if (real !== candidate || !within(real, rootReal)) refuse(`input resolves outside its source root: ${relPath}`);
  const fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const fst = fs.fstatSync(fd);
    if (fst.ino !== st!.ino || fst.dev !== st!.dev || !fst.isFile()) refuse(`input changed while it was being checked: ${relPath}`);
    fs.writeFileSync(path.join(run.inputsDir, relPath.replaceAll(/[\\/]/g, '__')), fs.readFileSync(fd), { flag: 'wx', mode: 0o444 });
  } finally {
    fs.closeSync(fd);
  }
}

export function prepareRun(a: { runsRoot: string; runId: string; inputs?: InputFile[] }): Run {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(a.runId)) refuse(`invalid run id ${a.runId}`);
  const root = assertSafeRunsRoot(a.runsRoot);
  const dir = path.join(root, a.runId);
  fs.mkdirSync(dir, { mode: 0o700 }); // EEXIST: runs are never reused
  const run: Run = { id: a.runId, dir, cwd: path.join(dir, 'work'), homeDir: path.join(dir, 'home'), tmpDir: path.join(dir, 'tmp'), inputsDir: path.join(dir, 'inputs') };
  try {
    for (const d of [run.cwd, run.homeDir, run.tmpDir, run.inputsDir]) fs.mkdirSync(d, { mode: 0o700 });
    for (const input of a.inputs ?? []) copyInput(run, input);
    fs.chmodSync(run.inputsDir, 0o555);
  } catch (e) {
    fs.chmodSync(run.inputsDir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return run;
}

export function removeRun(run: Run): void {
  if (fs.existsSync(run.inputsDir)) fs.chmodSync(run.inputsDir, 0o700);
  fs.rmSync(run.dir, { recursive: true, force: true });
}
