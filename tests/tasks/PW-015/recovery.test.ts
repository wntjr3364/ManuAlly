// PW-015 — TST-015A (local recovery part): the browser keeps a recovery copy per account, document
// and tab, for a limited time, only when enabled, and removes everything at logout.
import { describe, expect, test } from 'vitest';
import {
  LIVE_MS, RETENTION_MS, clearAllRecoveryData, clearDraft, clearLive, clearOtherAccounts, isRecoveryEnabled, loadDrafts, markLive,
  purgeExpired, saveDraft, setRecoveryEnabled, storageWorks, tabIdFor, type Draft,
} from '../../../apps/web/src/editor/recovery.ts';

class MemStorage implements Storage {
  m = new Map<string, string>();
  quota = Infinity;
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) {
    if (v.length > this.quota) throw new DOMException('full', 'QuotaExceededError');
    this.m.set(k, String(v));
  }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

const OWNER_A = '00000000-0000-4000-8000-00000000000a';
const OWNER_B = '00000000-0000-4000-8000-00000000000b';
const DOC = '00000000-0000-4000-8000-0000000000d1';
const DOC2 = '00000000-0000-4000-8000-0000000000d2';
const BLOCK = '00000000-0000-4000-8000-0000000000b1';
const REF = '00000000-0000-4000-8000-0000000000f1';
const content = {
  type: 'doc',
  content: [{
    type: 'paragraph', attrs: { id: BLOCK },
    content: [
      { type: 'text', text: '한글 ' },
      { type: 'text', text: 'in vivo', marks: [{ type: 'italic' }] },
      { type: 'text', text: ' H' },
      { type: 'text', text: '2', marks: [{ type: 'subscript' }] },
      { type: 'text', text: 'O 10' },
      { type: 'text', text: '3', marks: [{ type: 'superscript' }] },
      { type: 'citation', attrs: { referenceId: REF, locator: 'p. 4' } },
    ],
  }],
};
const draft = (over: Partial<Draft> = {}): Draft => ({ ownerId: OWNER_A, paperId: 'p1', documentId: DOC, tabId: 'tab-1', baseRevisionId: 'rev-1', schemaVersion: 1, content, savedAt: 1_000, ...over });
const load = (s: Storage, owner = OWNER_A, doc = DOC, tab = 'tab-1', now = 2_000) => loadDrafts(s, owner, doc, tab, now);

describe('local recovery', () => {
  test('a draft round-trips with Korean text, marks and a citation', () => {
    const s = new MemStorage();
    expect(saveDraft(s, draft())).toEqual({ ok: true });
    expect(load(s)).toEqual([draft()]);
  });

  test('drafts are separate per account and per document', () => {
    const s = new MemStorage();
    saveDraft(s, draft());
    expect(load(s, OWNER_B)).toEqual([]);
    expect(load(s, OWNER_A, DOC2)).toEqual([]);
    clearDraft(s, draft());
    expect(load(s)).toEqual([]);
  });

  test('review 3: tabs keep separate copies; clearing one tab\'s copy leaves the other', () => {
    const s = new MemStorage();
    saveDraft(s, draft({ tabId: 'tab-A', content: { type: 'doc', content: [] }, savedAt: 1_500 }));
    saveDraft(s, draft({ tabId: 'tab-B' }));
    expect(load(s, OWNER_A, DOC, 'tab-X').map((d) => d.tabId)).toEqual(['tab-A', 'tab-B']); // newest first
    expect(load(s, OWNER_A, DOC, 'tab-B').map((d) => d.tabId)).toEqual(['tab-B', 'tab-A']); // own tab first
    clearDraft(s, { ownerId: OWNER_A, documentId: DOC, tabId: 'tab-A' });
    expect(load(s, OWNER_A, DOC, 'tab-X').map((d) => d.tabId)).toEqual(['tab-B']);
  });

  test('review 3: a copy of another tab that is still open is not offered and not deleted', () => {
    const s = new MemStorage();
    saveDraft(s, draft({ tabId: 'tab-B' }));
    markLive(s, 'tab-B', 1_900);
    expect(load(s, OWNER_A, DOC, 'tab-X', 2_000)).toEqual([]);
    expect(load(s, OWNER_A, DOC, 'tab-B', 2_000)).toHaveLength(1); // its own tab still sees it
    expect(load(s, OWNER_A, DOC, 'tab-X', 1_900 + LIVE_MS)).toHaveLength(1); // the tab stopped refreshing
    clearLive(s, 'tab-B');
    expect(load(s, OWNER_A, DOC, 'tab-X', 2_000)).toHaveLength(1);
  });

  test('a reloaded tab keeps its id; a duplicated tab of an open one gets a new id', () => {
    const local = new MemStorage();
    const session = new MemStorage();
    const id = tabIdFor(session, local, 1_000);
    expect(tabIdFor(session, local, 1_000)).toBe(id); // reload (the old page cleared its live mark)
    markLive(local, id, 1_000);
    const dup = tabIdFor(session, local, 2_000); // same session copy, original still open
    expect(dup).not.toBe(id);
    expect(tabIdFor(null, local, 2_000)).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('drafts older than the retention period are removed', () => {
    const s = new MemStorage();
    saveDraft(s, draft({ savedAt: 0 }));
    saveDraft(s, draft({ documentId: DOC2, savedAt: RETENTION_MS }));
    expect(load(s, OWNER_A, DOC, 'tab-1', RETENTION_MS + 1)).toEqual([]);
    expect(s.length).toBe(1);
    markLive(s, 'old-tab', 0);
    purgeExpired(s, 2 * RETENTION_MS + 1);
    expect(s.length).toBe(0);
  });

  test('a stored draft that is not a valid document, or sits under the wrong key, is discarded', () => {
    const s = new MemStorage();
    saveDraft(s, draft());
    const key = s.key(0)!;
    const bad = JSON.parse(s.getItem(key)!);
    bad.content.content[0].content.push({ type: 'script', text: 'x' });
    s.setItem(key, JSON.stringify(bad));
    expect(load(s)).toEqual([]);
    expect(s.length).toBe(0);
    s.setItem(key, '{not json');
    expect(load(s)).toEqual([]);
    saveDraft(s, draft());
    const moved = JSON.parse(s.getItem(key)!);
    moved.ownerId = OWNER_B; // content claims another account
    s.setItem(key, JSON.stringify(moved));
    expect(load(s)).toEqual([]);
    expect(load(s, OWNER_B)).toEqual([]);
  });

  test('a full storage is reported, not ignored', () => {
    const s = new MemStorage();
    s.quota = 10;
    expect(saveDraft(s, draft())).toEqual({ ok: false, error: expect.stringMatching(/공간|저장/) });
  });

  test('the setting is per account and on by default; turning it off removes that account\'s drafts', () => {
    const s = new MemStorage();
    expect(isRecoveryEnabled(s, OWNER_A)).toBe(true);
    saveDraft(s, draft());
    saveDraft(s, draft({ ownerId: OWNER_B }));
    setRecoveryEnabled(s, OWNER_A, false);
    expect(isRecoveryEnabled(s, OWNER_A)).toBe(false);
    expect(isRecoveryEnabled(s, OWNER_B)).toBe(true);
    expect(load(s)).toEqual([]);
    expect(load(s, OWNER_B)).toHaveLength(1);
    expect(saveDraft(s, draft())).toEqual({ ok: false, error: 'disabled' });
  });

  test('review 8: signing in removes the copies and settings of every other account', () => {
    const s = new MemStorage();
    saveDraft(s, draft());
    saveDraft(s, draft({ ownerId: OWNER_B }));
    setRecoveryEnabled(s, OWNER_B, false);
    saveDraft(s, draft({ ownerId: OWNER_B, documentId: DOC2 }));
    s.setItem('unrelated', '1');
    clearOtherAccounts(s, OWNER_A);
    expect(load(s)).toHaveLength(1);
    expect([...s.m.keys()].filter((k) => k.includes(OWNER_B))).toEqual([]);
    expect(s.getItem('unrelated')).toBe('1');
  });

  test('logout removes every recovery entry of every account but leaves unrelated keys', () => {
    const s = new MemStorage();
    saveDraft(s, draft());
    saveDraft(s, draft({ ownerId: OWNER_B }));
    setRecoveryEnabled(s, OWNER_A, false);
    markLive(s, 'tab-1', 1);
    s.setItem('unrelated', '1');
    clearAllRecoveryData(s);
    expect([...s.m.keys()]).toEqual(['unrelated']);
  });

  test('review 7: a storage that throws (blocked site data) is detected and handled', () => {
    const broken = { get length(): number { throw new Error('denied'); }, getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); }, key() { throw new Error('denied'); }, clear() {} } as unknown as Storage;
    expect(storageWorks(broken)).toBe(false);
    expect(storageWorks(null)).toBe(false);
    expect(storageWorks(new MemStorage())).toBe(true);
    expect(load(broken)).toEqual([]);
    expect(saveDraft(broken, draft()).ok).toBe(false);
    expect(() => clearAllRecoveryData(broken)).not.toThrow();
    expect(() => purgeExpired(broken, 1)).not.toThrow();
    expect(() => clearOtherAccounts(broken, OWNER_A)).not.toThrow();
  });
});
