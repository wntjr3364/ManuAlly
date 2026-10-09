// What the browser shows for one AI job (PW-020, spec 07 "job 완료(제안 생성)와 proposal 적용 완료를
// 별도 모델로 … UI의 '완료'는 무엇이 끝났는지 적는다"). Built only from the server's job events and
// the proposal's own status, so "answering", "proposal ready (not applied)" and "applied" never blur.

export type Phase =
  | 'queued' | 'running' | 'answering' | 'answered' | 'no_change'
  | 'proposal_ready' | 'applied' | 'rejected' | 'stale' | 'check_failed'
  | 'failed' | 'cancelled' | 'waiting';

export interface StreamState {
  phase: Phase;
  answer: string;
  lastSeq: number;
  // provider label from the run (MOCK); null until the run reports it, and never assumed "real"
  label: string | null;
  provider: string | null;
  proposalId: string | null;
  note: string;
  ended: boolean;
  // attempt number of the run whose events are shown (a retried job starts over)
  run: number | null;
}

export const initialState: StreamState = { phase: 'queued', answer: '', lastSeq: 0, label: null, provider: null, proposalId: null, note: '', ended: false, run: null };

const PROPOSAL_PHASE: Record<string, Phase> = { PENDING: 'proposal_ready', APPLIED: 'applied', REJECTED: 'rejected', STALE: 'stale', CHECK_FAILED: 'check_failed' };

export interface ServerEvent { event: string; id?: number; data: Record<string, unknown> }

const UNNUMBERED = ['job', 'end', 'rotate'];

export function reduce(s: StreamState, e: ServerEvent): StreamState {
  // a resent event (reconnect) is ignored. Only stored job events are numbered: the browser's
  // EventSource repeats the last id on 'job'/'end' messages, which carry none of their own.
  if (e.id !== undefined && !UNNUMBERED.includes(e.event)) {
    if (e.id <= s.lastSeq) return s;
    s = { ...s, lastSeq: e.id };
  }
  const d = e.data;
  switch (e.event) {
    case 'status': {
      // every run reports exactly one status, first: a new run (retry after a failure or an expired
      // lease) replaces whatever an earlier run sent — also for events stored without a run number
      const run = typeof d.run === 'number' ? d.run : null;
      return { ...s, run, phase: 'running', answer: '', note: '', label: (d.label as string | null) ?? null, provider: (d.provider as string) ?? null };
    }
    case 'delta':
      return { ...s, phase: 'answering', answer: s.answer + String(d.text ?? '') };
    case 'answer_done':
      return { ...s, phase: 'answered' };
    case 'no_change':
      return { ...s, phase: 'no_change', note: String(d.explanation ?? '') };
    case 'proposal':
      return { ...s, phase: PROPOSAL_PHASE[String(d.status)] ?? 'proposal_ready', proposalId: String(d.proposal_id), note: (d.reason as string) ?? '' };
    case 'job': {
      const st = String(d.status);
      if (st === 'RUNNING' && s.phase === 'queued') return { ...s, phase: 'running' };
      // queued again: a failed run waits for its retry (its partial answer is not a result)
      if (st === 'QUEUED' && s.phase !== 'queued') return { ...s, phase: 'queued', note: '다시 시도 대기' };
      if (st.startsWith('WAITING_')) return { ...s, phase: 'waiting', note: st };
      return s;
    }
    case 'end': {
      const st = String(d.status);
      const next = { ...s, ended: true };
      if (st === 'CANCELLED') return { ...next, phase: 'cancelled' };
      if (st === 'FAILED' || st === 'STALE') return { ...next, phase: 'failed', note: String(d.last_error ?? '') };
      if (st.startsWith('WAITING_')) return { ...next, phase: 'waiting', note: st };
      return next;
    }
    default:
      return s;
  }
}

// the proposal's own status, read again after the owner applied or rejected it
export const withProposalStatus = (s: StreamState, status: string): StreamState => (s.proposalId && PROPOSAL_PHASE[status] ? { ...s, phase: PROPOSAL_PHASE[status]! } : s);

export const PHASE_LABEL: Record<Phase, string> = {
  queued: '대기 중',
  running: '작업 중',
  answering: '답변 작성 중…',
  answered: '답변 완료 — 원고는 바뀌지 않음',
  no_change: '고칠 부분 없음 — 원고 변경 없음',
  proposal_ready: '수정 제안 준비됨 — 아직 원고에 적용되지 않음',
  applied: '수정 제안 적용됨 — 원고에 반영',
  rejected: '수정 제안 거절됨',
  stale: '원고가 바뀌어 적용할 수 없는 제안(STALE)',
  check_failed: '검사 실패 — 적용할 수 없는 제안',
  failed: '실패',
  cancelled: '취소됨 — 결과 없음',
  waiting: '대기 중(외부 조건)',
};

// answer text of a run that did not finish: shown only as an interrupted fragment, never as a result
export const partialAnswer = (s: StreamState) => s.answer !== '' && s.phase !== 'answering' && s.phase !== 'answered';

export const canCancel = (s: StreamState) => !s.ended && ['queued', 'running', 'answering', 'waiting'].includes(s.phase);
