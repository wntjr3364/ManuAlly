// Proposals for this manuscript (PW-017, spec 04 "diff 확인 후 사용자가 accept/reject"). Each shows
// what it was asked to do, the checks, and a word diff of its paragraph. Apply sends the exact
// proposal (hash), the revision it expects and an idempotency key (kept for retries of the same
// click); the server refuses anything stale and answers a resend with the first result.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSONContent } from '@tiptap/core';
import { ApiError, api, errorText } from '../../app/api.ts';
import { blockTokens, diffTokens } from './diff.ts';

export interface ProposalView {
  id: string; intent: string; mode: string; status: string; status_reason: string | null; base_revision_id: string; proposal_hash: string;
  checks: { check: string; result: string; details?: string }[]; explanation: string | null; created_at: string;
}
export interface AppliedRevision { id: string; parent_revision_id: string; content_json: JSONContent }
interface Detail { proposal: ProposalView; before_block?: JSONContent; after_block?: JSONContent }

const INTENT_LABEL: Record<string, string> = { grammar: '문법', concise: '간결화', rewrite: '학술적 재작성' };
const STATUS_LABEL: Record<string, string> = { PENDING: '검토 대기', APPLIED: '적용됨', REJECTED: '거절됨', STALE: '원고가 바뀌어 적용 불가(STALE)', CHECK_FAILED: '검사 실패 — 적용 불가' };
const newKey = () => crypto.randomUUID().replaceAll('-', '');

export interface ProposalPanelProps {
  paperId: string;
  documentId: string;
  headRevisionId: string;
  // the screen equals the stored head and nothing is being typed
  canApply: boolean;
  // called before the request (lock the editor) and after it (unlock); onApplied puts the result on screen
  onApplying: (busy: boolean) => void;
  onApplied: (rev: AppliedRevision, afterBlock: JSONContent) => boolean;
  refreshKey?: number;
}

export function ProposalPanel({ paperId, documentId, headRevisionId, canApply, onApplying, onApplied, refreshKey }: ProposalPanelProps) {
  const [items, setItems] = useState<Detail[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>()); // proposal id -> idempotency key of the pending apply

  const load = useCallback(async () => {
    try {
      const list = await api<ProposalView[]>('GET', `/api/papers/${paperId}/documents/${documentId}/proposals?status=PENDING`);
      const failed = await api<ProposalView[]>('GET', `/api/papers/${paperId}/documents/${documentId}/proposals?status=CHECK_FAILED`);
      const details = await Promise.all([...list, ...failed].map((p) => api<Detail>('GET', `/api/papers/${paperId}/proposals/${p.id}`)));
      setItems(details);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, [paperId, documentId]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const apply = async (d: Detail) => {
    const p = d.proposal;
    let key = keys.current.get(p.id);
    if (!key) { key = newKey(); keys.current.set(p.id, key); }
    setBusy(p.id);
    onApplying(true);
    try {
      const r = await api<{ revision: AppliedRevision; replayed: boolean }>('POST', `/api/papers/${paperId}/proposals/${p.id}/apply`, {
        proposal_hash: p.proposal_hash, expected_revision_id: p.base_revision_id, idempotency_key: key,
      });
      keys.current.delete(p.id);
      if (!onApplied(r.revision, d.after_block!)) setError('적용은 저장되었지만 화면에 반영하지 못했습니다 — 페이지를 새로 불러오세요');
      await load();
    } catch (e) {
      // network: the key stays, so "다시 시도" resends the same apply; the server answers it once
      if (e instanceof ApiError) { keys.current.delete(p.id); await load(); }
      setError(e instanceof ApiError ? errorText(e) : '네트워크 오류 — 적용되었는지 알 수 없습니다. 다시 시도하면 한 번만 적용됩니다.');
    } finally {
      setBusy(null);
      onApplying(false);
    }
  };
  const reject = async (d: Detail) => {
    try {
      await api('POST', `/api/papers/${paperId}/proposals/${d.proposal.id}/reject`);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="card" aria-label="수정 제안" data-testid="proposals">
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>수정 제안</h2>
        <button type="button" onClick={() => void load()}>새로고침</button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {items.length === 0 && <p className="hint">검토할 제안이 없습니다.</p>}
      {items.map((d) => {
        const p = d.proposal;
        const stale = p.status === 'PENDING' && p.base_revision_id !== headRevisionId;
        const parts = d.before_block && d.after_block ? diffTokens(blockTokens(d.before_block), blockTokens(d.after_block)) : [];
        const failed = p.checks.filter((c) => c.result === 'fail');
        return (
          <article key={p.id} className="proposal" data-testid="proposal" data-proposal-id={p.id}>
            <p className="hint">
              {INTENT_LABEL[p.intent] ?? p.intent}{p.mode === 'preapproval' ? ' · 개요 승인 전 교정' : ''} · {STATUS_LABEL[p.status] ?? p.status}
            </p>
            <p className="diff" data-testid="proposal-diff">
              {parts.map((x, i) => (x.kind === 'same' ? <span key={i}>{x.text}</span> : x.kind === 'del' ? <del key={i}>{x.text}</del> : <ins key={i}>{x.text}</ins>))}
            </p>
            {p.explanation && <p className="hint">설명(AI): {p.explanation}</p>}
            {failed.length > 0 && (
              <ul role="alert" className="error" data-testid="proposal-checks">{failed.map((c) => <li key={c.check}>{c.check}: {c.details}</li>)}</ul>
            )}
            {p.status === 'PENDING' && (
              <div className="toolbar">
                <button type="button" className="primary" disabled={!canApply || stale || busy !== null} onClick={() => void apply(d)}>
                  {keys.current.has(p.id) ? '다시 시도' : '적용'}
                </button>
                <button type="button" disabled={busy !== null} onClick={() => void reject(d)}>거절</button>
                {stale && <span className="hint">원고가 이 제안 뒤에 바뀌어 적용할 수 없습니다. 지금 원고로 다시 요청하세요.</span>}
                {!stale && !canApply && <span className="hint">저장된 뒤 적용할 수 있습니다</span>}
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}
