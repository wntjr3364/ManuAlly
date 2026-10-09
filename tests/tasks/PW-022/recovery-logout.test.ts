// PW-022 (found by the gate run) — a logout in another tab ends local copies in this page even before
// the storage event arrives: the stored logout time is compared with when this page got its owner.
import { expect, test } from 'vitest';

test('a logout recorded after this page signed in ends recovery copies at once', async () => {
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, String(v)), removeItem: (k: string) => void data.delete(k), key: (i: number) => [...data.keys()][i] ?? null, get length() { return data.size; } };
  (globalThis as unknown as { window: unknown }).window = { localStorage: storage };
  const r = await import('../../../apps/web/src/editor/recovery.ts');
  data.set('pw-logout', String(Date.now() - 60_000)); // an older logout: before this page signed in
  r.setRecoveryOwner('owner-1');
  expect(r.recoveryOwner()).toBe('owner-1');
  expect(r.recoveryEndedForPage()).toBe(false);
  await new Promise((res) => setTimeout(res, 5));
  r.announceLogout(storage as unknown as Storage); // another tab logs out (no storage event in this test)
  expect(r.recoveryOwner()).toBeNull();
  expect(r.recoveryEndedForPage()).toBe(true);
  // signing in again in this page starts copies again
  r.resumeRecoveryForPage();
  await new Promise((res) => setTimeout(res, 5));
  r.setRecoveryOwner('owner-1');
  expect(r.recoveryOwner()).toBe('owner-1');
});
