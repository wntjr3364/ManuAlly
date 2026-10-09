// AI jobs of this manuscript and their live progress (PW-020). Each job is read over Server-Sent
// Events; the browser resumes from the last event it saw after a dropped connection, and leaving the
// page never cancels a job (only the "취소" button does). Mock output always carries a MOCK badge.
import { useEffect, useReducer, useState } from 'react';
import { api, errorText } from '../../app/api.ts';
import { PHASE_LABEL, canCancel, initialState, reduce, withProposalStatus, type ServerEvent, type StreamState } from './stream-state.ts';

export interface JobRef { id: string; intent: string; instruction: string; quote: string }
const INTENT_LABEL: Record<string, string> = { ask: '질문', grammar: '문법', concise: '간결화', rewrite: '학술적 재작성' };
const KINDS = ['status', 'delta', 'answer_done', 'proposal', 'no_change', 'job', 'end'];

type Action = ServerEvent | { event: 'proposal-status'; data: { status: string } };
const reducer = (s: StreamState, a: Action) => (a.event === 'proposal-status' ? withProposalStatus(s, String(a.data.status)) : reduce(s, a as ServerEvent));

export function MockBadge({ label }: { label: string | null }) {
  if (label !== 'MOCK') return null;
  return <span className="badge mock" data-testid="mock-badge" title="연결 시험용 모의 응답입니다. 실제 AI가 만든 결과가 아닙니다.">MOCK · 실제 AI 아님</span>;
}

function JobItem({ paperId, job, proposalRefresh, onProposal }: { paperId: string; job: JobRef; proposalRefresh: number; onProposal?: () => void }) {
  const [s, dispatch] = useReducer(reducer, initialState);
  const [conn, setConn] = useState<'open' | 'retrying' | 'lost'>('open');
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (s.ended) return;
    // the browser's EventSource sends Last-Event-ID itself on automatic reconnects; a manual
    // reconnect after it gave up continues with ?after=
    const es = new EventSource(`/api/papers/${paperId}/jobs/${job.id}/events${s.lastSeq ? `?after=${s.lastSeq}` : ''}`);
    for (const kind of KINDS) {
      es.addEventListener(kind, (m) => {
        const ev = m as MessageEvent<string>;
        setConn('open');
        dispatch({ event: kind, id: ev.lastEventId ? Number(ev.lastEventId) : undefined, data: JSON.parse(ev.data) as Record<string, unknown> });
        if (kind === 'end') es.close();
      });
    }
    es.onerror = () => setConn(es.readyState === EventSource.CLOSED ? 'lost' : 'retrying');
    return () => es.close(); // leaving the page only closes the stream
  }, [paperId, job.id, attempt]);

  // a new proposal: let the proposal list show it
  useEffect(() => { if (s.proposalId) onProposal?.(); }, [s.proposalId]);

  // after an apply/reject elsewhere on the page, read the proposal's own status
  useEffect(() => {
    if (!s.proposalId) return;
    void api<{ proposal: { status: string } }>('GET', `/api/papers/${paperId}/proposals/${s.proposalId}`)
      .then((r) => dispatch({ event: 'proposal-status', data: { status: r.proposal.status } }))
      .catch(() => {});
  }, [paperId, s.proposalId, proposalRefresh]);

  const cancel = async () => {
    try {
      await api('POST', `/api/papers/${paperId}/jobs/${job.id}/cancel`, {});
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <li data-testid="ai-job" data-phase={s.phase} data-job-id={job.id}>
      <p>
        <strong>{INTENT_LABEL[job.intent] ?? job.intent}</strong>{job.quote && <> · “{job.quote.length > 60 ? `${job.quote.slice(0, 60)}…` : job.quote}”</>}
        {job.instruction && <> — {job.instruction}</>}
      </p>
      <p>
        <span role="status" data-testid="ai-job-phase">{PHASE_LABEL[s.phase]}{s.note && s.phase !== 'no_change' ? `: ${s.note}` : ''}</span>{' '}
        <MockBadge label={s.label} />
        {!s.ended && conn === 'retrying' && <span className="hint"> · 연결이 끊겨 다시 연결하는 중</span>}
        {!s.ended && conn === 'lost' && (
          <span className="hint"> · 연결 끊김(작업은 계속됨) <button type="button" onClick={() => { setConn('open'); setAttempt((n) => n + 1); }}>다시 연결</button></span>
        )}
      </p>
      {s.answer && <p className="answer" data-testid="ai-answer">{s.answer}</p>}
      {s.phase === 'proposal_ready' && <p className="hint">아래 “수정 제안”에서 차이를 확인하고 적용하거나 거절하세요.</p>}
      {canCancel(s) && <button type="button" onClick={cancel}>취소</button>}
      {error && <p role="alert" className="error">{error}</p>}
    </li>
  );
}

export function JobStreams({ paperId, documentId, jobs, proposalRefresh, onProposal }: { paperId: string; documentId: string; jobs: JobRef[]; proposalRefresh: number; onProposal?: () => void }) {
  // jobs of earlier visits (newest first) so an answer is still there after a reload
  const [earlier, setEarlier] = useState<JobRef[]>([]);
  useEffect(() => {
    void api<{ id: string; intent: string; payload: Record<string, unknown> }[]>('GET', `/api/papers/${paperId}/jobs`)
      .then((list) => setEarlier(list
        .filter((j) => ['ask_selection', 'revise_selection'].includes(j.intent) && j.payload.document_id === documentId)
        .slice(0, 5)
        .map((j) => ({ id: j.id, intent: String(j.payload.intent), instruction: String(j.payload.instruction ?? ''), quote: String(j.payload.quote_excerpt ?? '') }))))
      .catch(() => {});
  }, [paperId, documentId]);
  const all = [...jobs.slice().reverse(), ...earlier.filter((e) => !jobs.some((j) => j.id === e.id))];
  if (!all.length) return null;
  return (
    <section className="card" data-testid="ai-jobs" aria-label="AI 작업">
      <h3>AI 작업</h3>
      <ul className="plain">{all.map((j) => <JobItem key={j.id} paperId={paperId} job={j} proposalRefresh={proposalRefresh} onProposal={onProposal} />)}</ul>
    </section>
  );
}
