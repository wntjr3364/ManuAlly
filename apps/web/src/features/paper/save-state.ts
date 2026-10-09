// Save status of the manuscript editor (spec 04 "저장·접근성": no "저장됨" before the server acks).
// Every edit bumps a local version. A save carries the version it sent; only the acknowledgement of
// the version that is still on screen shows 저장됨. Failures and conflicts stay unsaved.
export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'failed' | 'conflict';

export interface SaveState {
  status: SaveStatus;
  editVersion: number;
  inFlight: number | null;
  headRevisionId: string;
  error: string | null;
}

export type SaveAction =
  | { type: 'edit' }
  | { type: 'saveStart'; version?: number }
  | { type: 'saveOk'; version: number; headRevisionId: string }
  | { type: 'saveFailed'; version: number; error: string; conflict?: boolean }
  | { type: 'loaded'; headRevisionId: string };

export const initialSaveState = (headRevisionId: string): SaveState => ({ status: 'saved', editVersion: 0, inFlight: null, headRevisionId, error: null });

export function saveReducer(s: SaveState, a: SaveAction): SaveState {
  switch (a.type) {
    case 'loaded':
      return initialSaveState(a.headRevisionId);
    case 'edit':
      return { ...s, editVersion: s.editVersion + 1, status: s.inFlight !== null ? 'saving' : s.status === 'conflict' ? 'conflict' : 'dirty' };
    case 'saveStart':
      return { ...s, inFlight: a.version ?? s.editVersion, status: 'saving', error: null };
    case 'saveOk': {
      if (a.version !== s.inFlight) return s; // a late answer to an older request
      const current = a.version === s.editVersion;
      return { ...s, inFlight: null, headRevisionId: a.headRevisionId, status: current ? 'saved' : 'dirty', error: null };
    }
    case 'saveFailed':
      if (a.version !== s.inFlight) return s;
      return { ...s, inFlight: null, status: a.conflict ? 'conflict' : 'failed', error: a.error };
  }
}

export const isUnsaved = (s: SaveState) => s.status !== 'saved';

export function saveLabel(s: SaveState): string {
  switch (s.status) {
    case 'saved':
      return '저장됨';
    case 'dirty':
      return '저장 안 됨 (변경 있음)';
    case 'saving':
      return '저장 중… (아직 저장되지 않음)';
    case 'failed':
      return `저장 실패 — 저장되지 않았습니다${s.error ? ` (${s.error})` : ''}`;
    case 'conflict':
      return '다른 곳에서 먼저 바뀐 원고 — 이 내용은 저장되지 않았습니다. 새로고침 전 내용을 복사해 두세요.';
  }
}
