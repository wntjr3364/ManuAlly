// How the run control panel words a run's stored state (PW-054, spec 08 "웹 상태"). Unknown is said as such
// (never 0 or a percentage); an estimate is rounded and called an estimate; a reset that is not known is
// "초기화 시각 확인 불가" with the next check; auto-resume is described as making a proposal only — applying
// it to the manuscript is always the owner's act. Times are shown in Asia/Seoul.
import { kst, UNKNOWN } from '../usage/format.ts';

export interface Context { tokens: number | null; window: number | null; source: 'provider_reported' | 'estimated' | 'unknown'; observed_at: string | null }
export interface Wait { wake_at: string; reset_known: boolean; state: string }
export interface AutoResume { state: 'allowed' | 'not_allowed' | 'expired'; expires_at: string | null }
export interface Checkpoint { seq: number; boundary: string; pending_step: string | null; provider: string | null; created_at: string }

const n = (v: number) => v.toLocaleString('ko-KR');

export function contextText(c: Context): string {
  if (c.source === 'unknown' || c.tokens === null) return UNKNOWN;
  if (c.source === 'estimated') {
    const t = c.tokens >= 1000 ? Math.round(c.tokens / 1000) * 1000 : c.tokens;
    return c.window ? `약 ${n(t)} / ${n(c.window)} 토큰 (약 ${Math.round((c.tokens / c.window) * 100)}%, 추정)` : `약 ${n(t)} 토큰 (창 크기 알 수 없음, 추정)`;
  }
  return c.window ? `${n(c.tokens)} / ${n(c.window)} 토큰 (${Number(((c.tokens / c.window) * 100).toFixed(1))}%, 공급자 보고)` : `${n(c.tokens)} 토큰 (창 크기 알 수 없음, 공급자 보고)`;
}

const WAIT_STATE: Record<string, string> = { resumed: '다시 시작됨', rescheduled: '다시 미뤄짐', to_user: '사용자 확인으로 넘김', to_auth: '로그인 필요로 넘김', stale: '원고가 바뀌어 끝남', closed: '닫힘' };
export function waitText(w: Wait): string {
  if (w.state !== 'waiting') return `끝난 대기 (${WAIT_STATE[w.state] ?? w.state})`;
  return w.reset_known ? `초기화 뒤 확인: ${kst(w.wake_at)}` : `초기화 시각 확인 불가 — 다음 확인: ${kst(w.wake_at)}`;
}

const APPLY = '자동 재개는 초안·제안을 만드는 데까지만 합니다. 원고 적용은 언제나 직접 승인합니다.';
export function autoResumeText(a: AutoResume): string {
  if (a.state === 'allowed') return `허용됨 (${kst(a.expires_at!)}까지). ${APPLY}`;
  if (a.state === 'expired') return `허용 기간 만료 (${a.expires_at ? kst(a.expires_at) : UNKNOWN}). 한도가 풀려도 저절로 다시 시작하지 않습니다. ${APPLY}`;
  return `허용하지 않음 — 한도가 풀려도 저절로 다시 시작하지 않습니다. ${APPLY}`;
}

const BOUNDARY: Record<string, string> = { before_call: '모델 호출 전', after_validation: '답 검증 뒤', after_proposal: '제안 저장 뒤', session_change: '세션 교체', maintenance: '점검' };
const STEP: Record<string, string> = { provider_call: '모델 호출', store_proposal: '제안 저장' };
export function checkpointText(c: Checkpoint | null): string {
  if (!c) return '아직 없음';
  const step = c.pending_step ? (STEP[c.pending_step] ?? c.pending_step) : '없음';
  return `#${c.seq} ${BOUNDARY[c.boundary] ?? c.boundary} · 남은 단계: ${step} · ${kst(c.created_at)}`;
}

const ACTION: Record<string, string> = {
  wait_for_reset: '한도가 초기화되기를 기다림', log_in_again: '작업을 돌리는 컴퓨터에서 공급자 CLI로 다시 로그인', set_budget: '예산을 정한 뒤 다시 시작',
  add_evidence: '근거를 추가·확인한 뒤 다시 요청', ask_again: '현재 원고에서 다시 요청', free_disk_space: '디스크 공간을 확보한 뒤 다시 요청', report: '문제로 보고', none: '자동으로 다시 시도',
};
export const actionText = (a: string) => ACTION[a] ?? a;

// the owner's next step for the current stop: a classified error's step only when that error led to this
// state (an older run's error may describe another stop: review m2); otherwise the state's own step. None
// while the job is queued or running.
const BY_STATE: Record<string, string> = {
  WAITING_QUOTA: '한도가 초기화되기를 기다림 (또는 다시 시작)', WAITING_AUTH: '작업을 돌리는 컴퓨터에서 공급자 CLI로 다시 로그인한 뒤 다시 시작',
  WAITING_BUDGET: '예산을 정한 뒤 다시 시작', WAITING_USER: '사유를 확인한 뒤 다시 시작하거나 중지', FAILED: '필요하면 다시 요청', STALE: '현재 원고에서 다시 요청',
};
export function nextStepText(status: string, last: { action: string; next_state: string } | null): string | null {
  if (!BY_STATE[status]) return null;
  return last && last.next_state === status ? actionText(last.action) : BY_STATE[status]!;
}
