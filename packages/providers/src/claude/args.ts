// Claude Code CLI argv (PW-024; P00 PW-004 spike, ADR-013/014). Headless `-p` with stream-json, no
// built-in tools (`--tools ""`, `--restricted`), only the run's own MCP config (paper tool gateway),
// no permission prompts, no slash commands, and exactly one explicit session: a new id we chose
// (`--session-id`) or a stored id (`--resume`). `--continue`, a "latest" session or anything else is not
// allowlisted. The prompt goes through stdin, never argv.
import path from 'node:path';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class Refused extends Error {
  constructor(message: string) { super(`refused: ${message}`); }
}
const refuse = (m: string): never => { throw new Refused(m); };
const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const FLAGS: Record<string, ((v: string) => boolean) | null> = {
  '-p': null,
  '--output-format': (v) => v === 'stream-json',
  '--verbose': null,
  '--tools': (v) => v === '',
  '--strict-mcp-config': null,
  '--mcp-config': (v) => path.isAbsolute(v),
  '--allowedTools': (v) => v === 'mcp__paper',
  '--permission-mode': (v) => v === 'dontAsk',
  '--permission-prompts': (v) => v === 'none',
  '--disable-slash-commands': null,
  '--no-chrome': null,
  '--restricted': null,
  '--session-id': (v) => UUID_RE.test(v),
  '--resume': (v) => UUID_RE.test(v),
  '--effort': (v) => (EFFORTS as readonly string[]).includes(v),
  '--model': (v) => /^[a-z0-9][a-z0-9.-]{0,63}$/.test(v),
};
const REQUIRED = ['-p', '--output-format', '--tools', '--strict-mcp-config', '--mcp-config', '--allowedTools', '--permission-mode', '--permission-prompts', '--disable-slash-commands', '--restricted'];

export function assertSafeClaudeArgs(args: readonly string[], opts: { runDir?: string } = {}): readonly string[] {
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!Object.hasOwn(FLAGS, a)) refuse(`flag or argument ${JSON.stringify(a)} is not allowlisted`);
    if (seen.has(a)) refuse(`flag ${a} repeated`);
    seen.add(a);
    const check = FLAGS[a];
    if (check) {
      const v = args[++i];
      if (v === undefined || !check(v)) refuse(`invalid value for ${a}: ${JSON.stringify(v)}`);
      // an MCP config can start any stdio server: it must be the run's own file
      if (a === '--mcp-config' && opts.runDir && (v!.split(/[\\/]/).includes('..') || !within(path.resolve(v!), path.resolve(opts.runDir)))) refuse(`--mcp-config ${v} is outside the run directory`);
    }
  }
  for (const r of REQUIRED) if (!seen.has(r)) refuse(`required flag ${r} missing`);
  if (seen.has('--session-id') === seen.has('--resume')) refuse('exactly one of --session-id or --resume <uuid> is required');
  return args;
}

export type SessionChoice = { new: string } | { resume: string };

export function buildClaudeArgs(a: { session: SessionChoice; mcpConfigPath: string; effort?: (typeof EFFORTS)[number] | null; model?: string | null; extra?: never }): string[] {
  const s = a.session as { new?: unknown; resume?: unknown } | undefined;
  const id = s?.new ?? s?.resume;
  if (!s || id === undefined || (s.new !== undefined && s.resume !== undefined)) refuse('an explicit session (a new id or a stored id to resume) is required');
  if (typeof id !== 'string' || !UUID_RE.test(id)) refuse(`session id must be a uuid: ${JSON.stringify(id)}`);
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--restricted', '--strict-mcp-config',
    '--mcp-config', a.mcpConfigPath, '--allowedTools', 'mcp__paper', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--disable-slash-commands', '--no-chrome',
    ...(s!.new !== undefined ? ['--session-id', id as string] : ['--resume', id as string]),
  ];
  if (a.effort) args.push('--effort', a.effort);
  if (a.model) args.push('--model', a.model);
  const extra = (a as { extra?: unknown }).extra;
  if (Array.isArray(extra)) args.push(...extra.map(String)); // never used by the product: shows the allowlist refuses
  return [...assertSafeClaudeArgs(args)];
}
