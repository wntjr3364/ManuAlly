// Provider selection for the product runtime. Until a provider is admitted (registry + user
// approval + auth sentinel, see docs/adr/P00_DECISION_RECORD.md and RFC-004), only the mock exists.
// Credentials in the environment never select or enable a provider.

export interface ProviderHandle {
  id: 'mock';
  /** Deterministic, offline proposal text for tests and demos. Clearly labelled as mock output. */
  proposeReplacement(input: { selectedText: string; instruction: string }): { text: string; label: 'MOCK' };
}

export const mockProvider: ProviderHandle = {
  id: 'mock',
  proposeReplacement: ({ selectedText }) => ({ text: selectedText, label: 'MOCK' }),
};

export function selectProvider(env: Record<string, string | undefined>): ProviderHandle {
  const requested = env.PW_PROVIDER ?? 'mock';
  if (requested === 'mock') return mockProvider;
  throw new Error(`provider "${requested}" has no admission in this build; only "mock" is available (P01)`);
}
