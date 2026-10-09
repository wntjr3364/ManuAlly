// The Writer (PW-042) under the manuscript: pick an approved paragraph plan and what to do — write a
// new paragraph after a chosen one, correct a paragraph conservatively, or rewrite it — and get a
// proposal. A proposal shows its text, its checks (numbers only from the plan's facts, the plan's
// claims carried, no avoided terms, the original's numbers and citations kept) and what evidence the
// writer said was missing. Only "적용" changes the manuscript, and only if it has not changed since.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../../app/api.ts';

interface Node { node_id: string; section: string; paragraph_goal: string; status: string }
interface Proposal {
  id: string; job_id: string; mode: 'draft' | 'conservative' | 'rewrite'; node_id: string; base_revision_id: string; proposal_hash: string;
  status: string; status_reason: string | null; paragraph: { content?: { type: string; text?: string; attrs?: { referenceId?: string } }[] } | null;
  missing: string[]; checks: { check: string; result: string; details?: string; finding?: Finding }[]; warnings: string[]; generator_label: string | null; created_at: string;
}
interface Block { id: string; text: string; type: string }
// a finding of the deterministic scientific gate (PW-043)
interface Finding { check: string; verdict: 'pass' | 'fail' | 'unknown'; text: string; reason?: string; evidence_label?: string; label?: string; candidates?: string[] }
interface CheckRun { id: string; status: string; findings: Finding[]; block_id: string; created_at: string }
const GATE_STATUS: Record<string, string> = { VERIFIED: '근거와 일치', FAILED: '불일치', UNKNOWN: '확인 안 됨 있음', NOT_APPLICABLE: '검사할 수치·인용 없음' };
const GATE_REASON: Record<string, string> = {
  no_matching_fact: '이 값의 검증된 사실이 없음', ambiguous: '같은 값의 사실이 여럿이라 고를 수 없음', unit_not_stated: '단위가 없음', group_not_stated: '어느 그룹인지 없음',
  unit_mismatch: '단위가 다름', group_mismatch: '대조군에 붙임', p_q_mismatch: 'p와 q(보정 p)를 바꿔 씀', value_mismatch: '통계값이 다름', threshold_not_met: '기준을 넘지 않음',
  n_mismatch: 'n이 다름', no_matched_fact: '맞춰진 사실이 없어 확인 못 함', no_statistic: '그 통계값이 기록되지 않음', no_n_recorded: 'n이 기록되지 않음',
  citation_not_found: '이 논문의 참고문헌이 아님', citation_retracted: '철회된 문헌', protected_span_changed: '수식·그림 참조가 바뀜',
  negation_changed: '주장의 부정이 바뀜', direction_changed: '주장의 증감 방향이 바뀜', claim_not_found: '주장이 문단에 보이지 않음',
};
function FindingLine({ f }: { f: Finding }) {
  const mark = f.verdict === 'pass' ? '✓' : f.verdict === 'fail' ? '✗' : '?';
  const where = f.evidence_label ?? f.label;
  return <li data-testid="sci-finding" data-verdict={f.verdict} className={f.verdict === 'fail' ? 'error' : f.verdict === 'unknown' ? 'hint' : undefined}>{mark} {f.text}{where ? ` — ${where}` : ''}{f.reason && f.reason !== 'threshold' ? ` (${GATE_REASON[f.reason] ?? f.reason})` : ''}</li>;
}

const MODE: Record<Proposal['mode'], string> = { draft: '새 문단', conservative: '보수적 교정', rewrite: '재작성' };
const STATUS: Record<string, string> = {
  PENDING: '적용 가능', CHECK_FAILED: '검사 실패', NEEDS_EVIDENCE: '근거 부족', NO_CHANGE: '바꿀 것 없음', STALE: '원고가 바뀜', APPLIED: '적용됨', REJECTED: '거절함',
};
const CHECK: Record<string, string> = {
  number_not_in_contract: '계획의 사실·주장에 없는 수치(앞 문단에 쓴 수치라도 검증된 사실로 등록되어 있어야 씁니다)', citation_retracted: '철회된 문헌을 인용함', mandatory_claim: '계획의 주장이 빠짐', avoided_term: '피하기로 한 용어',
  numbers: '원문의 수치가 바뀜', negations: '부정어가 바뀜', directions: '증감 방향이 바뀜', citations: '인용이 바뀜', citation_positions: '인용 위치가 바뀜',
  protected_atoms: '수식·그림 참조가 바뀜', formatted_runs: '서식이 바뀜',
};
const WARN: Record<string, string> = { longer_than_target: '목표 분량보다 깁니다', shorter_than_target: '목표 분량보다 짧습니다', citation_not_linked_to_node: '이 계획의 근거와 연결되지 않은 문헌을 인용했습니다 — 맞는 인용인지 확인하세요' };
const textOf = (p: Proposal) => (p.paragraph?.content ?? []).map((n) => (n.type === 'text' ? n.text : n.type === 'citation' ? '[인용]' : '[…]')).join('');

// headId: the editor's saved head (autosave moves it); the paragraphs offered are read from that revision
export function WriterPanel({ paperId, documentId, headId, clean, onApplied }: { paperId: string; documentId: string; headId: string; clean: boolean; onApplied: () => void }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [outlineId, setOutlineId] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState('');
  const [mode, setMode] = useState<Proposal['mode']>('draft');
  const [blockId, setBlockId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const waiting = useRef<number | null>(null);
  const load = useCallback(async () => {
    const list = await api<Proposal[]>('GET', `/api/papers/${paperId}/writer/proposals?document_id=${documentId}`);
    setProposals(list);
    return list;
  }, [paperId, documentId]);
  useEffect(() => {
    api<{ active: { id: string; nodes: Node[] } | null }>('GET', `/api/papers/${paperId}/outline`).then((o) => {
      setOutlineId(o.active?.id ?? null);
      setNodes(o.active?.nodes ?? []);
    }).catch((e) => setError(errorText(e)));
    load().catch((e) => setError(errorText(e)));
  }, [paperId, load]);
  useEffect(() => () => { if (waiting.current) clearInterval(waiting.current); }, []);
  useEffect(() => {
    api<{ head: { id: string; content_json: { content?: { type: string; attrs?: { id?: string }; content?: { text?: string }[] }[] } } }>('GET', `/api/papers/${paperId}/documents/${documentId}`).then((d) => {
      setBlocks((d.head.content_json.content ?? []).filter((b) => b.attrs?.id).map((b) => ({ id: b.attrs!.id!, type: b.type, text: (b.content ?? []).map((c) => c.text ?? '').join('') })));
    }).catch((e) => setError(errorText(e)));
  }, [paperId, documentId, headId]);
  const paragraphs = blocks.filter((b) => b.type === 'paragraph');

  const request = async () => {
    setError('');
    try {
      const before = proposals[0]?.id ?? null;
      const place = mode === 'draft' ? { after_block_id: blockId || null } : { block_id: blockId };
      await api('POST', `/api/papers/${paperId}/writer/requests`, { mode, outline_revision_id: outlineId, node_id: nodeId, document_id: documentId, base_revision_id: headId, ...place, instruction, idempotency_key: crypto.randomUUID() });
      setNote('요청했습니다. 제안이 준비되면 아래에 나타납니다.');
      let n = 0;
      if (waiting.current) clearInterval(waiting.current);
      waiting.current = window.setInterval(() => {
        n++;
        void load().then((l) => {
          if ((l[0]?.id ?? null) !== before || n > 40) { clearInterval(waiting.current!); waiting.current = null; setNote((l[0]?.id ?? null) !== before ? '' : '아직 결과가 없습니다 — AI 실행 탭에서 상태를 확인하세요'); }
        }).catch(() => {});
      }, 750);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const decide = async (p: Proposal, what: 'apply' | 'reject') => {
    setError('');
    try {
      if (what === 'apply') await api('POST', `/api/papers/${paperId}/writer/proposals/${p.id}/apply`, { intent: 'apply_paragraph', proposal_hash: p.proposal_hash, expected_revision_id: p.base_revision_id });
      else await api('POST', `/api/papers/${paperId}/writer/proposals/${p.id}/reject`, { intent: 'reject_paragraph' });
      setNote(what === 'apply' ? '원고에 적용했습니다.' : '거절했습니다.');
      await load();
      if (what === 'apply') onApplied();
    } catch (e) {
      setError(errorText(e));
      await load().catch(() => {});
    }
  };
  const goal = (id: string) => nodes.find((n) => n.node_id === id)?.paragraph_goal ?? '';
  const [checkBlock, setCheckBlock] = useState('');
  const [checkRun, setCheckRun] = useState<CheckRun | null>(null);
  const runCheck = async () => {
    setError('');
    try {
      setCheckRun(await api<CheckRun>('POST', `/api/papers/${paperId}/documents/${documentId}/scientific-checks`, { revision_id: headId, block_id: checkBlock }));
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="card" aria-label="문단 작성" data-testid="writer">
      <h2 style={{ margin: 0 }}>문단 작성</h2>
      <p className="hint">승인된 문단 계획의 주장·검증된 사실·근거만으로 씁니다. 결과는 제안이며, 적용을 눌러야 원고가 바뀝니다. 계획에 없는 수치나 이 논문의 참고문헌이 아닌 인용은 제안이 되지 않습니다.</p>
      {!outlineId && <p className="hint">승인된 개요가 있어야 합니다.</p>}
      {!clean && <p className="hint" data-testid="writer-unsaved">저장되지 않은 편집이 있습니다 — 저장된 뒤 요청·적용할 수 있습니다.</p>}
      {note && <p role="status">{note}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="toolbar">
        <label>문단 계획 <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
          <option value="">선택</option>
          {nodes.map((n) => <option key={n.node_id} value={n.node_id} disabled={n.status !== 'APPROVED'}>{n.section} · {n.paragraph_goal}{n.status !== 'APPROVED' ? ` (${n.status})` : ''}</option>)}
        </select></label>
        <label>할 일 <select value={mode} onChange={(e) => { setMode(e.target.value as Proposal['mode']); setBlockId(''); }}>
          <option value="draft">새 문단 쓰기</option>
          <option value="conservative">보수적 교정</option>
          <option value="rewrite">재작성</option>
        </select></label>
        <label>{mode === 'draft' ? '넣을 위치(이 문단 뒤)' : '고칠 문단'} <select value={blockId} onChange={(e) => setBlockId(e.target.value)}>
          <option value="">{mode === 'draft' ? '원고 끝' : '선택'}</option>
          {paragraphs.map((b) => <option key={b.id} value={b.id}>{b.text.slice(0, 50) || '(빈 문단)'}</option>)}
        </select></label>
      </div>
      <label>요청 <input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="예: 뿌리 결과를 간결하게" /></label>
      <button type="button" onClick={() => void request()} disabled={!outlineId || !nodeId || !clean || (mode !== 'draft' && !blockId)}>제안 요청</button>

      <fieldset data-testid="sci-check">
        <legend>과학 검사 (저장된 원고의 문단)</legend>
        <p className="hint">수치·단위·그룹·p/q·n·인용·주장 방향을 검증된 기록과 맞춰 봅니다. 정확히 맞출 수 없는 것은 "확인 안 됨"이며 통과가 아닙니다.</p>
        <label>검사할 문단 <select value={checkBlock} onChange={(e) => { setCheckBlock(e.target.value); setCheckRun(null); }}>
          <option value="">선택</option>
          {paragraphs.map((b) => <option key={b.id} value={b.id}>{b.text.slice(0, 50) || '(빈 문단)'}</option>)}
        </select></label>
        <button type="button" disabled={!checkBlock || !clean} onClick={() => void runCheck()}>검사</button>
        {checkRun && (
          <div data-testid="sci-run" data-status={checkRun.status}>
            <strong data-testid="sci-status">{GATE_STATUS[checkRun.status] ?? checkRun.status}</strong>
            <ul>{checkRun.findings.map((f, i) => <FindingLine key={i} f={f} />)}</ul>
          </div>
        )}
      </fieldset>

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {proposals.slice(0, 10).map((p) => (
          <li key={p.id} className="card" data-testid="writer-proposal" data-status={p.status}>
            <div className="toolbar">
              <strong>{MODE[p.mode]}</strong> <span className="hint">{goal(p.node_id)}</span>
              <span className="status" data-testid="writer-status">{STATUS[p.status] ?? p.status}</span>
              {p.generator_label && <span className="status">{p.generator_label}</span>}
            </div>
            {p.paragraph && <p data-testid="writer-text">{textOf(p)}</p>}
            {p.missing.length > 0 && <ul>{p.missing.map((m, i) => <li key={i} data-testid="writer-missing">부족한 근거: {m}</li>)}</ul>}
            {p.checks.filter((c) => c.result === 'fail' && c.check !== 'scientific').map((c, i) => <p key={i} className="error" data-testid="writer-check">{CHECK[c.check] ?? c.check}{c.details ? `: ${c.details}` : ''}</p>)}
            {p.checks.some((c) => c.finding) && <ul data-testid="writer-gate">{p.checks.filter((c) => c.finding).map((c, i) => <FindingLine key={i} f={c.finding!} />)}</ul>}
            {p.warnings.map((w) => <p key={w} className="hint">{WARN[w] ?? w}</p>)}
            {p.status === 'PENDING' && (
              <div className="toolbar">
                <button type="button" className="primary" disabled={!clean} onClick={() => void decide(p, 'apply')}>적용</button>
                <button type="button" onClick={() => void decide(p, 'reject')}>거절</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
