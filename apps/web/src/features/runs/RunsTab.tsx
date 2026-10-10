// AI runs of this paper as the server stores them (PW-028). The list is read from the database on
// open, while a run is active, when the tab becomes visible again and when the network comes back —
// so after any reconnect the page shows the stored final state. "중지" stores the cancel on the
// server; the worker then interrupts the provider and ends only that run's processes.
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../../app/api.ts';
import { aiRuns, intentLabel, isActive, statusLabel, type RunRow } from './run-state.ts';

const when = (t: string) => new Date(t).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'medium' });

export function RunsTab({ paperId, visible }: { paperId: string; visible: boolean }) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRuns(aiRuns(await api<RunRow[]>('GET', `/api/papers/${paperId}/jobs`)));
      setOffline(false);
    } catch {
      setOffline(true); // keep the last list, marked as possibly outdated
    }
  }, [paperId]);

  useEffect(() => { if (visible) void load(); }, [visible, load]);
  // while something is active, read again every 2 s
  const active = !!runs?.some(isActive);
  useEffect(() => {
    if (!visible || (!active && !offline)) return;
    const t = setInterval(() => { void load(); }, 2000);
    return () => clearInterval(t);
  }, [visible, active, offline, load]);
  // reconnects: the tab comes back, the network comes back
  useEffect(() => {
    const again = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('online', again);
    document.addEventListener('visibilitychange', again);
    return () => { window.removeEventListener('online', again); document.removeEventListener('visibilitychange', again); };
  }, [load]);

  const stop = async (id: string) => {
    setBusy(id);
    setError('');
    try {
      await api('POST', `/api/papers/${paperId}/jobs/${id}/cancel`, {});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      await load();
    }
  };

  if (!runs) return <p className="loading">{offline ? '연결되지 않음 — 다시 연결되면 저장된 상태를 읽습니다' : '불러오는 중…'}</p>;
  return (
    <section aria-label="AI 실행">
      <h2>AI 실행</h2>
      {offline && <p role="status" data-testid="runs-offline" className="warn">연결 끊김 — 아래는 마지막으로 읽은 상태입니다. 다시 연결되면 저장된 상태를 다시 읽습니다.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {!runs.length && <p className="hint">아직 AI 실행이 없습니다.</p>}
      <ul className="runs">
        {runs.map((r) => (
          <li key={r.id} data-testid="run" data-run-id={r.id} data-status={r.status}>
            <strong>{intentLabel(r.intent)}</strong> · <span>{when(r.created_at)}</span>
            {' · '}<span data-testid="run-status">{statusLabel(r)}</span>
            {r.attempts > 1 && <span className="hint"> · {r.attempts}번째 시도</span>}
            {/* why it stopped or waits, and the owner's next step (PW-052: also for WAITING_* and STALE) */}
            {(r.status === 'FAILED' || r.status === 'STALE' || r.status.startsWith('WAITING_')) && r.last_error && <p className="hint" data-testid="run-reason">사유: {r.last_error.slice(0, 300)}</p>}
            {isActive(r) && ' '}
            {isActive(r) && (
              <button type="button" disabled={busy === r.id || offline} onClick={() => void stop(r.id)}>중지</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
