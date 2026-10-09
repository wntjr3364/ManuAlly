// PW-023 — capability registry: every provider/version/auth/deployment row shows each feature as
// verified, unsupported or unknown (documented-but-unverified is unknown, with the note), and nothing
// that is not verified can be used (TST-023A/B).
import { describe, expect, test } from 'vitest';
import { CapabilityUnavailable, FEATURES, capabilityMatrix, displayState, loadRegistry, requireFeature, resolveCapability } from '../../../packages/providers/src/core/index.ts';

const reg = loadRegistry();

describe('TST-023A: the registry shows each capability per provider, version and auth', () => {
  test('every row has the seven features in the three display states', () => {
    const m = capabilityMatrix(reg);
    expect(m.length).toBe(9);
    for (const row of m) {
      expect(Object.keys(row.features).sort()).toEqual([...FEATURES].sort());
      for (const f of Object.values(row.features)) expect(['verified', 'unsupported', 'unknown']).toContain(f.state);
    }
    const claude = m.find((r) => r.provider === 'claude_agent' && r.auth_mode === 'subscription_cli_login' && r.deployment_profile === 'PERSONAL_LOCAL')!;
    expect(claude).toMatchObject({ version: 'claude-code 2.1.294', admission: 'requires_verification', usable: false });
    expect(claude.features.interrupt).toEqual({ state: 'unknown', note: 'documented, not verified' });
    expect(claude.features.manual_compact).toEqual({ state: 'unknown', note: null });
    expect(m.find((r) => r.provider === 'mock')).toMatchObject({ admission: 'approved', usable: true });
    expect(m.filter((r) => r.auth_mode === 'api_key').every((r) => r.admission === 'disabled' && !r.usable)).toBe(true);
  });

  test('documented_not_verified is never displayed as verified', () => {
    expect(displayState('documented_not_verified')).toEqual({ state: 'unknown', note: 'documented, not verified' });
    expect(displayState('verified')).toEqual({ state: 'verified', note: null });
    expect(displayState('unsupported')).toEqual({ state: 'unsupported', note: null });
    expect(displayState('something else' as never)).toEqual({ state: 'unknown', note: null });
  });

  test('a version, auth mode or deployment not in the registry resolves to disabled with every feature unknown', () => {
    const c = resolveCapability(reg, { provider: 'claude_agent', version: 'claude-code 9.9.9', auth_mode: 'subscription_cli_login', deployment_profile: 'PERSONAL_LOCAL' });
    expect(c.admission).toBe('disabled');
    expect(Object.values(c.features).every((s) => s === 'unknown')).toBe(true);
    expect(c.registered).toBe(false);
  });
});

describe('TST-023B: unsupported or unverified features are not assumed', () => {
  test('manual compact and quota read are refused unless verified', () => {
    const claude = resolveCapability(reg, { provider: 'claude_agent', version: 'claude-code 2.1.294', auth_mode: 'subscription_cli_login', deployment_profile: 'PERSONAL_LOCAL' });
    expect(() => requireFeature(claude, 'manual_compact')).toThrow(CapabilityUnavailable);
    expect(() => requireFeature(claude, 'quota_read')).toThrow(/quota_read.*unknown/);
    const codex = resolveCapability(reg, { provider: 'codex', version: 'codex-cli 0.161.0', auth_mode: 'chatgpt_login', deployment_profile: 'PERSONAL_LOCAL' });
    // documented in the generated schema, not verified on the user's machine
    expect(codex.features.manual_compact).toBe('documented_not_verified');
    expect(() => requireFeature(codex, 'manual_compact')).toThrow(/documented, not verified/);
  });
  test('the registry file is validated against the provider_capability contract', () => {
    expect(() => loadRegistry({ entries: [{ capability: { provider: 'claude_agent', version: 'x', auth_mode: 'y', deployment_profile: 'PERSONAL_LOCAL', admission: 'approved', features: {} }, evidence: {} }] })).toThrow(/capability/);
  });
  test('approval for a real provider needs live evidence from the user\'s machine', () => {
    const forged = structuredClone(reg.entries[1]!);
    forged.capability.admission = 'approved';
    expect(() => loadRegistry({ entries: [forged] })).toThrow(/live_evidence/);
  });
});

describe('review MINOR-1: the registry enforces the v1 admission policy', () => {
  const entry = (over: Record<string, unknown>, evidence: Record<string, unknown> = { live_evidence: null }) => ({
    capability: { provider: 'claude_agent', version: 'claude-code 2.1.294', auth_mode: 'subscription_cli_login', deployment_profile: 'PERSONAL_LOCAL', admission: 'requires_verification', features: Object.fromEntries(FEATURES.map((f) => [f, 'unknown'])), ...over },
    evidence,
  });
  const live = { checked_at: '2026-10-09T10:00:00Z', cli_version: 'claude-code 2.1.294', host: 'my-pc', tests: ['PW-024 TST-024A'], passed: true };
  test('live evidence must be structured, match the version and have passed', () => {
    expect(() => loadRegistry({ entries: [entry({ admission: 'approved' }, { live_evidence: 'x' })] })).toThrow(/live_evidence/);
    expect(() => loadRegistry({ entries: [entry({ admission: 'approved' }, { live_evidence: { ...live, passed: false } })] })).toThrow(/live_evidence/);
    expect(() => loadRegistry({ entries: [entry({ admission: 'approved' }, { live_evidence: { ...live, cli_version: 'claude-code 2.2.0' } })] })).toThrow(/live_evidence/);
    expect(() => loadRegistry({ entries: [entry({ features: { ...Object.fromEntries(FEATURES.map((f) => [f, 'unknown'])), interrupt: 'verified' } }, { live_evidence: 'yes' })] })).toThrow(/live_evidence/);
    expect(loadRegistry({ entries: [entry({ admission: 'approved' }, { live_evidence: live })] }).entries).toHaveLength(1);
  });
  test('multi-user hosting and API keys stay disabled', () => {
    expect(() => loadRegistry({ entries: [entry({ deployment_profile: 'MULTIUSER_HOSTED', admission: 'approved' }, { live_evidence: live })] })).toThrow(/must stay disabled/);
    expect(() => loadRegistry({ entries: [entry({ auth_mode: 'api_key', admission: 'requires_verification' })] })).toThrow(/must stay disabled/);
  });
  test('the same capability key twice is refused', () => {
    expect(() => loadRegistry({ entries: [entry({}), entry({})] })).toThrow(/appears twice/);
  });
});
