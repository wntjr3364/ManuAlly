// One run's control state as the server stores it (PW-054, spec 08 "웹 상태"): status and reason, the last
// classified error with the owner's next step, provider, last checkpoint, context (measured, estimated or
// unknown), quota waits with a known or unknown reset, the auto-resume permission, and stop / resume. Read
// from the server whenever the run's status changes, so it shows the database's state. Resume and
// auto-resume are the owner's acts; neither applies anything to the manuscript.
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../../app/api.ts';
import { statusLabel } from '../runs/run-state.ts';
import { UNKNOWN } from '../usage/format.ts';
import { actionText, autoResumeText, checkpointText, contextText, waitText, type AutoResume, type Checkpoint, type Context, type Wait } from './format.ts';

interface Control {
  job: { id: string; intent: string; status: string; attempts: number; last_error: string | null };
  checkpoint: Checkpoint | null;
  context: Context;
  quota_waits: (Wait & { attempt: number; provider: string })[];
  auto_resume: AutoResume;
  last_error: { class: string; action: string; provider: string } | null;
  actions: { cancel: boolean; resume: boolean; auto_resume: boolean };
}

export function RunControl({ paperId, jobId, status, onChanged }: { paperId: string; jobId: string; status: string; onChanged: () => void }) {
  const [c, setC] = useState<Control | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hours, setHours] = useState(6);
  const load = useCallback(async () => {
    try {
      setC(await api<Control>('GET', `/api/papers/${paperId}/jobs/${jobId}/control`));
    } catch (e) {
      setError(errorText(e));
    }
  }, [paperId, jobId]);
  useEffect(() => { void load(); }, [load, status]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      await load();
      onChanged();
    }
  };
  if (!c) return <p className="loading" data-testid="run-control">{error || '불러오는 중…'}</p>;
  const base = `/api/papers/${paperId}/jobs/${jobId}`;
  const stopped = c.job.status === 'FAILED' || c.job.status === 'STALE' || c.job.status.startsWith('WAITING_');
  return (
    <div className="run-control" data-testid="run-control" data-status={c.job.status}>
      {error && <p role="alert" className="error">{error}</p>}
      <dl>
        <dt>상태</dt><dd data-testid="ctl-status">{statusLabel({ status: c.job.status, result: null })}{c.job.attempts > 1 ? ` · ${c.job.attempts}번째 시도` : ''}</dd>
        {/* why it stopped or waits: only while it does (a queued or running job's old reason is history) */}
        {stopped && c.job.last_error && <><dt>사유</dt><dd data-testid="ctl-reason">{c.job.last_error.slice(0, 300)}</dd></>}
        {stopped && c.last_error && <><dt>다음 행동</dt><dd data-testid="ctl-next">{actionText(c.last_error.action)}</dd></>}
        <dt>공급자</dt><dd data-testid="ctl-provider">{c.checkpoint?.provider ?? c.last_error?.provider ?? UNKNOWN}</dd>
        <dt>마지막 checkpoint</dt><dd data-testid="ctl-checkpoint">{checkpointText(c.checkpoint)}</dd>
        <dt>문맥(마지막 요청)</dt><dd data-testid="ctl-context">{contextText(c.context)}</dd>
        {c.quota_waits.length > 0 && <><dt>한도 대기</dt><dd><ul data-testid="ctl-waits">{c.quota_waits.map((w) => <li key={w.attempt}>{w.attempt}번째 대기 · {w.provider} · {waitText(w)}</li>)}</ul></dd></>}
        <dt>자동 재개</dt><dd data-testid="ctl-auto-resume">{autoResumeText(c.auto_resume)}</dd>
      </dl>
      <div className="actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {c.actions.resume && (
          <button type="button" data-testid="ctl-resume" disabled={busy} onClick={() => void act(() => api('POST', `${base}/resume`, { intent: 'resume_job' }))}
            title="새 실행이 처음부터 다시 확인합니다. 결과는 제안이며 원고 적용은 직접 합니다.">다시 시작</button>
        )}
        {c.actions.auto_resume && c.auto_resume.state !== 'allowed' && (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <label style={{ display: 'inline' }}>기간 <select style={{ width: 'auto', display: 'inline-block' }} value={hours} onChange={(e) => setHours(Number(e.target.value))} data-testid="ctl-hours">{[1, 6, 24, 72].map((h) => <option key={h} value={h}>{h}시간</option>)}</select></label>
            <button type="button" data-testid="ctl-allow" disabled={busy} onClick={() => void act(() => api('POST', `${base}/auto-resume`, { intent: 'allow_auto_resume', hours }))}>자동 재개 허용</button>
          </span>
        )}
        {c.actions.auto_resume && c.auto_resume.state === 'allowed' && (
          <button type="button" data-testid="ctl-revoke" disabled={busy} onClick={() => void act(() => api('POST', `${base}/auto-resume`, { intent: 'revoke_auto_resume' }))}>자동 재개 철회</button>
        )}
        {c.actions.cancel && <button type="button" data-testid="ctl-cancel" disabled={busy} onClick={() => void act(() => api('POST', `${base}/cancel`, {}))}>중지</button>}
      </div>
    </div>
  );
}
