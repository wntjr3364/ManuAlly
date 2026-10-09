#!/usr/bin/env node
/* global process, setTimeout */
// Test stand-in for the Claude Code CLI (`claude -p --output-format stream-json …`). No network.
// It behaves like the documented CLI where the adapter depends on it:
// - an explicit --session-id creates a session in CLAUDE_CONFIG_DIR; --resume <id> continues it
// - the prompt arrives on stdin; the answer mentions the previous prompt of a resumed session
// - an unknown flag is an error; a profile without a login marker answers "not logged in"
// Test controls are files in the profile (the adapter passes no other environment): `report-other`
// (report a different session id), `delay-ms` (wait before answering).
// It also records what it saw (argv, env names, cwd) in $HOME/seen.json, so tests can check that the
// adapter passed nothing else.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const home = process.env.HOME;
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
fs.writeFileSync(path.join(home, 'seen.json'), JSON.stringify({ args, env: Object.keys(process.env).sort(), cwd: process.cwd(), home, config: process.env.CLAUDE_CONFIG_DIR }));
if (args.includes('--continue') || args.includes('-c')) { process.stderr.write('fake: --continue used\n'); process.exit(3); }
const profile = process.env.CLAUDE_CONFIG_DIR;
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const sessions = path.join(profile, 'fake-sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const id = get('--session-id') ?? get('--resume');
  const file = path.join(sessions, `${id}.json`);
  if (!fs.existsSync(path.join(profile, 'logged-in'))) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in · Please run /login', session_id: id });
    process.exit(1);
  }
  if (process.env.ANTHROPIC_API_KEY) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API key used', session_id: id }); process.exit(1); }
  let history = [];
  if (get('--resume')) {
    if (!fs.existsSync(file)) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${id}` }); process.exit(1); }
    history = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else if (fs.existsSync(file)) { process.stderr.write(`Session ID ${id} is already in use\n`); process.exit(1); }
  history.push(input.trim());
  fs.writeFileSync(file, JSON.stringify(history));
  out({ type: 'system', subtype: 'init', session_id: fs.existsSync(path.join(profile, 'report-other')) ? fs.readFileSync(path.join(profile, 'report-other'), 'utf8').trim() : id, tools: [], mcp_servers: [], model: 'fake-model', permissionMode: get('--permission-mode') });
  const prev = history.length > 1 ? ` (previous: ${history.at(-2)})` : '';
  const delay = fs.existsSync(path.join(profile, 'delay-ms')) ? Number(fs.readFileSync(path.join(profile, 'delay-ms'), 'utf8')) : 0;
  setTimeout(() => {
    out({ type: 'assistant', session_id: id, message: { content: [{ type: 'text', text: `turn ${history.length}: ${input.trim()}${prev}` }], usage: { input_tokens: 12, output_tokens: 5 } } });
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 12, output_tokens: 5 }, session_id: id });
  }, delay);
});
