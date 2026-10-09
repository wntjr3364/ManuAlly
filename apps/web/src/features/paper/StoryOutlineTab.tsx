// Story and outline are written by hand and approved explicitly, version by version (spec 03).
// The approve buttons send the exact content hash of the version shown; the server checks it.
import { useEffect, useState } from 'react';
import { api, errorText } from '../../app/api.ts';
import type { Paper } from './PapersPage.tsx';
import type { Evidence } from './EvidenceTab.tsx';

interface StoryRev { id: string; status: string; content_hash: string; brief: Record<string, unknown>; story: Record<string, unknown> }
interface Node { node_id: string; section: string; role: string; paragraph_goal: string; requires_evidence: boolean; evidence_ids: string[]; status?: string }
interface OutlineRev { id: string; status: string; content_hash: string; story_revision_id: string; nodes?: Node[] }
const ROLES = ['background', 'gap', 'aim', 'method', 'result', 'interpretation', 'comparison', 'limitation', 'conclusion', 'other'];
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const newNode = (): Node => ({ node_id: crypto.randomUUID(), section: '', role: 'result', paragraph_goal: '', requires_evidence: false, evidence_ids: [] });

export function StoryOutlineTab({ paper, onChange }: { paper: Paper; onChange: () => void }) {
  const [story, setStory] = useState<{ latest: StoryRev | null; active: StoryRev | null; missing: string[] } | null>(null);
  const [form, setForm] = useState({ purpose: '', audience: '', question: '', main_message: '', novelty: '', limitations: '' });
  const [outline, setOutline] = useState<{ latest: OutlineRev | null; active: OutlineRev | null } | null>(null);
  const [nodes, setNodes] = useState<Node[]>([newNode()]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [error, setError] = useState('');

  async function load() {
    const s = await api<{ latest: StoryRev | null; active: StoryRev | null; missing: string[] }>('GET', `/api/papers/${paper.id}/story`);
    setStory(s);
    if (s.latest) {
      setForm({
        purpose: str(s.latest.brief.purpose), audience: str(s.latest.brief.audience), question: str(s.latest.story.question),
        main_message: str(s.latest.story.main_message), novelty: str(s.latest.story.novelty), limitations: (s.latest.story.limitations as string[] | undefined ?? []).join('\n'),
      });
    }
    const o = await api<{ latest: OutlineRev | null; active: OutlineRev | null }>('GET', `/api/papers/${paper.id}/outline`);
    if (o.latest) {
      const full = await api<OutlineRev>('GET', `/api/papers/${paper.id}/outline/revisions/${o.latest.id}`);
      setOutline({ latest: full, active: o.active });
      setNodes(full.nodes ?? [newNode()]);
    } else setOutline(o);
    setEvidence(await api<Evidence[]>('GET', `/api/papers/${paper.id}/evidence`));
  }
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [paper.id]);

  const act = (fn: () => Promise<unknown>) => async () => {
    setError('');
    try {
      await fn();
      await load();
      onChange();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const saveStory = act(() => api('POST', `/api/papers/${paper.id}/story/revisions`, {
    parent_revision_id: story?.latest?.id ?? null,
    brief: { purpose: form.purpose, audience: form.audience },
    story: { question: form.question, main_message: form.main_message, novelty: form.novelty, limitations: form.limitations.split('\n').map((l) => l.trim()).filter(Boolean) },
  }));
  const approveStory = act(() => api('POST', `/api/papers/${paper.id}/story/revisions/${story!.latest!.id}/approve`, { intent: 'approve_story', content_hash: story!.latest!.content_hash }));
  const saveOutline = act(() => api('POST', `/api/papers/${paper.id}/outline/revisions`, {
    parent_revision_id: outline?.latest?.id ?? null,
    story_revision_id: paper.active_story_revision_id,
    nodes: nodes.map(({ status: _s, ...n }) => n),
  }));
  const approveOutline = act(() => api('POST', `/api/papers/${paper.id}/outline/revisions/${outline!.latest!.id}/approve`, { intent: 'approve_outline', content_hash: outline!.latest!.content_hash }));
  const setNode = (i: number, patch: Partial<Node>) => setNodes(nodes.map((n, j) => (j === i ? { ...n, ...patch } : n)));
  const f = (k: keyof typeof form) => ({ value: form[k], onChange: (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value }) });

  return (
    <>
      {error && <p role="alert" className="error">{error}</p>}
      <section className="card">
        <h2>스토리 <span className="status" data-testid="story-status">{story?.latest?.status ?? '없음'}</span></h2>
        <label>연구 목적<textarea {...f('purpose')} /></label>
        <label>대상 독자<input {...f('audience')} /></label>
        <label>핵심 질문<textarea {...f('question')} /></label>
        <label>핵심 메시지<textarea {...f('main_message')} /></label>
        <label>새로운 점<textarea {...f('novelty')} /></label>
        <label>한계 (한 줄에 하나)<textarea {...f('limitations')} /></label>
        <div className="toolbar">
          <button type="button" onClick={saveStory}>스토리 저장</button>
          {story?.latest && story.latest.status !== 'APPROVED' && story.latest.status !== 'SUPERSEDED' && (
            <button type="button" className="primary" onClick={approveStory}>이 스토리 버전 승인</button>
          )}
          {story?.latest && <span className="hint">버전 {story.latest.content_hash.slice(0, 8)}{story.missing.length ? ` · 비어 있는 필수 항목: ${story.missing.join(', ')}` : ''}</span>}
        </div>
      </section>
      <section className="card">
        <h2>개요 <span className="status" data-testid="outline-status">{outline?.latest?.status ?? '없음'}</span></h2>
        {!paper.active_story_revision_id && <p className="hint">개요는 승인된 스토리 위에서 작성합니다.</p>}
        {nodes.map((n, i) => (
          <div key={n.node_id} className="row" style={{ borderBottom: '1px solid #eef1f5', marginBottom: 8 }}>
            <label>섹션<input value={n.section} onChange={(e) => setNode(i, { section: e.target.value })} /></label>
            <label>역할<select value={n.role} onChange={(e) => setNode(i, { role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></label>
            <label style={{ gridColumn: 'span 2' }}>문단 목표<textarea value={n.paragraph_goal} onChange={(e) => setNode(i, { paragraph_goal: e.target.value })} /></label>
            <label className="inline"><input type="checkbox" checked={n.requires_evidence} onChange={(e) => setNode(i, { requires_evidence: e.target.checked })} />근거 필요</label>
            <label>근거 선택<select value={n.evidence_ids[0] ?? ''} onChange={(e) => setNode(i, { evidence_ids: e.target.value ? [e.target.value] : [] })}>
              <option value="">(없음)</option>
              {evidence.map((ev) => <option key={ev.id} value={ev.id}>{ev.label || String(ev.locator.note ?? ev.kind)} [{ev.extraction_state}]</option>)}
            </select></label>
            {n.status && <span className="status">{n.status}</span>}
          </div>
        ))}
        <div className="toolbar">
          <button type="button" onClick={() => setNodes([...nodes, newNode()])}>문단 계획 추가</button>
          <button type="button" onClick={saveOutline} disabled={!paper.active_story_revision_id}>개요 저장</button>
          {outline?.latest && outline.latest.status !== 'APPROVED' && outline.latest.status !== 'SUPERSEDED' && (
            <button type="button" className="primary" onClick={approveOutline}>이 개요 버전 승인</button>
          )}
          {outline?.latest && <span className="hint">버전 {outline.latest.content_hash.slice(0, 8)}</span>}
        </div>
      </section>
    </>
  );
}
