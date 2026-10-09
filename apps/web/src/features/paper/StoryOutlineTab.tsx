// Story and outline are written by hand and approved explicitly, version by version (spec 03).
// The approve buttons send the exact content hash of the version shown; the server checks it.
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, errorText } from '../../app/api.ts';
import type { Paper } from './PapersPage.tsx';
import type { Evidence } from './EvidenceTab.tsx';
import { setUnsaved } from '../../app/unsaved.ts';

interface StoryRev { id: string; status: string; content_hash: string; brief: Record<string, unknown>; story: Record<string, unknown> }
interface Node {
  node_id: string; section: string; role: string; paragraph_goal: string; requires_evidence: boolean; evidence_ids: string[]; status?: string;
  parent_node_id?: string | null; claim_ids?: string[]; allowed_interpretation?: string; exclusions?: string[]; transition?: string;
  word_budget_min?: number | null; word_budget_max?: number | null;
}
interface OutlineRev { id: string; status: string; content_hash: string; story_revision_id: string; nodes?: Node[] }
const ROLES = ['background', 'gap', 'aim', 'method', 'result', 'interpretation', 'comparison', 'limitation', 'conclusion', 'other'];
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const newNode = (): Node => ({ node_id: crypto.randomUUID(), section: '', role: 'result', paragraph_goal: '', requires_evidence: false, evidence_ids: [] });
const newNodeTemplate = newNode(); // only a comparison base; rows get their own ids

const formOf = (r: StoryRev | null) => ({
  purpose: str(r?.brief.purpose), audience: str(r?.brief.audience), question: str(r?.story.question), main_message: str(r?.story.main_message),
  novelty: str(r?.story.novelty), limitations: ((r?.story.limitations as string[] | undefined) ?? []).join('\n'),
});
// the fields a user edits and the API accepts (stored nodes also carry position, status, approval)
const editable = (n: Node) => ({
  node_id: n.node_id, parent_node_id: n.parent_node_id ?? null, section: n.section, role: n.role, paragraph_goal: n.paragraph_goal,
  claim_ids: n.claim_ids ?? [], evidence_ids: n.evidence_ids, requires_evidence: n.requires_evidence,
  allowed_interpretation: n.allowed_interpretation ?? '', exclusions: n.exclusions ?? [], transition: n.transition ?? '',
  word_budget_min: n.word_budget_min ?? null, word_budget_max: n.word_budget_max ?? null,
});
// node ids are generated per row; an untouched first row compares equal to the empty template
const nodeKey = (ns: Node[]) => JSON.stringify(ns.map((n) => ({ ...editable(n), node_id: ns.length === 1 && !n.paragraph_goal && !n.section ? '' : n.node_id })));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Form = ReturnType<typeof formOf>;
// exactly what "스토리 저장" sends; dirty checks compare this, so tidied text is not "unsaved"
const payloadOf = (f: Form) => ({
  brief: { purpose: f.purpose, audience: f.audience },
  story: { question: f.question, main_message: f.main_message, novelty: f.novelty, limitations: f.limitations.split('\n').map((l) => l.trim()).filter(Boolean) },
});
const sameStory = (a: Form, b: Form) => same(payloadOf(a), payloadOf(b));

export function StoryOutlineTab({ paper, onChange, visible }: { paper: Paper; onChange: () => void; visible: boolean }) {
  const [story, setStory] = useState<{ latest: StoryRev | null; active: StoryRev | null; missing: string[] } | null>(null);
  const [form, setForm] = useState({ purpose: '', audience: '', question: '', main_message: '', novelty: '', limitations: '' });
  const [outline, setOutline] = useState<{ latest: OutlineRev | null; active: OutlineRev | null } | null>(null);
  const [nodes, setNodes] = useState<Node[]>(() => [{ ...newNodeTemplate, node_id: crypto.randomUUID() }]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [error, setError] = useState('');
  const baseForm = useRef(formOf(null));
  const baseNodes = useRef<Node[]>([newNodeTemplate]);

  // force: discard screen edits of that part and show the stored latest version
  async function load(force: 'story' | 'outline' | null = null) {
    const s = await api<{ latest: StoryRev | null; active: StoryRev | null; missing: string[] }>('GET', `/api/papers/${paper.id}/story`);
    setStory(s);
    // server data replaces the form only where the user has not typed since the last known server
    // state (typing before the first load or during a save is kept)
    const storyBase = formOf(s.latest);
    const before = baseForm.current; // read now: the updater below runs later
    setForm((prev) => (force === 'story' || sameStory(prev, before) || sameStory(prev, storyBase) ? storyBase : prev));
    baseForm.current = storyBase;
    const o = await api<{ latest: OutlineRev | null; active: OutlineRev | null }>('GET', `/api/papers/${paper.id}/outline`);
    if (o.latest) {
      const full = await api<OutlineRev>('GET', `/api/papers/${paper.id}/outline/revisions/${o.latest.id}`);
      setOutline({ latest: full, active: o.active });
      const nodesBase = full.nodes ?? [newNodeTemplate];
      const before = baseNodes.current;
      setNodes((prev) => (force === 'outline' || nodeKey(prev) === nodeKey(before) || nodeKey(prev) === nodeKey(nodesBase) ? nodesBase : prev));
      baseNodes.current = nodesBase;
    } else setOutline(o);
    setEvidence(await api<Evidence[]>('GET', `/api/papers/${paper.id}/evidence`));
  }
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [paper.id]);
  // what is on screen differs from the stored latest revision: approval would approve something else.
  // Before the first load arrives the screen is compared with an empty form, so text typed early is
  // still protected when leaving.
  const storyDirty = !sameStory(form, formOf(story?.latest ?? null));
  const outlineDirty = nodeKey(nodes) !== nodeKey(outline?.latest?.nodes ?? [newNodeTemplate]);
  useEffect(() => {
    setUnsaved(`story:${paper.id}`, storyDirty ? '스토리' : null);
    setUnsaved(`outline:${paper.id}`, outlineDirty ? '개요' : null);
  }, [storyDirty, outlineDirty, paper.id]);
  useEffect(() => () => { setUnsaved(`story:${paper.id}`, null); setUnsaved(`outline:${paper.id}`, null); }, [paper.id]);
  // evidence added in the 자료 tab appears in the selector when coming back (form edits are kept)
  useEffect(() => { if (visible) api<Evidence[]>('GET', `/api/papers/${paper.id}/evidence`).then(setEvidence).catch(() => {}); }, [visible, paper.id]);

  // which part had a save conflict (someone else saved first), so only that part can be reloaded
  const [conflict, setConflict] = useState<'story' | 'outline' | null>(null);
  const act = (fn: () => Promise<unknown>, part: 'story' | 'outline') => async () => {
    setError('');
    setConflict(null);
    try {
      await fn();
      await load();
      onChange();
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.status === 409 && /stale|changed/i.test(e.message)) setConflict(part);
    }
  };
  const saveStory = act(() => api('POST', `/api/papers/${paper.id}/story/revisions`, { parent_revision_id: story?.latest?.id ?? null, ...payloadOf(form) }), 'story');
  // after someone else saved first (409), the user can discard that part's screen edits and load the newer version
  const loadLatest = async (part: 'story' | 'outline') => {
    if (!window.confirm(`화면의 저장되지 않은 ${part === 'story' ? '스토리' : '개요'} 내용을 버리고 최신 버전을 불러올까요?`)) return;
    setError('');
    setConflict(null);
    await load(part).catch((e) => setError(errorText(e)));
  };
  const approveStory = act(() => api('POST', `/api/papers/${paper.id}/story/revisions/${story!.latest!.id}/approve`, { intent: 'approve_story', content_hash: story!.latest!.content_hash }), 'story');
  const saveOutline = act(() => api('POST', `/api/papers/${paper.id}/outline/revisions`, {
    parent_revision_id: outline?.latest?.id ?? null,
    story_revision_id: paper.active_story_revision_id,
    nodes: nodes.map(editable),
  }), 'outline');
  const approveOutline = act(() => api('POST', `/api/papers/${paper.id}/outline/revisions/${outline!.latest!.id}/approve`, { intent: 'approve_outline', content_hash: outline!.latest!.content_hash }), 'outline');
  const setNode = (i: number, patch: Partial<Node>) => setNodes(nodes.map((n, j) => (j === i ? { ...n, ...patch } : n)));
  const f = (k: keyof typeof form) => ({ value: form[k], onChange: (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value }) });

  return (
    <>
      {error && (
        <div role="alert" className="error">
          {error}{' '}
          {conflict && (
            <>
              <button type="button" onClick={() => void loadLatest(conflict)}>{conflict === 'story' ? '최신 스토리 불러오기' : '최신 개요 불러오기'}</button>{' '}
              <span className="hint">(화면의 변경은 버려집니다. 필요하면 먼저 복사해 두세요)</span>
            </>
          )}
        </div>
      )}
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
            <button type="button" className="primary" onClick={approveStory} disabled={storyDirty}>이 스토리 버전 승인</button>
          )}
          {storyDirty && <span className="hint">화면 내용이 저장된 버전과 다릅니다 — 저장한 뒤 승인할 수 있습니다.</span>}
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
          {nodes.length > 1 && <button type="button" onClick={() => setNodes(nodes.slice(0, -1))}>마지막 계획 빼기</button>}
          <button type="button" onClick={saveOutline} disabled={!paper.active_story_revision_id}>개요 저장</button>
          {outline?.latest && outline.latest.status !== 'APPROVED' && outline.latest.status !== 'SUPERSEDED' && (
            <button type="button" className="primary" onClick={approveOutline} disabled={outlineDirty}>이 개요 버전 승인</button>
          )}
          {outlineDirty && outline?.latest && <span className="hint">화면 내용이 저장된 버전과 다릅니다 — 저장한 뒤 승인할 수 있습니다.</span>}
          {outline?.latest && <span className="hint">버전 {outline.latest.content_hash.slice(0, 8)}</span>}
        </div>
      </section>
    </>
  );
}
