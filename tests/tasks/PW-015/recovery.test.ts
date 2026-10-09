// PW-015 — TST-015A (local recovery part): the browser keeps a recovery copy per account, document
// and tab, for a limited time, only when enabled, and removes everything at logout.
import { describe, expect, test } from 'vitest';
import {
  RETENTION_MS, claimTabId, clearAllRecoveryData, clearDraft, clearOtherAccounts, isRecoveryEnabled, loadDrafts, openTabIds,
  purgeExpired, saveDraft, setRecoveryEnabled, storageWorks, type Draft, type TabLocks,
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
const load = (s: Storage, owner = OWNER_A, doc = DOC, tab = 'tab-1', now = 2_000, open: Set<string> | null = new Set()) => loadDrafts(s, owner, doc, tab, now, open);

// Web Locks as the browser provides them, shared by all tabs; release() ends a tab (close or crash)
class FakeLocks {
  held = new Map<string, () => void>();
  forTab(): TabLocks & { release(): void } {
    const mine: string[] = [];
    return {
      request: async (name, _o, cb) => {
        if (this.held.has(name)) return cb(null);
        let end!: () => void;
        const done = new Promise<void>((r) => { end = r; });
        this.held.set(name, end);
        mine.push(name);
        void cb({ name });
        return done;
      },
      query: async () => ({ held: [...this.held.keys()].map((name) => ({ name })) }),
      release: () => { for (const n of mine) { this.held.get(n)?.(); this.held.delete(n); } },
    };
  }
}

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

  test('review 3 / re-review 1-2: a copy of another tab that is still open (holds its lock) is not offered', async () => {
    const s = new MemStorage();
    const locks = new FakeLocks();
    const tabB = locks.forTab();
    const b = await claimTabId(new MemStorage(), tabB);
    saveDraft(s, draft({ tabId: b.id }));
    const open = await openTabIds(locks.forTab());
    expect(open?.has(b.id)).toBe(true);
    expect(load(s, OWNER_A, DOC, 'tab-X', 2_000, open)).toEqual([]);
    expect(load(s, OWNER_A, DOC, b.id, 2_000, open)).toHaveLength(1); // its own tab still sees it
    tabB.release(); // tab B closed or crashed
    expect(load(s, OWNER_A, DOC, 'tab-X', 2_000, await openTabIds(locks.forTab()))).toHaveLength(1);
    // without Web Locks it cannot be known whether another tab is open: only the own copy is offered
    expect(load(s, OWNER_A, DOC, 'tab-X', 2_000, null)).toEqual([]);
    expect(load(s, OWNER_A, DOC, b.id, 2_000, null)).toHaveLength(1);
  });

  test('re-review 1 / nit 3: a reloaded or crashed tab keeps its id; a duplicate of an open tab gets a new one', async () => {
    const locks = new FakeLocks();
    const session = new MemStorage();
    const first = locks.forTab();
    const a = await claimTabId(session, first);
    expect(a.locked).toBe(true);
    // duplicated tab: the session copy carries the same id while the original still holds its lock
    const dupSession = new MemStorage();
    dupSession.setItem('pw-recovery-tab', a.id);
    const dup = await claimTabId(dupSession, locks.forTab());
    expect(dup.id).not.toBe(a.id);
    expect(dupSession.getItem('pw-recovery-tab')).toBe(dup.id);
    // the original page goes away (reload or crash): the lock is released, the same id comes back
    first.release();
    expect((await claimTabId(session, locks.forTab())).id).toBe(a.id);
    // no Web Locks: the id comes from the session copy, not locked
    expect(await claimTabId(session, null)).toEqual({ id: a.id, locked: false });
    expect(await openTabIds(null)).toBeNull();
  });

  test('drafts older than the retention period are removed', () => {
    const s = new MemStorage();
    saveDraft(s, draft({ savedAt: 0 }));
    saveDraft(s, draft({ documentId: DOC2, savedAt: RETENTION_MS }));
    expect(load(s, OWNER_A, DOC, 'tab-1', RETENTION_MS + 1)).toEqual([]);
    expect(s.length).toBe(1);
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
