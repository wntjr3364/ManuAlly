// Review of a saved paragraph (PW-044): ask for a review, read each finding — the exact words it is
// about, why, the record it rests on and how sure the reviewer is, with an alternative — and accept or
// dismiss it. Accepted findings can be turned into one repair, which arrives as a proposal in "문단
// 작성" (it is checked like any other and applied only by the user). There is no quality score.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../../app/api.ts';

interface Finding {
  id: string; kind: 'scientific' | 'writing'; category: string; quote: string; reason: string; source: { kind: string; id: string } | null;
  confidence: 'low' | 'medium' | 'high'; alternative: string | null; warnings: string[]; decision: 'open' | 'accepted' | 'dismissed'; note: string | null;
}
interface Run {
  id: string; job_id: string; independence: 'human_written' | 'same_model' | 'different_model'; generator_label: string | null; created_at: string;
  findings: Finding[]; dropped: { quote: string; reason: string }[];
  repair: null | { job_status: string; proposal_id: string | null; proposal_status: string | null; needs_user: boolean };
}
interface Block { id: string; text: string; type: string }

const CATEGORY: Record<string, string> = {
  overclaim: '과장', causal_language: '인과 단정', logic_gap: '논리 비약', missing_counterevidence: '반대 근거 누락', negation: '부정', section_role: '섹션 역할', evidence_mismatch: '근거 불일치',
  repetition: '반복', density: '정보 밀도', transition: '연결', length: '길이', concision: '간결함', genre: '장르', clarity: '명료성', other: '기타',
};
const SOURCE: Record<string, string> = { claim: '승인된 주장', fact: '검증된 사실', evidence: '근거', profile: '글쓰기 프로필', gate: '결정적 검사' };
const CONFIDENCE: Record<string, string> = { low: '낮음', medium: '보통', high: '높음' };
const INDEPENDENCE: Record<string, string> = {
  human_written: '사용자가 쓴 문단의 검토',
  same_model: '이 문단을 쓴 모델과 같은 모델의 검토 — 독립적인 사실 검증이 아닙니다',
  different_model: '다른 모델이 쓴 문단의 검토',
};
const DROPPED: Record<string, string> = { span_not_found: '문단에 없는 문구', span_ambiguous: '문단에 여러 번 나오는 문구', unknown_source: '주어지지 않은 근거' };

export function ReviewPanel({ paperId, documentId, headId, clean, onRepair }: { paperId: string; documentId: string; headId: string; clean: boolean; onRepair: () => void }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [blockId, setBlockId] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const waiting = useRef<number | null>(null);
  useEffect(() => {
    api<{ head: { content_json: { content?: { type: string; attrs?: { id?: string }; content?: { text?: string }[] }[] } } }>('GET', `/api/papers/${paperId}/documents/${documentId}`).then((d) => {
      setBlocks((d.head.content_json.content ?? []).filter((b) => b.attrs?.id && b.type === 'paragraph').map((b) => ({ id: b.attrs!.id!, type: b.type, text: (b.content ?? []).map((c) => c.text ?? '').join('') })));
    }).catch((e) => setError(errorText(e)));
  }, [paperId, documentId, headId]);
  const load = useCallback(async (id = blockId) => {
    if (!id) { setRuns([]); return []; }
    const r = await api<Run[]>('GET', `/api/papers/${paperId}/reviews?document_id=${documentId}&block_id=${id}`);
    setRuns(r);
    return r;
  }, [paperId, documentId, blockId]);
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [load]);
  useEffect(() => () => { if (waiting.current) clearInterval(waiting.current); }, []);

  // poll until the condition holds (a new run, or the repair's proposal)
  const until = (done: (r: Run[]) => boolean, after: () => void) => {
    let n = 0;
    if (waiting.current) clearInterval(waiting.current);
    waiting.current = window.setInterval(() => {
      n++;
      void load().then((r) => {
        if (done(r) || n > 40) { clearInterval(waiting.current!); waiting.current = null; setNote(done(r) ? '' : '아직 결과가 없습니다 — AI 실행 탭에서 상태를 확인하세요'); after(); }
      }).catch(() => {});
    }, 750);
  };
  const request = async () => {
    setError('');
    try {
      const before = runs[0]?.id ?? null;
      await api('POST', `/api/papers/${paperId}/reviews`, { document_id: documentId, revision_id: headId, block_id: blockId, idempotency_key: crypto.randomUUID() });
      setNote('검토를 요청했습니다.');
      until((r) => (r[0]?.id ?? null) !== before, () => {});
    } catch (e) {
      setError(errorText(e));
    }
  };
  const decide = async (f: Finding, decision: 'accepted' | 'dismissed') => {
    setError('');
    try {
      await api('POST', `/api/papers/${paperId}/reviews/findings/${f.id}/decide`, { intent: 'decide_finding', decision });
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const repair = async (run: Run) => {
    setError('');
    try {
      await api('POST', `/api/papers/${paperId}/reviews/${run.id}/repair`, { intent: 'repair_paragraph', idempotency_key: crypto.randomUUID() });
      setNote('채택한 지적으로 고쳐 쓰기를 요청했습니다. 결과는 "문단 작성"의 제안으로 나타납니다.');
      until((r) => !!r.find((x) => x.id === run.id)?.repair?.proposal_id || !!r.find((x) => x.id === run.id)?.repair?.needs_user, onRepair);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const run = runs[0];

  return (
    <section className="card" aria-label="문단 검토" data-testid="review">
      <h2 style={{ margin: 0 }}>문단 검토</h2>
      <p className="hint">과학 검토(과장·인과·논리·반대 근거)와 문체 검토(반복·밀도·연결·길이)의 지적을 문구·이유·근거·확신도와 함께 보여 줍니다. 점수는 없고, 채택은 사용자가 합니다. 고쳐 쓰기는 검토 한 번에 한 번입니다.</p>
      {note && <p role="status">{note}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <label>검토할 문단 <select value={blockId} onChange={(e) => setBlockId(e.target.value)}>
        <option value="">선택</option>
        {blocks.map((b) => <option key={b.id} value={b.id}>{b.text.slice(0, 50) || '(빈 문단)'}</option>)}
      </select></label>
      <button type="button" disabled={!blockId || !clean} onClick={() => void request()}>검토 요청</button>

      {run && (
        <div data-testid="review-run">
          <p className="hint" data-testid="review-independence">{INDEPENDENCE[run.independence]}{run.generator_label ? ` · ${run.generator_label}` : ''}</p>
          {!run.findings.length && <p data-testid="review-empty">지적이 없습니다.</p>}
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {run.findings.map((f) => (
              <li key={f.id} className="card" data-testid="review-finding" data-decision={f.decision}>
                <strong>{f.kind === 'scientific' ? '과학' : '문체'} · {CATEGORY[f.category] ?? f.category}</strong> <span className="hint">확신도 {CONFIDENCE[f.confidence]}</span>
                <p>“<mark>{f.quote}</mark>”</p>
                <p>{f.reason}</p>
                {f.source && <p className="hint">근거: {SOURCE[f.source.kind] ?? f.source.kind}</p>}
                {f.alternative && <p data-testid="review-alternative">대안: {f.alternative}</p>}
                {f.warnings.map((x) => <p key={x} className="error">대안에 근거에 없는 수치가 있습니다: {x.split(':')[1]}</p>)}
                {f.decision === 'open' ? (
                  <div className="toolbar">
                    <button type="button" onClick={() => void decide(f, 'accepted')}>채택</button>
                    <button type="button" onClick={() => void decide(f, 'dismissed')}>기각</button>
                  </div>
                ) : <p className="status" data-testid="review-decision">{f.decision === 'accepted' ? '채택함' : '기각함'}</p>}
              </li>
            ))}
          </ul>
          {run.dropped.length > 0 && <p className="hint">버린 지적 {run.dropped.length}개: {run.dropped.map((d) => DROPPED[d.reason] ?? d.reason).join(', ')}</p>}
          {!run.repair && (
            <button type="button" disabled={!run.findings.some((f) => f.decision === 'accepted') || !clean} onClick={() => void repair(run)}>채택한 지적으로 고쳐 쓰기 (한 번)</button>
          )}
          {run.repair && (
            <p data-testid="review-repair" className={run.repair.needs_user ? 'error' : undefined}>
              {run.repair.needs_user
                ? '고쳐 쓴 안을 적용할 수 없습니다(검사 실패·근거 부족 등). 다시 시도하지 않습니다 — 직접 고치거나 다시 검토하세요.'
                : run.repair.proposal_id ? '고쳐 쓴 안이 "문단 작성"에 제안으로 있습니다.' : '고쳐 쓰는 중…'}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
