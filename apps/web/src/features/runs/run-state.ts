// What a run's stored state means for the user (PW-028). Labels come only from the job row the server
// stores, so a page that reconnects (reload, network back, another tab) shows the same final state as
// the database. "Finished" is spelled out: an answer, a proposal waiting to be applied, or nothing.
export interface RunRow {
  id: string; intent: string; status: string; attempts: number; last_error: string | null;
  result: Record<string, unknown> | null; created_at: string; finished_at: string | null;
}
export const AI_INTENTS = ['ask_selection', 'revise_selection', 'draft_paragraph', 'review', 'extract_facts', 'literature_search'];
export const ACTIVE = ['QUEUED', 'RUNNING', 'WAITING_QUOTA', 'WAITING_AUTH', 'WAITING_BUDGET', 'WAITING_USER'];
export const isActive = (r: Pick<RunRow, 'status'>) => ACTIVE.includes(r.status);

const INTENT: Record<string, string> = {
  ask_selection: '선택 부분 질문', revise_selection: '선택 부분 교정', draft_paragraph: '문단 초안', review: '검토', extract_facts: '사실 추출', literature_search: '문헌 검색',
};
export const intentLabel = (i: string) => INTENT[i] ?? i;

export function statusLabel(r: Pick<RunRow, 'status' | 'result'>): string {
  switch (r.status) {
    case 'QUEUED': return '대기 중';
    case 'RUNNING': return '실행 중';
    case 'SUCCEEDED': {
      const kind = r.result?.kind;
      if (kind === 'proposal') return '제안 준비됨 — 적용은 원고에서 따로';
      if (kind === 'answer') return '답변 완료 — 원고는 바뀌지 않음';
      if (kind === 'no_change') return '바꿀 것 없음 — 원고는 바뀌지 않음';
      return '완료';
    }
    case 'FAILED': return '실패 — 원고는 바뀌지 않음';
    // a proposal the run made before the stop stays in the proposal list for review; nothing after it
    case 'CANCELLED': return '취소됨 — 취소 뒤 결과는 반영되지 않음';
    case 'STALE': return '원고가 바뀌어 중단됨 — 결과 없음';
    case 'WAITING_QUOTA': return '사용량 한도 — 대기 중';
    case 'WAITING_AUTH': return 'AI 로그인 필요 — 대기 중';
    case 'WAITING_BUDGET': return '예산 확인 필요 — 대기 중';
    case 'WAITING_USER': return '사용자 확인 필요 — 대기 중';
    default: return r.status;
  }
}

// newest first; only AI runs
export const aiRuns = (rows: RunRow[]) => rows.filter((r) => AI_INTENTS.includes(r.intent));
