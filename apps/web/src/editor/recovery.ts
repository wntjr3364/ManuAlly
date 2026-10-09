// Browser-side recovery copy of unsaved manuscript text (spec 04: "브라우저 임시복구 저장은 계정·논문별
// 격리와 보존기간·명시 설정을 둔다. 로그아웃 시 shared device 데이터를 남기지 않는다").
// - one entry per account, document and browser tab: tabs never overwrite or delete each other's copy
// - an entry is only returned for the account that wrote it; signing in removes other accounts' entries
// - entries expire after RETENTION_MS; a stored entry that is not a valid document is dropped
// - an open tab marks itself live; its copy is neither offered to nor deleted by another tab
// - a per-account setting turns it off (and removes that account's entries)
// - logout removes every entry of every account
// It is a convenience copy, never the canonical text: the server revision stays the source of truth.
import { EDITOR_SCHEMA_VERSION, validateDocument } from '@pw/editor-core';

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LIVE_MS = 15_000; // a tab that refreshed its live mark this recently is open
export const LIVE_REFRESH_MS = 5_000;
const PREFIX = 'pw-recovery:v1:';
const DRAFT = `${PREFIX}draft:`;
const LIVE = `${PREFIX}live:`;
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

export function markLive(storage: Storage, tabId: string, now: number): void {
  attempt(() => storage.setItem(`${LIVE}${tabId}`, String(now)), undefined);
}
export function clearLive(storage: Storage, tabId: string): void {
  attempt(() => storage.removeItem(`${LIVE}${tabId}`), undefined);
}
export function isLive(storage: Storage, tabId: string, now: number): boolean {
  const t = Number(attempt(() => storage.getItem(`${LIVE}${tabId}`), null));
  return Number.isFinite(t) && t > 0 && now - t < LIVE_MS;
}

// Copies of this document this tab may offer, own tab first, then newest first. Copies of other
// tabs that are still open are left to them; broken or expired copies are removed.
export function loadDrafts(storage: Storage, ownerId: string, documentId: string, tabId: string, now: number): Draft[] {
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
    if (d!.tabId !== tabId && isLive(storage, d!.tabId, now)) continue;
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
    } else if (k.startsWith(LIVE)) {
      const t = Number(attempt(() => storage.getItem(k), null));
      if (!(now - t < RETENTION_MS)) attempt(() => storage.removeItem(k), undefined);
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

// This tab's id, kept in sessionStorage so a reload of the same tab finds its own copy. A duplicated
// tab inherits the id while the original is open; it then takes a new one.
export function tabIdFor(session: Storage | null, local: Storage | null, now: number): string {
  const key = 'pw-recovery-tab';
  let id = session ? attempt(() => session.getItem(key), null) : null;
  if (!id || (local && isLive(local, id, now))) {
    id = crypto.randomUUID();
    if (session) attempt(() => session.setItem(key, id!), undefined);
  }
  return id;
}

// this page's tab id, decided once per page load
let pageTab: string | null = null;
export function pageTabId(): string {
  pageTab ??= tabIdFor(browserSessionStorage(), browserStorage(), Date.now());
  return pageTab;
}

// The signed-in account, set by the app shell; the editor stores drafts under it.
let currentOwner: string | null = null;
export const setRecoveryOwner = (ownerId: string | null) => { currentOwner = ownerId; };
export const recoveryOwner = () => currentOwner;

// browser storage, or null where none is available
export const browserStorage = (): Storage | null => attempt(() => window.localStorage, null);
export const browserSessionStorage = (): Storage | null => attempt(() => window.sessionStorage, null);
