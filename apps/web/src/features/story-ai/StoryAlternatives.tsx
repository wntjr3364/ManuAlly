// Story alternatives (PW-039): ask the AI for alternatives built from the paper's settled material,
// compare them (message, evidence, competing explanations, limits, gaps) and adopt one as a new DRAFT
// story revision. Adopting is the user's act and does not approve anything; an alternative the system
// blocked (a number its evidence does not hold) cannot be adopted. Suggested claims stay text.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../../app/api.ts';

interface Evidence { kind: 'fact' | 'claim'; id: string; role: 'supports' | 'contradicts' | 'context'; text: string }
interface Alternative {
  id: string; position: number; title: string; question: string; main_message: string; presentation_order: string[]; evidence: Evidence[];
  competing_explanations: string[]; limitations: string[]; evidence_gaps: string[]; claim_suggestions: string[];
  warnings: string[]; blocked_reasons: string[]; adopted_story_revision_id: string | null;
}
interface Run { id: string; generator: string; label: string | null; base_story_revision_id: string; created_at: string; alternatives: Alternative[] }

const ROLE: Record<Evidence['role'], string> = { supports: '근거', contradicts: '반대 근거', context: '맥락' };
const WARNING: Record<string, string> = {
  no_supporting_evidence: '이 메시지를 받치는 근거가 연결되지 않았습니다',
  contradicting_evidence_linked: '반대되는 근거가 있습니다',
  same_as_current_story: '지금 스토리와 같은 메시지입니다',
};
const blockedText = (r: string) => (r.startsWith('number_not_in_evidence:') ? `수치 ${r.split(':')[1]}이(가) 연결된 근거나 사용자의 스토리에 없습니다` : r);

export function StoryAlternatives({ paperId, latestId, dirty, onAdopted }: { paperId: string; latestId: string | null; dirty: boolean; onAdopted: () => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const waiting = useRef<number | null>(null);
  const load = useCallback(async () => {
    const v = await api<{ runs: Run[] }>('GET', `/api/papers/${paperId}/story-alternatives`);
    setRuns(v.runs);
    return v.runs;
  }, [paperId]);
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [load]);
  useEffect(() => () => { if (waiting.current) clearInterval(waiting.current); }, []);

  const request = async () => {
    if (!latestId) return;
    setError('');
    try {
      const before = runs[0]?.id ?? null;
      await api('POST', `/api/papers/${paperId}/story-alternatives/runs`, { base_story_revision_id: latestId, idempotency_key: crypto.randomUUID() });
      setNote('대안을 요청했습니다. 준비되면 아래에 나타납니다.');
      let n = 0;
      if (waiting.current) clearInterval(waiting.current);
      waiting.current = window.setInterval(() => {
        n++;
        void load().then((r) => {
          if ((r[0]?.id ?? null) !== before || n > 40) { clearInterval(waiting.current!); waiting.current = null; setNote(r[0]?.id !== before ? '' : '아직 결과가 없습니다 — 작업 목록에서 상태를 확인하세요'); }
        }).catch(() => {});
      }, 750);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const adopt = async (a: Alternative) => {
    setError('');
    try {
      await api('POST', `/api/papers/${paperId}/story-alternatives/${a.id}/adopt`, { intent: 'adopt_story_alternative', parent_revision_id: latestId });
      setNote('새 스토리 초안을 만들었습니다. 내용을 확인하고 위에서 승인하세요.');
      await load();
      onAdopted();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const run = runs[0];
  return (
    <section className="card" aria-label="스토리 대안" data-testid="story-alternatives">
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>스토리 대안 {run?.label && <span className="status" data-testid="story-alt-label">{run.label}</span>}</h2>
        <button type="button" onClick={() => void request()} disabled={!latestId}>대안 요청</button>
      </div>
      <p className="hint">논문에 검증된 사실과 승인된 주장만으로 만든 안입니다. 채택하면 새 스토리 초안이 될 뿐, 승인은 위에서 따로 합니다. AI가 제안한 주장은 주장으로 등록되지 않습니다.</p>
      {!latestId && <p className="hint">먼저 스토리를 저장하세요.</p>}
      {note && <p role="status">{note}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {run && run.base_story_revision_id !== latestId && <p className="hint" data-testid="story-alt-stale">이 대안은 이전 스토리 버전을 바탕으로 했습니다.</p>}
      {run?.alternatives.map((a) => (
        <article key={a.id} className="card" data-testid="story-alternative">
          <h3>{a.title}</h3>
          <p><strong>질문</strong> {a.question}</p>
          <p data-testid="story-alt-message"><strong>핵심 메시지</strong> {a.main_message}</p>
          {a.presentation_order.length > 0 && <p><strong>제시 순서</strong> {a.presentation_order.join(' → ')}</p>}
          <div><strong>근거</strong>
            {a.evidence.length ? (
              <ul className="plain" data-testid="story-alt-evidence">{a.evidence.map((e) => <li key={`${e.kind}:${e.id}`} data-role={e.role}>[{ROLE[e.role]}] {e.kind === 'fact' ? '사실' : '주장'}: {e.text}</li>)}</ul>
            ) : <span> 연결된 근거 없음</span>}
          </div>
          {a.competing_explanations.length > 0 && <div><strong>경쟁 설명</strong><ul className="plain">{a.competing_explanations.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          <div><strong>한계</strong>{a.limitations.length ? <ul className="plain" data-testid="story-alt-limitations">{a.limitations.map((x, i) => <li key={i}>{x}</li>)}</ul> : <span> 적힌 한계 없음</span>}</div>
          {a.evidence_gaps.length > 0 && <div><strong>부족한 근거</strong><ul className="plain">{a.evidence_gaps.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          {a.claim_suggestions.length > 0 && <div><strong>주장 제안(등록되지 않음)</strong><ul className="plain">{a.claim_suggestions.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          {a.warnings.map((w) => <p key={w} className="warn" data-testid="story-alt-warning">{WARNING[w] ?? w}</p>)}
          {a.blocked_reasons.length > 0 && <p role="alert" className="error" data-testid="story-alt-blocked">채택할 수 없음: {a.blocked_reasons.map(blockedText).join('; ')}</p>}
          {a.adopted_story_revision_id
            ? <p className="hint" data-testid="story-alt-adopted">채택됨 — 스토리 초안 {a.adopted_story_revision_id.slice(0, 8)}</p>
            : <button type="button" disabled={a.blocked_reasons.length > 0 || dirty || !latestId} title={dirty ? '저장하지 않은 스토리 수정이 있습니다' : undefined} onClick={() => void adopt(a)}>이 안으로 새 스토리 초안</button>}
        </article>
      ))}
    </section>
  );
}
