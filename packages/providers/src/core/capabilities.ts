// Provider capability registry (PW-023, spec 07, ADR-007). One row per provider × version × auth mode
// × deployment profile, with seven features. What the product shows and allows:
//   verified    — checked live on the user's machine (evidence recorded)
//   unsupported — the provider does not offer it
//   unknown     — everything else, including "documented, not verified" (shown with that note)
// A feature is used only when verified. A provider/version/auth/deployment that is not in the registry
// is disabled with every feature unknown. Real providers are approved only with live evidence.
import registryFile from './registry.json' with { type: 'json' };

export const FEATURES = ['explicit_resume', 'structured_tools', 'interrupt', 'manual_compact', 'context_usage', 'quota_read', 'reset_at'] as const;
export type Feature = (typeof FEATURES)[number];
export type FeatureState = 'verified' | 'documented_not_verified' | 'unsupported' | 'unknown';
const STATES: FeatureState[] = ['verified', 'documented_not_verified', 'unsupported', 'unknown'];
const PROVIDERS = ['mock', 'claude_agent', 'codex'] as const;
const PROFILES = ['PERSONAL_LOCAL', 'PRIVATE_SELF_HOSTED', 'MULTIUSER_HOSTED'] as const;
const ADMISSIONS = ['disabled', 'requires_verification', 'approved'] as const;

export interface Capability {
  provider: (typeof PROVIDERS)[number];
  version: string;
  auth_mode: string;
  deployment_profile: (typeof PROFILES)[number];
  admission: (typeof ADMISSIONS)[number];
  features: Record<Feature, FeatureState>;
}
export interface RegistryEntry { capability: Capability; evidence: { live_evidence?: unknown; [k: string]: unknown } }
export interface Registry { entries: RegistryEntry[] }
export type CapabilityKey = Pick<Capability, 'provider' | 'version' | 'auth_mode' | 'deployment_profile'>;

export class CapabilityUnavailable extends Error {
  readonly feature: Feature;
  readonly state: FeatureState;
  constructor(feature: Feature, state: FeatureState) {
    super(`capability ${feature} is ${state === 'documented_not_verified' ? 'unknown (documented, not verified)' : state} for this provider; it is not used until verified`);
    this.feature = feature;
    this.state = state;
  }
}

function checkEntry(e: unknown, i: number): RegistryEntry {
  const bad = (m: string) => new Error(`registry entry ${i}: capability ${m}`);
  const c = (e as RegistryEntry)?.capability as Partial<Capability> | undefined;
  if (!c || typeof c !== 'object') throw bad('missing');
  if (!PROVIDERS.includes(c.provider as never)) throw bad('provider is not known');
  if (typeof c.version !== 'string' || !c.version || typeof c.auth_mode !== 'string' || !c.auth_mode) throw bad('version and auth_mode are required');
  if (!PROFILES.includes(c.deployment_profile as never)) throw bad('deployment_profile is not known');
  if (!ADMISSIONS.includes(c.admission as never)) throw bad('admission is not known');
  const f = c.features as Record<string, unknown> | undefined;
  if (!f || FEATURES.some((k) => !STATES.includes(f[k] as FeatureState)) || Object.keys(f).some((k) => !FEATURES.includes(k as Feature))) throw bad(`features must be exactly ${FEATURES.join(', ')} with a known state`);
  const ev = (e as RegistryEntry).evidence;
  if (!ev || typeof ev !== 'object') throw bad('evidence is required');
  // v1 policy (RFC-001, ADR-012): no hosted multi-user use and no API keys — those rows stay disabled
  if ((c.deployment_profile === 'MULTIUSER_HOSTED' || c.auth_mode === 'api_key') && c.admission !== 'disabled') throw bad(`${c.deployment_profile}/${c.auth_mode} must stay disabled in v1`);
  // the P00 rule: approved (or a verified feature) only for the mock, or with structured live evidence
  // from the user's own machine: when, which CLI version, where, which tests, and that they passed
  const needsLive = c.provider !== 'mock' && (c.admission === 'approved' || FEATURES.some((k) => f[k] === 'verified'));
  if (needsLive && !liveEvidenceOk(ev.live_evidence, c.version)) throw bad('approved or verified needs live_evidence {checked_at, cli_version (= version), host, tests[], passed: true} from the user\'s machine');
  return e as RegistryEntry;
}

export function liveEvidenceOk(v: unknown, version: string): boolean {
  const l = v as { checked_at?: unknown; cli_version?: unknown; host?: unknown; tests?: unknown; passed?: unknown } | null;
  return !!l && typeof l === 'object'
    && typeof l.checked_at === 'string' && !Number.isNaN(Date.parse(l.checked_at))
    && typeof l.cli_version === 'string' && l.cli_version === version
    && typeof l.host === 'string' && l.host.length > 0
    && Array.isArray(l.tests) && l.tests.length > 0 && l.tests.every((t) => typeof t === 'string' && t)
    && l.passed === true;
}

export function loadRegistry(source: unknown = registryFile): Registry {
  const entries = (source as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) throw new Error('registry: entries must be a list');
  const out = entries.map(checkEntry);
  const keys = new Set<string>();
  for (const { capability: c } of out) {
    const k = [c.provider, c.version, c.auth_mode, c.deployment_profile].join('|');
    if (keys.has(k)) throw new Error(`registry: capability ${k} appears twice`);
    keys.add(k);
  }
  return { entries: out };
}

const same = (a: CapabilityKey, b: CapabilityKey) => a.provider === b.provider && a.version === b.version && a.auth_mode === b.auth_mode && a.deployment_profile === b.deployment_profile;

export function resolveCapability(reg: Registry, key: CapabilityKey): Capability & { registered: boolean } {
  const e = reg.entries.find((x) => same(x.capability, key));
  if (e) return { ...e.capability, features: { ...e.capability.features }, registered: true };
  return { ...key, admission: 'disabled', features: Object.fromEntries(FEATURES.map((f) => [f, 'unknown'])) as Record<Feature, FeatureState>, registered: false };
}

export function displayState(s: FeatureState): { state: 'verified' | 'unsupported' | 'unknown'; note: string | null } {
  if (s === 'verified') return { state: 'verified', note: null };
  if (s === 'unsupported') return { state: 'unsupported', note: null };
  if (s === 'documented_not_verified') return { state: 'unknown', note: 'documented, not verified' };
  return { state: 'unknown', note: null };
}

export function capabilityMatrix(reg: Registry) {
  return reg.entries.map(({ capability: c }) => ({
    provider: c.provider, version: c.version, auth_mode: c.auth_mode, deployment_profile: c.deployment_profile, admission: c.admission,
    usable: c.admission === 'approved',
    features: Object.fromEntries(FEATURES.map((f) => [f, displayState(c.features[f])])) as Record<Feature, ReturnType<typeof displayState>>,
  }));
}

export function requireFeature(c: Pick<Capability, 'features'>, f: Feature): void {
  if (c.features[f] !== 'verified') throw new CapabilityUnavailable(f, c.features[f]);
}
