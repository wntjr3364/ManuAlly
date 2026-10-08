#!/usr/bin/env node
// Fake provider CLI for PW-004. Records what it was given, emits stream-json events shaped like
// the documented Claude Code `-p --output-format stream-json` output, and can simulate a long turn.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const record = {
  argv: args,
  cwd: process.cwd(),
  env: process.env,
  pid: process.pid,
};
fs.writeFileSync(path.join(process.cwd(), 'fake-cli-record.json'), JSON.stringify(record));

const idx = (flag) => args.indexOf(flag);
const sessionId = idx('--session-id') >= 0 ? args[idx('--session-id') + 1] : args[idx('--resume') + 1];
const mode = process.env.FAKE_MODE || 'normal';

// touch the input copy to prove writes stay inside the run directory
const inputs = path.resolve(process.cwd(), '..', 'inputs');
if (fs.existsSync(inputs)) {
  for (const f of fs.readdirSync(inputs)) {
    try { fs.appendFileSync(path.join(inputs, f), 'tamper'); } catch { /* read-only copy */ }
  }
}

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
emit({ type: 'system', subtype: 'init', session_id: mode === 'wrong_session' ? '00000000-0000-4000-8000-000000000000' : sessionId, tools: [], mcp_servers: [] });

if (mode === 'long') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(process.cwd(), 'grandchild.pid'), String(grandchild.pid));
  process.on('SIGINT', () => {
    emit({ type: 'result', subtype: 'error_during_execution', session_id: sessionId, is_error: true, result: 'interrupted' });
    process.exit(130);
  });
  setInterval(() => {}, 1000);
} else {
  emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'proposal' }] } });
  emit({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false, result: 'proposal', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.0001 });
}
