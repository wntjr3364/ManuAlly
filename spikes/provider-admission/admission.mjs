// PW-002 provider admission spike.
// Decides which provider/auth/deployment combinations may run, and refuses
// every shortcut that would reuse the developer's own CLI credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

export const loadRegistry = () => readJson(path.join(here, 'registry.json'));
export const loadCodexInventory = () => readJson(path.join(here, 'codex-app-server-0.161.0.inventory.json'));
export const loadCodexRpcPolicy = () => readJson(path.join(here, 'codex-rpc-policy.json'));
const loadCapabilitySchema = () => readJson(path.join(repoRoot, 'contracts/provider_capability.schema.json'));

const TEST_STATUSES = new Set(['n/a', 'not_applicable', 'not_run_live', 'schema_inventory_only', 'live_smoke_passed', 'live_smoke_failed']);

// Minimal structural validation against the starter contract (no jsonschema dependency in P00).
export function validateRegistry(registry, schema = loadCapabilitySchema()) {
  const errors = [];
  const props = schema.properties;
  const featureEnum = props.features.properties.explicit_resume.enum;
  const seen = new Set();
  registry.entries.forEach((entry, i) => {
    const c = entry.capability || {};
    const where = `entries[${i}]`;
    for (const key of schema.required) if (c[key] === undefined) errors.push(`${where}: missing capability.${key}`);
    for (const key of Object.keys(c)) if (!props[key]) errors.push(`${where}: unknown capability field ${key}`);
    if (!props.provider.enum.includes(c.provider)) errors.push(`${where}: invalid provider ${c.provider}`);
    if (!props.deployment_profile.enum.includes(c.deployment_profile)) errors.push(`${where}: invalid deployment_profile`);
    if (!props.admission.enum.includes(c.admission)) errors.push(`${where}: invalid admission ${c.admission}`);
    for (const f of props.features.required) {
      const v = c.features?.[f];
      if (!featureEnum.includes(v)) errors.push(`${where}: invalid feature ${f}=${v}`);
    }
    const ev = entry.evidence || {};
    for (const key of ['sources', 'checked_at', 'test_status', 'user_decision']) if (ev[key] === undefined || ev[key] === '') errors.push(`${where}: missing evidence.${key}`);
    if (ev.sources && (!Array.isArray(ev.sources) || ev.sources.length === 0)) errors.push(`${where}: evidence.sources must be a non-empty list`);
    if (ev.test_status && !TEST_STATUSES.has(ev.test_status)) errors.push(`${where}: invalid test_status ${ev.test_status}`);
    const live = ev.live_evidence;
    if (c.features) for (const [f, v] of Object.entries(c.features)) if (v === 'verified' && !live) errors.push(`${where}: feature ${f} marked verified without live evidence`);
    if (c.admission === 'approved' && c.provider !== 'mock' && !live) errors.push(`${where}: admission approved without live evidence`);
    const key = `${c.provider}/${c.auth_mode}/${c.deployment_profile}`;
    if (seen.has(key)) errors.push(`${where}: duplicate combination ${key}`);
    seen.add(key);
  });
  return errors;
}

// The only gate in front of a model call. Unknown combinations are denied.
export function decideModelCall(registry, { provider, auth_mode, deployment_profile, userApprovedUsage }) {
  const entry = registry.entries.find((e) => e.capability.provider === provider && e.capability.auth_mode === auth_mode && e.capability.deployment_profile === deployment_profile);
  if (!entry) return { allowed: false, reason: 'unregistered provider/auth/deployment combination' };
  if (entry.capability.admission !== 'approved') return { allowed: false, reason: `admission is ${entry.capability.admission}` };
  if (provider !== 'mock' && !entry.evidence.live_evidence) return { allowed: false, reason: 'no live evidence recorded' };
  if (provider !== 'mock' && !userApprovedUsage) return { allowed: false, reason: 'user has not approved usage for this run' };
  return { allowed: true, reason: provider === 'mock' ? 'mock provider' : 'admitted' };
}

const REFUSED_MODES = {
  copy_existing_credentials: 'copying the developer CLI credential files',
  share_dev_home: 'sharing the developer HOME/config directory',
  browser_cookie: 'extracting browser cookies',
  reuse_latest_session: 'attaching to the latest existing CLI session',
};

function devConfigDirs(home = os.homedir()) {
  return [path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, '.config', 'claude')];
}

// Describes how a runtime auth profile is created. The user performs the login;
// the platform never reads or copies existing credentials.
export function planAuthProvision({ provider, mode, profileDir }) {
  if (REFUSED_MODES[mode]) throw new Error(`refused: ${REFUSED_MODES[mode]}`);
  if (mode !== 'isolated_login') throw new Error(`refused: unknown auth provisioning mode ${mode}`);
  if (!profileDir || !path.isAbsolute(profileDir)) throw new Error('refused: profileDir must be an absolute path');
  const resolved = path.resolve(profileDir);
  for (const dev of devConfigDirs()) {
    if (resolved === dev || resolved.startsWith(dev + path.sep)) throw new Error(`refused: ${resolved} is the developer CLI config directory`);
  }
  if (provider === 'claude_agent') {
    return {
      env: { CLAUDE_CONFIG_DIR: resolved },
      user_action: `Run once as the runtime OS user: CLAUDE_CONFIG_DIR=${resolved} claude  → /login (or store a \`claude setup-token\` value in the server secret file)`,
    };
  }
  if (provider === 'codex') {
    return { env: { CODEX_HOME: resolved }, user_action: `Run once as the runtime OS user: CODEX_HOME=${resolved} codex login` };
  }
  throw new Error(`refused: unknown provider ${provider}`);
}

// Asks a CLI for its version only. The child never sees the parent's HOME,
// credentials or API keys, and never receives a prompt.
export function probeCliVersion(bin, { parentEnv = process.env } = {}) {
  const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-probe-home-'));
  const env = { PATH: parentEnv.PATH || '/usr/bin:/bin', HOME: scratchHome, LANG: 'C.UTF-8' };
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', env, timeout: 15000 });
  fs.rmSync(scratchHome, { recursive: true, force: true });
  if (r.error || r.status !== 0) return { found: false, version: null };
  const line = `${r.stdout}`.split('\n').find((l) => l.trim() && !l.startsWith('WARNING'));
  return { found: true, version: line ? line.trim() : null };
}

export function checkCodexRpcPolicy(inventory, policy) {
  const errors = [];
  const known = new Set(inventory.client_requests);
  for (const m of policy.client_request_allowlist) if (!known.has(m)) errors.push(`allowlisted method not in pinned schema: ${m}`);
  for (const m of Object.keys(policy.explicit_deny_examples)) {
    if (!known.has(m)) errors.push(`denied method not in pinned schema: ${m}`);
    if (policy.client_request_allowlist.includes(m)) errors.push(`method both allowed and denied: ${m}`);
  }
  const knownNotif = new Set(inventory.client_notifications);
  for (const m of policy.client_notification_allowlist) if (!knownNotif.has(m)) errors.push(`notification not in pinned schema: ${m}`);
  for (const m of inventory.server_requests) {
    const h = policy.server_request_handling[m];
    if (!h) errors.push(`server request without handling: ${m}`);
    else if (!['decline', 'route_to_tool_gateway'].includes(h)) errors.push(`invalid handling for ${m}: ${h}`);
  }
  if (policy.pinned_codex_cli_version !== inventory.codex_cli_version) errors.push('policy and inventory versions differ');
  if (policy.thread_defaults.sandbox !== 'read-only') errors.push('thread sandbox must be read-only');
  return errors;
}
