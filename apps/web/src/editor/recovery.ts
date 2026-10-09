// Browser-side recovery copy of unsaved manuscript text (spec 04: "브라우저 임시복구 저장은 계정·논문별
// 격리와 보존기간·명시 설정을 둔다. 로그아웃 시 shared device 데이터를 남기지 않는다").
// - one entry per account and document; an entry is only returned for the account that wrote it
// - entries expire after RETENTION_MS; a stored entry that is not a valid document is dropped
// - a per-account setting turns it off (and removes that account's entries)
// - logout removes every entry of every account
// It is a convenience copy, never the canonical text: the server revision stays the source of truth.
import { EDITOR_SCHEMA_VERSION, validateDocument } from '@pw/editor-core';

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PREFIX = 'pw-recovery:v1:';
const draftKey = (ownerId: string, documentId: string) => `${PREFIX}draft:${ownerId}:${documentId}`;
const offKey = (ownerId: string) => `${PREFIX}off:${ownerId}`;

export interface Draft {
  ownerId: string;
  paperId: string;
  documentId: string;
  baseRevisionId: string; // the server revision the text was edited from
  schemaVersion: number;
  content: unknown;
  savedAt: number; // ms since epoch, this browser's clock
}

// storage access can throw (blocked site data, private mode); recovery then simply does nothing
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

export const isRecoveryEnabled = (storage: Storage, ownerId: string) => attempt(() => storage.getItem(offKey(ownerId)) !== '1', false);

export function setRecoveryEnabled(storage: Storage, ownerId: string, on: boolean): void {
  attempt(() => {
    if (on) storage.removeItem(offKey(ownerId));
    else {
      storage.setItem(offKey(ownerId), '1');
      for (const k of keys(storage)) if (k.startsWith(`${PREFIX}draft:${ownerId}:`)) storage.removeItem(k);
    }
  }, undefined);
}

export function saveDraft(storage: Storage, d: Draft): { ok: true } | { ok: false; error: string } {
  if (!isRecoveryEnabled(storage, d.ownerId)) return { ok: false, error: 'disabled' };
  try {
    storage.setItem(draftKey(d.ownerId, d.documentId), JSON.stringify(d));
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
    if (typeof d.ownerId !== 'string' || typeof d.documentId !== 'string' || typeof d.paperId !== 'string' || typeof d.baseRevisionId !== 'string' || typeof d.savedAt !== 'number' || d.schemaVersion !== EDITOR_SCHEMA_VERSION) return null;
    if (!validateDocument(d.content, d.schemaVersion).ok) return null;
    return d as Draft;
  } catch {
    return null;
  }
}

export function loadDraft(storage: Storage, ownerId: string, documentId: string, now: number): Draft | null {
  if (!isRecoveryEnabled(storage, ownerId)) return null;
  const key = draftKey(ownerId, documentId);
  const d = parse(attempt(() => storage.getItem(key), null));
  const usable = d && d.ownerId === ownerId && d.documentId === documentId && now - d.savedAt <= RETENTION_MS && d.savedAt <= now + 60_000;
  if (!usable) {
    attempt(() => storage.removeItem(key), undefined);
    return null;
  }
  return d;
}

export const clearDraft = (storage: Storage, ownerId: string, documentId: string) => attempt(() => storage.removeItem(draftKey(ownerId, documentId)), undefined);

export function purgeExpired(storage: Storage, now: number): void {
  for (const k of keys(storage)) {
    if (!k.startsWith(`${PREFIX}draft:`)) continue;
    const d = parse(attempt(() => storage.getItem(k), null));
    if (!d || now - d.savedAt > RETENTION_MS) attempt(() => storage.removeItem(k), undefined);
  }
}

export function clearAllRecoveryData(storage: Storage): void {
  for (const k of keys(storage)) attempt(() => storage.removeItem(k), undefined);
}

// The signed-in account, set by the app shell; the editor stores drafts under it.
let currentOwner: string | null = null;
export const setRecoveryOwner = (ownerId: string | null) => { currentOwner = ownerId; };
export const recoveryOwner = () => currentOwner;

// browser storage, or null where none is available
export const browserStorage = (): Storage | null => attempt(() => window.localStorage, null);
