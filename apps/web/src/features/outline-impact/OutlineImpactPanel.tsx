// Change impact on the approved outline (PW-040): which paragraph plans rely on a source that changed
// (a claim or evidence withdrawn, a fact retracted, a figure redrawn, a cited work removed or retracted),
// with the manuscript paragraphs linked to them. Only those plans wait for AI drafting until the user
// reviews the impact; other plans and every manual edit go on.
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../../app/api.ts';

interface Impact { node_id: string; kind: string; source_id: string; change: string; key: string; detail: string; resolved: boolean; paragraphs: { document_id: string; block_id: string }[] }
const CHANGE: Record<string, string> = {
  claim_withdrawn: '주장이 철회됨', claim_missing: '주장이 없어짐', evidence_withdrawn: '근거가 철회됨', evidence_missing: '근거가 없어짐',
  fact_withdrawn: '사실이 철회됨', source_removed: '인용 문헌이 논문에서 빠짐', source_retracted: '인용 문헌이 철회됨', figure_version_changed: '그림이 새 버전으로 바뀜',
};

export function OutlineImpactPanel({ paperId, outlineId, nodes, onChange }: { paperId: string; outlineId: string; nodes: { node_id: string; section: string; paragraph_goal: string }[]; onChange: () => void }) {
  const [impacts, setImpacts] = useState<Impact[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setImpacts(await api<Impact[]>('GET', `/api/papers/${paperId}/outline/revisions/${outlineId}/impacts`)); setError(''); } catch (e) { setError(errorText(e)); }
  }, [paperId, outlineId]);
  useEffect(() => { void load(); }, [load]);
  const resolve = async (i: Impact) => {
    try {
      await api('POST', `/api/papers/${paperId}/outline/revisions/${outlineId}/impacts/resolve`, { intent: 'resolve_impact', node_id: i.node_id, key: i.key });
      await load();
      onChange();
    } catch (e) { setError(errorText(e)); }
  };
  const goal = (id: string) => { const n = nodes.find((x) => x.node_id === id); return n ? `${n.section} — ${n.paragraph_goal}` : id.slice(0, 8); };
  const open = impacts.filter((i) => !i.resolved);
  return (
    <section className="card" aria-label="변경 영향" data-testid="outline-impacts">
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>변경 영향 <span className="status" data-testid="impact-count">{open.length}</span></h2>
        <button type="button" onClick={() => void load()}>다시 확인</button>
      </div>
      <p className="hint">근거가 바뀐 문단 계획만 AI 생성 전에 검토가 필요합니다. 다른 문단 계획과 직접 편집은 그대로 할 수 있습니다.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {impacts.length === 0 && <p className="hint">바뀐 근거가 없습니다.</p>}
      <ul className="plain">
        {impacts.map((i) => (
          <li key={`${i.node_id}|${i.key}`} data-testid="impact" data-change={i.change} data-resolved={i.resolved}>
            <strong>{goal(i.node_id)}</strong>: {CHANGE[i.change] ?? i.change} — {i.detail}
            {i.paragraphs.length > 0 && <span className="hint" data-testid="impact-paragraphs"> · 연결된 원고 문단 {i.paragraphs.length}개</span>}
            {i.resolved
              ? <span className="hint"> · 검토함</span>
              : <> <button type="button" onClick={() => void resolve(i)}>검토함 — 이 계획대로 진행</button></>}
          </li>
        ))}
      </ul>
    </section>
  );
}
