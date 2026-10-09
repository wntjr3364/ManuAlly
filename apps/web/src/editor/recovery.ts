// Browser-side recovery copy of unsaved manuscript text (spec 04: "브라우저 임시복구 저장은 계정·논문별
// 격리와 보존기간·명시 설정을 둔다. 로그아웃 시 shared device 데이터를 남기지 않는다").
// - one entry per account, document and browser tab: tabs never overwrite or delete each other's copy
// - an entry is only returned for the account that wrote it; signing in removes other accounts' entries
// - entries expire after RETENTION_MS; a stored entry that is not a valid document is dropped
// - an open tab holds a Web Lock named after its id for the page's lifetime (released by the browser
//   when the tab closes or crashes, unaffected by timer throttling); copies of tabs that hold their
//   lock are neither offered to nor deleted by another tab. Without Web Locks no other tab's copy is
//   offered.
// - a per-account setting turns it off (and removes that account's entries)
// - logout removes every entry of every account
// It is a convenience copy, never the canonical text: the server revision stays the source of truth.
import { EDITOR_SCHEMA_VERSION, validateDocument } from '@pw/editor-core';

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PREFIX = 'pw-recovery:v1:';
const DRAFT = `${PREFIX}draft:`;
const TAB_LOCK = 'pw-recovery-tab:';
const LOGOUT_KEY = 'pw-logout';
const draftKey = (ownerId: string, documentId: string, tabId: string) => `${DRAFT}${ownerId}:${documentId}:${tabId}`;
const offKey = (ownerId: string) => `${PREFIX}off:${ownerId}`;

export interface Draft {
  ownerId: string;
  paperId: string;
  documentId: string;
  tabId: string;
  baseRevisionId: string; // the server revision the text was edited from
  schemaVersion: number;
  content: unknown;
  savedAt: number; // ms since epoch, this browser's clock
}

// storage access can throw (blocked site data, private mode); recovery then does nothing
function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function keys(storage: Storage): string[] {
  return attempt(() => {
    const out: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith(PREFIX)) out.push(k);
    }
    return out;
  }, []);
}

// true when entries can actually be written and read back
export function storageWorks(storage: Storage | null): boolean {
  if (!storage) return false;
  return attempt(() => {
    const k = `${PREFIX}probe`;
    storage.setItem(k, '1');
    const ok = storage.getItem(k) === '1';
    storage.removeItem(k);
    return ok;
  }, false);
}

export const isRecoveryEnabled = (storage: Storage, ownerId: string) => attempt(() => storage.getItem(offKey(ownerId)) !== '1', false);

export function setRecoveryEnabled(storage: Storage, ownerId: string, on: boolean): void {
  attempt(() => {
    if (on) storage.removeItem(offKey(ownerId));
    else {
      storage.setItem(offKey(ownerId), '1');
      for (const k of keys(storage)) if (k.startsWith(`${DRAFT}${ownerId}:`)) storage.removeItem(k);
    }
  }, undefined);
}

export function saveDraft(storage: Storage, d: Draft): { ok: true } | { ok: false; error: string } {
  if (!isRecoveryEnabled(storage, d.ownerId)) return { ok: false, error: 'disabled' };
  try {
    storage.setItem(draftKey(d.ownerId, d.documentId, d.tabId), JSON.stringify(d));
    return { ok: true };
  } catch (e) {
    const full = e instanceof DOMException && /quota/i.test(e.name);
    return { ok: false, error: full ? '브라우저 저장 공간이 부족해 임시 복구본을 저장하지 못했습니다' : '브라우저가 임시 복구본 저장을 막았습니다' };
  }
}

function parse(raw: string | null): Draft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<Draft>;
    if (typeof d.ownerId !== 'string' || typeof d.documentId !== 'string' || typeof d.paperId !== 'string' || typeof d.tabId !== 'string'
      || typeof d.baseRevisionId !== 'string' || typeof d.savedAt !== 'number' || d.schemaVersion !== EDITOR_SCHEMA_VERSION) return null;
    if (!validateDocument(d.content, d.schemaVersion).ok) return null;
    return d as Draft;
  } catch {
    return null;
  }
}

const usable = (d: Draft | null, now: number) => d !== null && now - d.savedAt <= RETENTION_MS && d.savedAt <= now + 60_000;

export interface TabLocks {
  request(name: string, options: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown> | undefined): Promise<unknown>;
  query(): Promise<{ held?: { name?: string }[] }>;
}

// ids of tabs that are open now (they hold their lock); null when that cannot be known
export async function openTabIds(locks: TabLocks | null): Promise<Set<string> | null> {
  if (!locks) return null;
  try {
    const q = await locks.query();
    return new Set((q.held ?? []).map((l) => l.name ?? '').filter((n) => n.startsWith(TAB_LOCK)).map((n) => n.slice(TAB_LOCK.length)));
  } catch {
    return null;
  }
}

// Takes this page's tab id and holds its lock until the page goes away. A reload (or a reload after a
// crash) gets the same id back from sessionStorage; a duplicated tab whose original is still open
// cannot take the lock and gets a new id.
export async function claimTabId(session: Storage | null, locks: TabLocks | null): Promise<{ id: string; locked: boolean }> {
  const key = 'pw-recovery-tab';
  let id = session ? attempt(() => session.getItem(key), null) : null;
  for (let i = 0; i < 5; i++) {
    id ??= crypto.randomUUID();
    if (!locks) break;
    const name = TAB_LOCK + id;
    const got = await new Promise<boolean>((resolve) => {
      locks.request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        return new Promise(() => {}); // held for the page's lifetime
      }).catch(() => resolve(false));
    });
    if (got) {
      if (session) attempt(() => session.setItem(key, id!), undefined);
      return { id, locked: true };
    }
    id = null;
  }
  id ??= crypto.randomUUID();
  if (session) attempt(() => session.setItem(key, id!), undefined);
  return { id, locked: false };
}

// Copies of this document this tab may offer, own tab first, then newest first. Copies of other
// tabs that are still open are left to them (all of them when that is unknown: openTabs null);
// broken or expired copies are removed.
export function loadDrafts(storage: Storage, ownerId: string, documentId: string, tabId: string, now: number, openTabs: Set<string> | null): Draft[] {
  if (!isRecoveryEnabled(storage, ownerId)) return [];
  const prefix = `${DRAFT}${ownerId}:${documentId}:`;
  const out: Draft[] = [];
  for (const k of keys(storage)) {
    if (!k.startsWith(prefix)) continue;
    const d = parse(attempt(() => storage.getItem(k), null));
    if (!usable(d, now) || d!.ownerId !== ownerId || d!.documentId !== documentId || k !== draftKey(ownerId, documentId, d!.tabId)) {
      attempt(() => storage.removeItem(k), undefined);
      continue;
    }
    if (d!.tabId !== tabId && (openTabs === null || openTabs.has(d!.tabId))) continue;
    out.push(d!);
  }
  return out.sort((a, b) => Number(b.tabId === tabId) - Number(a.tabId === tabId) || b.savedAt - a.savedAt);
}

export const clearDraft = (storage: Storage, d: { ownerId: string; documentId: string; tabId: string }) =>
  attempt(() => storage.removeItem(draftKey(d.ownerId, d.documentId, d.tabId)), undefined);

export function purgeExpired(storage: Storage, now: number): void {
  for (const k of keys(storage)) {
    if (k.startsWith(DRAFT)) {
      if (!usable(parse(attempt(() => storage.getItem(k), null)), now)) attempt(() => storage.removeItem(k), undefined);
    }
  }
}

// at sign-in: leave nothing of another account on this device
export function clearOtherAccounts(storage: Storage, ownerId: string): void {
  for (const k of keys(storage)) {
    const owner = k.startsWith(DRAFT) ? k.slice(DRAFT.length).split(':')[0] : k.startsWith(`${PREFIX}off:`) ? k.slice(`${PREFIX}off:`.length) : null;
    if (owner !== null && owner !== ownerId) attempt(() => storage.removeItem(k), undefined);
  }
}

export function clearAllRecoveryData(storage: Storage): void {
  for (const k of keys(storage)) attempt(() => storage.removeItem(k), undefined);
}

// this page's tab id, claimed once per page load
let pageTab: Promise<{ id: string; locked: boolean }> | null = null;
export const pageTabId = () => (pageTab ??= claimTabId(browserSessionStorage(), browserLocks()));
export const browserLocks = (): TabLocks | null => attempt(() => (navigator as { locks?: TabLocks }).locks ?? null, null);

// Logout in one tab tells the other tabs of this browser (storage event) to stop keeping copies.
export function announceLogout(storage: Storage): void {
  attempt(() => storage.setItem(LOGOUT_KEY, String(Date.now())), undefined);
}
export const isLogoutEvent = (e: { key: string | null }) => e.key === LOGOUT_KEY;
let pageLoggedOut = false;
// after a logout seen in this page, nothing is kept locally until the page is loaded again
export function endRecoveryForPage(): void { pageLoggedOut = true; currentOwner = null; }
// a sign-in in this page starts keeping copies again
export function resumeRecoveryForPage(): void { pageLoggedOut = false; }
export const recoveryEndedForPage = () => pageLoggedOut;

// The signed-in account, set by the app shell; the editor stores drafts under it.
let currentOwner: string | null = null;
let ownerSince = 0; // when this page got its owner (page load or sign-in)
export const setRecoveryOwner = (ownerId: string | null) => {
  if (ownerId !== currentOwner) ownerSince = Date.now();
  currentOwner = pageLoggedOut ? null : ownerId;
};
// Checked on every use, not only through the storage event: a background tab may handle a click or
// keystrokes before the queued event arrives, and must not write a copy after a logout elsewhere (PW-022).
export const recoveryOwner = () => {
  if (currentOwner) {
    const loggedOutAt = Number(attempt(() => browserStorage()?.getItem(LOGOUT_KEY) ?? 0, 0));
    if (loggedOutAt > ownerSince) endRecoveryForPage();
  }
  return currentOwner;
};

// browser storage, or null where none is available
export const browserStorage = (): Storage | null => attempt(() => window.localStorage, null);
export const browserSessionStorage = (): Storage | null => attempt(() => window.sessionStorage, null);
