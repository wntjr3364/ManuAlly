// Evidence records and facts. Everything starts as a candidate; verification is a separate explicit
// click that sends the content hash of what is shown. The number is entered exactly as in the source.
import { useEffect, useState } from 'react';
import { TracePanel } from '../evidence/TracePanel.tsx';
import { api, errorText } from '../../app/api.ts';
import { setUnsaved } from '../../app/unsaved.ts';

export interface Evidence { id: string; kind: string; label: string; locator: Record<string, unknown>; extraction_state: string; content_hash: string }
interface Fact { id: string; evidence_id: string; entity: string; metric: string; value_text: string; unit: string; group: string; comparison: string; n: number | null; verification_state: string; content_hash: string }

export function EvidenceTab({ paperId, visible }: { paperId: string; visible: boolean }) {
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [ev, setEv] = useState({ kind: 'method_record', note: '', label: '' });
  const [fact, setFact] = useState({ evidence_id: '', entity: '', metric: '', value_text: '', unit: '', group: '', comparison: '', n: '' });
  const [error, setError] = useState('');
  // typed but not yet added
  const evDirty = !!(ev.note.trim() || ev.label.trim());
  const factDirty = ['entity', 'metric', 'value_text', 'unit', 'group', 'comparison', 'n'].some((k) => fact[k as keyof typeof fact].trim());
  useEffect(() => {
    setUnsaved(`evidence-form:${paperId}`, evDirty ? '근거 입력' : null);
    setUnsaved(`fact-form:${paperId}`, factDirty ? '사실 입력' : null);
  }, [evDirty, factDirty, paperId]);
  useEffect(() => () => { setUnsaved(`evidence-form:${paperId}`, null); setUnsaved(`fact-form:${paperId}`, null); }, [paperId]);

  async function load() {
    setEvidence(await api<Evidence[]>('GET', `/api/papers/${paperId}/evidence`));
    setFacts(await api<Fact[]>('GET', `/api/papers/${paperId}/facts`));
  }
  useEffect(() => { if (visible) load().catch((e) => setError(errorText(e))); }, [paperId, visible]);
  const act = (fn: () => Promise<unknown>) => async () => {
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const addEvidence = act(async () => {
    await api('POST', `/api/papers/${paperId}/evidence`, { kind: ev.kind, locator: { note: ev.note }, label: ev.label });
    setEv({ ...ev, note: '', label: '' });
  });
  const addFact = act(async () => {
    const n = fact.n.trim();
    // never drop what the user typed: a count that is not a whole number is an error, not "no n"
    if (n && !/^[1-9]\d*$/.test(n)) throw new Error('반복 수(n)는 1 이상의 정수로 입력하세요 (모르면 비워 두세요).');
    const evidenceId = fact.evidence_id || evidence[0]?.id;
    await api('POST', `/api/papers/${paperId}/facts`, {
      evidence_id: evidenceId, entity: fact.entity, metric: fact.metric, value_text: fact.value_text.trim(), unit: fact.unit,
      group: fact.group, comparison: fact.comparison, n: n ? Number(n) : null,
    });
    setFact({ ...fact, entity: '', metric: '', value_text: '', unit: '', group: '', comparison: '', n: '' });
  });
  const ff = (k: keyof typeof fact) => ({ value: fact[k], onChange: (e: { target: { value: string } }) => setFact({ ...fact, [k]: e.target.value }) });
  return (
    <>
      {error && <p role="alert" className="error">{error}</p>}
      <section className="card">
        <h2>근거</h2>
        <div className="row">
          <label>근거 종류<select value={ev.kind} onChange={(e) => setEv({ ...ev, kind: e.target.value })}>
            <option value="method_record">method_record (방법 기록)</option>
            <option value="experiment">experiment (실험 기록)</option>
          </select></label>
          <label>근거 이름<input value={ev.label} onChange={(e) => setEv({ ...ev, label: e.target.value })} /></label>
          <label style={{ gridColumn: 'span 2' }}>근거 메모<textarea value={ev.note} onChange={(e) => setEv({ ...ev, note: e.target.value })} /></label>
        </div>
        <p className="hint">그림·표·문헌 근거는 파일과 문헌을 올리는 기능(P04)이 생긴 뒤에 추가할 수 있습니다.</p>
        <button type="button" onClick={addEvidence}>근거 추가</button>
        <ul className="plain">
          {evidence.map((e) => (
            <li key={e.id}>
              <span className="status" data-testid="evidence-state">{e.extraction_state}</span>
              <span>{e.label || String(e.locator.note ?? '')}</span>
              {e.extraction_state === 'CANDIDATE' && (
                <button type="button" onClick={act(() => api('POST', `/api/papers/${paperId}/evidence/${e.id}/verify`, { intent: 'verify_evidence', content_hash: e.content_hash }))}>근거 검증</button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <h2>사실</h2>
        <div className="row">
          <label>출처 근거<select {...ff('evidence_id')}>{evidence.map((e) => <option key={e.id} value={e.id}>{e.label || String(e.locator.note ?? e.kind)}</option>)}</select></label>
          <label>대상<input {...ff('entity')} /></label>
          <label>지표<input {...ff('metric')} /></label>
          <label>값(원문 그대로)<input {...ff('value_text')} inputMode="decimal" /></label>
          <label>단위<input {...ff('unit')} /></label>
          <label>그룹<input {...ff('group')} /></label>
          <label>비교 대상<input {...ff('comparison')} /></label>
          <label>반복 수(n)<input {...ff('n')} inputMode="numeric" /></label>
        </div>
        <button type="button" onClick={addFact} disabled={evidence.length === 0}>사실 추가</button>
        <ul className="plain">
          {facts.map((f) => (
            <li key={f.id}>
              <span className="status" data-testid="fact-state">{f.verification_state}</span>
              <span>{f.entity} · {f.metric}: <strong data-testid="fact-value">{f.value_text} {f.unit}</strong> ({f.group}{f.comparison ? ` vs ${f.comparison}` : ''}{f.n ? `, n=${f.n}` : ''})</span>
              {f.verification_state === 'CANDIDATE' && (
                <button type="button" onClick={act(() => api('POST', `/api/papers/${paperId}/facts/${f.id}/verify`, { intent: 'verify_fact', content_hash: f.content_hash }))}>사실 검증</button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <TracePanel paperId={paperId} visible={visible} />
    </>
  );
}
