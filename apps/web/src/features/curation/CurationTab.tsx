// Literature candidates and the AI's suggestions for this paper (PW-033). Each suggestion shows its use
// (scientific / writing / both / excluded), fit, how much was actually read, the reasons and why a
// candidate was excluded. Nothing is adopted until the owner accepts it with a use.
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../../app/api.ts';
import { MockBadge } from '../chat/JobStream.tsx';
import { DECISION, DEPTH, FIT, ROLE, STYLE, WARNING } from './labels.ts';

interface Assessment {
  id: string; title: string; doi: string | null; year: number | null; container: string | null; role: string; topic_fit: string; article_type_fit: string; style_fit: string;
  read_depth: string; reasons: string; exclusion_reason: string | null; warnings: string[]; decision: string; decided_use_role: string | null;
}
interface View { runs: { id: string; assessor: string; assessor_label: string | null; created_at: string }[]; assessments: Assessment[]; searches: { id: string; source: string; query: string; observed_at: string; candidates: number }[] }

export function CurationTab({ paperId, visible }: { paperId: string; visible: boolean }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [useRole, setUseRole] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    try { setView(await api<View>('GET', `/api/papers/${paperId}/curation`)); setError(''); } catch (e) { setError(errorText(e)); }
  }, [paperId]);
  useEffect(() => { if (visible) void load(); }, [visible, load]);

  const request = async () => {
    if (!view?.searches.length) return;
    try {
      await api('POST', `/api/papers/${paperId}/curation/runs`, { search_ids: view.searches.slice(0, 5).map((s) => s.id), idempotency_key: crypto.randomUUID() });
      setNote('평가를 요청했습니다. 끝나면 아래에 제안이 나타납니다(새로 고침).');
    } catch (e) { setError(errorText(e)); }
  };
  const retracted = (a: Assessment) => a.warnings.includes('retracted');
  const roleOf = (a: Assessment) => useRole[a.id] ?? (retracted(a) ? 'writing' : a.role === 'exclude' ? 'scientific' : a.role);
  const decide = async (a: Assessment, decision: 'accepted' | 'rejected') => {
    try {
      await api('POST', `/api/papers/${paperId}/curation/assessments/${a.id}/decision`, decision === 'accepted' ? { decision, use_role: roleOf(a) } : { decision });
      await load();
    } catch (e) { setError(errorText(e)); }
  };

  if (!view) return <p className="loading">{error || '불러오는 중…'}</p>;
  const run = view.runs[0];
  return (
    <section aria-label="문헌 후보">
      <h2>문헌 후보</h2>
      {error && <p role="alert" className="error">{error}</p>}
      <p className="hint">검색 {view.searches.length}건 · 후보 {view.searches.reduce((n, s) => n + s.candidates, 0)}개</p>
      <button type="button" onClick={() => void request()} disabled={!view.searches.length}>후보 평가 요청</button>{' '}
      <button type="button" onClick={() => void load()}>새로 고침</button>
      {note && <p role="status" className="hint">{note}</p>}
      {run && <p className="hint" data-testid="curation-run">평가: {run.assessor} <MockBadge label={run.assessor_label} /> · {new Date(run.created_at).toLocaleString('ko-KR')} · AI 제안이며 채택은 직접 결정합니다</p>}
      <ul className="curation">
        {view.assessments.map((a) => (
          <li key={a.id} data-testid="assessment" data-role={a.role} data-decision={a.decision}>
            <strong>{a.title}</strong>{a.year ? ` (${a.year})` : ''}{a.container ? ` · ${a.container}` : ''}{a.doi ? ` · doi:${a.doi}` : ''}
            <p>
              <span data-testid="assessment-role">{ROLE[a.role] ?? a.role}</span>
              {' · 주제 적합 '}{FIT[a.topic_fit]}{' · 논문 유형 적합 '}{FIT[a.article_type_fit]}
              {' · 문체 '}<span data-testid="assessment-style">{STYLE[a.style_fit]}</span>
              {' · 읽은 범위 '}<span data-testid="assessment-depth">{DEPTH[a.read_depth] ?? a.read_depth}</span>
            </p>
            <p className="hint">이유: {a.reasons}</p>
            {a.exclusion_reason && <p className="hint" data-testid="assessment-exclusion">제외 이유: {a.exclusion_reason}</p>}
            {a.warnings.map((w) => <p key={w} className="warn" data-testid="assessment-warning">{WARNING[w] ?? w}</p>)}
            {a.decision === 'pending' ? (
              <p>
                <label>용도 <select value={roleOf(a)} onChange={(e) => setUseRole({ ...useRole, [a.id]: e.target.value })}>
                  <option value="scientific" disabled={retracted(a)}>과학 근거</option><option value="writing">문체 참고</option><option value="both" disabled={retracted(a)}>둘 다</option>
                </select></label>{' '}
                <button type="button" onClick={() => void decide(a, 'accepted')}>채택</button>{' '}
                <button type="button" onClick={() => void decide(a, 'rejected')}>채택 안 함</button>
              </p>
            ) : <p data-testid="assessment-decision">{DECISION[a.decision]}{a.decided_use_role ? ` · ${ROLE[a.decided_use_role] ?? a.decided_use_role}` : ''}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
