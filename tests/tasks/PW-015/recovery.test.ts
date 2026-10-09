// PW-015 — TST-015A (local recovery part): the browser keeps a recovery copy per account and
// document, for a limited time, only when enabled, and removes everything at logout.
import { describe, expect, test } from 'vitest';
import {
  RETENTION_MS, clearAllRecoveryData, clearDraft, isRecoveryEnabled, loadDraft, purgeExpired, saveDraft, setRecoveryEnabled, type Draft,
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
const draft = (over: Partial<Draft> = {}): Draft => ({ ownerId: OWNER_A, paperId: 'p1', documentId: DOC, baseRevisionId: 'rev-1', schemaVersion: 1, content, savedAt: 1_000, ...over });

describe('local recovery', () => {
  test('a draft round-trips with Korean text, marks and a citation', () => {
    const s = new MemStorage();
    expect(saveDraft(s, draft())).toEqual({ ok: true });
    expect(loadDraft(s, OWNER_A, DOC, 2_000)).toEqual(draft());
  });

  test('drafts are separate per account and per document', () => {
    const s = new MemStorage();
    saveDraft(s, draft());
    expect(loadDraft(s, OWNER_B, DOC, 2_000)).toBeNull();
    expect(loadDraft(s, OWNER_A, '00000000-0000-4000-8000-0000000000d2', 2_000)).toBeNull();
    clearDraft(s, OWNER_A, DOC);
    expect(loadDraft(s, OWNER_A, DOC, 2_000)).toBeNull();
  });

  test('drafts older than the retention period are removed', () => {
    const s = new MemStorage();
    saveDraft(s, draft({ savedAt: 0 }));
    saveDraft(s, draft({ documentId: '00000000-0000-4000-8000-0000000000d2', savedAt: RETENTION_MS }));
    expect(loadDraft(s, OWNER_A, DOC, RETENTION_MS + 1)).toBeNull();
    expect(s.length).toBe(1);
    purgeExpired(s, 2 * RETENTION_MS + 1);
    expect(s.length).toBe(0);
  });

  test('a stored draft that is not a valid document is discarded, not loaded', () => {
    const s = new MemStorage();
    saveDraft(s, draft());
    const key = s.key(0)!;
    const bad = JSON.parse(s.getItem(key)!);
    bad.content.content[0].content.push({ type: 'script', text: 'x' });
    s.setItem(key, JSON.stringify(bad));
    expect(loadDraft(s, OWNER_A, DOC, 2_000)).toBeNull();
    expect(s.length).toBe(0);
    s.setItem(key, '{not json');
    expect(loadDraft(s, OWNER_A, DOC, 2_000)).toBeNull();
  });

  test('a draft stored under another account key is not returned', () => {
    const s = new MemStorage();
    saveDraft(s, draft());
    const key = s.key(0)!;
    const moved = JSON.parse(s.getItem(key)!);
    moved.ownerId = OWNER_B;
    s.setItem(key, JSON.stringify(moved));
    expect(loadDraft(s, OWNER_A, DOC, 2_000)).toBeNull();
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
    expect(loadDraft(s, OWNER_A, DOC, 2_000)).toBeNull();
    expect(loadDraft(s, OWNER_B, DOC, 2_000)).not.toBeNull();
    expect(saveDraft(s, draft())).toEqual({ ok: false, error: 'disabled' });
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

  test('a storage that throws on access (blocked site data) is handled', () => {
    const broken = { get length(): number { throw new Error('denied'); }, getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); }, key() { throw new Error('denied'); }, clear() {} } as unknown as Storage;
    expect(loadDraft(broken, OWNER_A, DOC, 1)).toBeNull();
    expect(saveDraft(broken, draft()).ok).toBe(false);
    expect(() => clearAllRecoveryData(broken)).not.toThrow();
    expect(() => purgeExpired(broken, 1)).not.toThrow();
  });
});
