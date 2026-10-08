// PW-002 — TST-002A / TST-002B
// Run: node --test 'tests/tasks/PW-002/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadRegistry,
  validateRegistry,
  decideModelCall,
  planAuthProvision,
  probeCliVersion,
  checkCodexRpcPolicy,
  loadCodexInventory,
  loadCodexRpcPolicy,
} from '../../../spikes/provider-admission/admission.mjs';

const registry = loadRegistry();

test('TST-002A: every provider/auth/deployment entry has admission, sources, checked date and test status', () => {
  assert.deepEqual(validateRegistry(registry), []);
  const combos = new Set(registry.entries.map((e) => `${e.capability.provider}/${e.capability.auth_mode}/${e.capability.deployment_profile}`));
  for (const needed of [
    'claude_agent/subscription_cli_login/PERSONAL_LOCAL',
    'claude_agent/subscription_cli_login/PRIVATE_SELF_HOSTED',
    'claude_agent/subscription_cli_login/MULTIUSER_HOSTED',
    'claude_agent/api_key/PERSONAL_LOCAL',
    'codex/chatgpt_login/PERSONAL_LOCAL',
    'codex/chatgpt_login/PRIVATE_SELF_HOSTED',
    'codex/chatgpt_login/MULTIUSER_HOSTED',
    'codex/api_key/PERSONAL_LOCAL',
    'mock/none/PERSONAL_LOCAL',
  ]) assert.ok(combos.has(needed), needed);
});

test('TST-002A: validator rejects missing evidence, bad enums and unverified "verified" claims', () => {
  const broken = structuredClone(registry);
  delete broken.entries[1].evidence.checked_at;
  broken.entries[2].capability.admission = 'yes';
  // a feature marked verified without live evidence must be rejected
  broken.entries[3].capability.features.interrupt = 'verified';
  const errors = validateRegistry(broken);
  assert.ok(errors.some((e) => e.includes('checked_at')));
  assert.ok(errors.some((e) => e.includes('admission')));
  assert.ok(errors.some((e) => e.includes('verified without live evidence')));
});

test('TST-002A: multi-user hosting and API-key modes are disabled', () => {
  for (const e of registry.entries) {
    if (e.capability.deployment_profile === 'MULTIUSER_HOSTED') assert.equal(e.capability.admission, 'disabled');
    if (e.capability.auth_mode === 'api_key') assert.equal(e.capability.admission, 'disabled');
  }
});

test('TST-002B: no real provider may be called before live admission + user approval', () => {
  for (const e of registry.entries) {
    const c = e.capability;
    const d = decideModelCall(registry, { provider: c.provider, auth_mode: c.auth_mode, deployment_profile: c.deployment_profile, userApprovedUsage: true });
    if (c.provider === 'mock') assert.equal(d.allowed, true);
    else assert.equal(d.allowed, false, `${c.provider}/${c.auth_mode}/${c.deployment_profile}`);
  }
  // even mock is denied for unknown combinations
  assert.equal(decideModelCall(registry, { provider: 'claude_agent', auth_mode: 'stolen_cookie', deployment_profile: 'PERSONAL_LOCAL', userApprovedUsage: true }).allowed, false);
});

test('TST-002B: credential copying, cookie extraction and implicit session reuse are refused', () => {
  for (const mode of ['copy_existing_credentials', 'share_dev_home', 'browser_cookie', 'reuse_latest_session']) {
    assert.throws(() => planAuthProvision({ provider: 'claude_agent', mode }), /refused/);
  }
  const ok = planAuthProvision({ provider: 'claude_agent', mode: 'isolated_login', profileDir: '/srv/pw/auth/claude' });
  assert.equal(ok.env.CLAUDE_CONFIG_DIR, '/srv/pw/auth/claude');
  assert.match(ok.user_action, /login/);
  const codex = planAuthProvision({ provider: 'codex', mode: 'isolated_login', profileDir: '/srv/pw/auth/codex' });
  assert.equal(codex.env.CODEX_HOME, '/srv/pw/auth/codex');
  assert.throws(() => planAuthProvision({ provider: 'claude_agent', mode: 'isolated_login', profileDir: path.join(os.homedir(), '.claude') }), /refused/);
  assert.throws(() => planAuthProvision({ provider: 'codex', mode: 'isolated_login', profileDir: path.join(os.homedir(), '.codex') }), /refused/);
});

test('TST-002B: CLI probe only asks for --version, with a scrubbed HOME and no API keys', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw002-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'argv.log');
  const fake = path.join(dir, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv: process.argv.slice(2), home: process.env.HOME, key: process.env.ANTHROPIC_API_KEY || null, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN || null}) + '\\n');
console.log('9.9.9 (fake)');
`);
  fs.chmodSync(fake, 0o755);
  const parentHome = path.join(dir, 'real-home');
  fs.mkdirSync(path.join(parentHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(parentHome, '.claude', '.credentials.json'), 'SENTINEL');
  const result = probeCliVersion(fake, { parentEnv: { PATH: process.env.PATH, HOME: parentHome, ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CODE_OAUTH_TOKEN: 'tok' } });
  assert.equal(result.version, '9.9.9 (fake)');
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['--version']);
  assert.notEqual(calls[0].home, parentHome);
  assert.equal(calls[0].key, null);
  assert.equal(calls[0].oauth, null);
  assert.equal(fs.readFileSync(path.join(parentHome, '.claude', '.credentials.json'), 'utf8'), 'SENTINEL');
});

test('TST-002B: Codex RPC policy only allows methods present in the pinned schema and blocks dangerous surfaces', () => {
  const inventory = loadCodexInventory();
  const policy = loadCodexRpcPolicy();
  assert.deepEqual(checkCodexRpcPolicy(inventory, policy), []);
  for (const m of ['thread/shellCommand', 'command/exec', 'fs/writeFile', 'account/rateLimitResetCredit/consume', 'account/sendAddCreditsNudgeEmail', 'account/login/start', 'feedback/upload', 'config/value/write']) {
    assert.ok(!policy.client_request_allowlist.includes(m), m);
  }
  // every server-initiated approval request must be auto-declined
  for (const m of inventory.server_requests) assert.ok(policy.server_request_handling[m], `no handling for ${m}`);
  assert.equal(policy.server_request_handling['item/commandExecution/requestApproval'], 'decline');
  // a policy naming a method absent from the pinned schema is an error (schema drift)
  const drifted = structuredClone(policy);
  drifted.client_request_allowlist.push('thread/doesNotExist');
  assert.ok(checkCodexRpcPolicy(inventory, drifted).some((e) => e.includes('thread/doesNotExist')));
});

// ---------- added after the independent P00 review (M4, M5) ----------
import { assertSafeProfileDir } from '../../../spikes/provider-admission/admission.mjs';

test('TST-002B: profile dirs that alias the developer config (symlink, HOME itself, parent of HOME) are refused', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw002-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'));
  fs.symlinkSync(path.join(home, '.claude'), path.join(root, 'innocent-looking'));
  const ok = path.join(root, 'runtime-auth');
  fs.mkdirSync(ok, { mode: 0o700 });
  for (const bad of [path.join(root, 'innocent-looking'), home, root, path.join(home, '.codex', 'sub'), path.join(home, '.claude.json'), 'relative/path']) {
    assert.throws(() => assertSafeProfileDir(bad, { homes: [home] }), /refused/, bad);
  }
  fs.chmodSync(ok, 0o777);
  assert.throws(() => assertSafeProfileDir(ok, { homes: [home] }), /refused/, 'group/world-writable profile dir');
  fs.chmodSync(ok, 0o700);
  assert.equal(assertSafeProfileDir(ok, { homes: [home] }), fs.realpathSync(ok));
});

test('TST-002B: a real provider also needs an isolated auth sentinel result before any call (M5)', () => {
  const approved = structuredClone(registry);
  const entry = approved.entries.find((e) => e.capability.provider === 'codex' && e.capability.deployment_profile === 'PERSONAL_LOCAL' && e.capability.auth_mode === 'chatgpt_login');
  entry.capability.admission = 'approved';
  entry.evidence.live_evidence = { note: 'hypothetical, test only' };
  const req = { provider: 'codex', auth_mode: 'chatgpt_login', deployment_profile: 'PERSONAL_LOCAL', userApprovedUsage: true };
  assert.equal(decideModelCall(approved, req).allowed, false, 'no sentinel');
  assert.equal(decideModelCall(approved, { ...req, authSentinel: { provider: 'codex', status: 'leak' } }).allowed, false, 'leak');
  assert.equal(decideModelCall(approved, { ...req, authSentinel: { provider: 'codex', status: 'unknown' } }).allowed, false, 'unknown');
  assert.equal(decideModelCall(approved, { ...req, authSentinel: { provider: 'claude_agent', status: 'isolated' } }).allowed, false, 'sentinel for another provider');
  assert.equal(decideModelCall(approved, { ...req, authSentinel: { provider: 'codex', status: 'isolated' } }).allowed, true);
});
