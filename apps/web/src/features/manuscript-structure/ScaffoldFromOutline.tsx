// "개요로 원고 골격 만들기" (PW-046): the owner adds the approved outline's sections, in outline order, as
// the manuscript's headings. Only missing headings are added; nothing the owner wrote changes. It works
// on the saved head (unsaved edits first), and a moved head is a conflict, never an overwrite.
import { useEffect, useState } from 'react';
import { api, errorText } from '../../app/api.ts';

export function ScaffoldFromOutline({ paperId, documentId, headId, clean, onDone }: { paperId: string; documentId: string; headId: string; clean: boolean; onDone: () => void }) {
  const [outlineId, setOutlineId] = useState<string | null>(null);
  const [sections, setSections] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ active: { id: string } | null }>('GET', `/api/papers/${paperId}/outline`)
      .then(async (o) => {
        setOutlineId(o.active?.id ?? null);
        if (!o.active) return;
        const full = await api<{ nodes: { section: string }[] }>('GET', `/api/papers/${paperId}/outline/revisions/${o.active.id}`);
        const seen = new Set<string>();
        setSections(full.nodes.map((n) => n.section.trim()).filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase())));
      })
      .catch((e) => setError(errorText(e)));
  }, [paperId, headId]);
  if (!outlineId) return null;
  const build = async () => {
    setError('');
    setMsg('');
    try {
      const r = await api<{ added: string[] }>('POST', `/api/papers/${paperId}/documents/${documentId}/scaffold`, { outline_revision_id: outlineId, expected_head_revision_id: headId });
      setMsg(r.added.length ? `섹션 제목을 추가했습니다: ${r.added.join(', ')}` : '개요의 섹션이 모두 원고에 있습니다.');
      if (r.added.length) onDone();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <section className="card" aria-label="원고 골격" data-testid="scaffold">
      <h2>원고 골격</h2>
      <p className="hint">승인된 개요의 섹션: {sections.join(' · ') || '(섹션 이름 없음)'} — 원고에 없는 섹션 제목만 개요 순서대로 추가합니다. 쓴 글은 바꾸지 않습니다.</p>
      <button type="button" onClick={build} disabled={!clean || !sections.length}>개요로 원고 골격 만들기</button>
      {!clean && <span className="hint"> 저장되지 않은 편집이 있으면 먼저 저장됩니다.</span>}
      {msg && <p role="status">{msg}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  );
}
