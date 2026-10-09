// Comment threads of the manuscript (PW-018). Each shows its quote, whether it is still attached to
// its text (ORPHANED: the text changed, was deleted, or several equal places exist; it is never moved
// to similar text), the messages, reply, resolve/reopen and "attach to the current selection".
import { useCallback, useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { api, errorText } from '../../app/api.ts';
import { commentRanges, setCommentRanges, type CommentRange } from './comment-highlights.ts';

interface Thread {
  id: string; state: 'OPEN' | 'RESOLVED';
  anchor: { block_id: string; quote: string };
  resolved: { state: 'ATTACHED'; block_id: string; from: number; to: number; moved: boolean } | { state: 'ORPHANED'; reason: 'BLOCK_MISSING' | 'TEXT_CHANGED' | 'AMBIGUOUS' };
  messages: { id: string; body: string; created_at: string }[];
}
const ORPHAN_REASON = { BLOCK_MISSING: '문단이 삭제됨', TEXT_CHANGED: '코멘트한 문장이 바뀌거나 삭제됨', AMBIGUOUS: '같은 문장이 여러 곳에 있어 위치를 정할 수 없음' };
const ATOM = /￼/g;

export interface CommentsPanelProps {
  paperId: string;
  documentId: string;
  editor: Editor | null;
  // the stored head the screen shows when it is saved; highlights are placed only then
  headRevisionId: string;
  screenIsHead: boolean;
  refreshKey: number;
  // the current selection frozen against the stored head, for "attach again"
  currentSelection: () => Promise<{ base_revision_id: string; selection: unknown } | { error: string }>;
}

export function CommentsPanel({ paperId, documentId, editor, headRevisionId, screenIsHead, refreshKey, currentSelection }: CommentsPanelProps) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [head, setHead] = useState('');
  const [error, setError] = useState('');
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [showResolved, setShowResolved] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ head_revision_id: string; threads: Thread[] }>('GET', `/api/papers/${paperId}/documents/${documentId}/comments`);
      setThreads(r.threads);
      setHead(r.head_revision_id);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, [paperId, documentId]);
  useEffect(() => { void load(); }, [load, refreshKey, headRevisionId]);

  // place highlights when the screen shows exactly the revision the positions were computed for
  useEffect(() => {
    if (!editor) return;
    if (!screenIsHead || head !== headRevisionId) {
      // positions cannot be placed now, but a thread that is no longer open loses its highlight at once
      const open = new Set(threads.filter((t) => t.state === 'OPEN').map((t) => t.id));
      const ranges = commentRanges(editor.view);
      if (ranges.some((r) => !open.has(r.id))) setCommentRanges(editor.view, ranges.filter((r) => open.has(r.id)));
      return;
    }
    const starts = new Map<string, number>();
    editor.state.doc.forEach((n, offset) => { if (typeof n.attrs.id === 'string') starts.set(n.attrs.id, offset + 1); });
    const ranges: CommentRange[] = [];
    for (const t of threads) {
      if (t.state !== 'OPEN' || t.resolved.state !== 'ATTACHED') continue;
      const start = starts.get(t.resolved.block_id);
      if (start !== undefined) ranges.push({ id: t.id, from: start + t.resolved.from, to: start + t.resolved.to });
    }
    setCommentRanges(editor.view, ranges);
  }, [editor, threads, head, headRevisionId, screenIsHead]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const reply = (t: Thread) => act(async () => {
    await api('POST', `/api/papers/${paperId}/comments/${t.id}/messages`, { body: replies[t.id] ?? '' });
    setReplies((r) => ({ ...r, [t.id]: '' }));
  });
  const reattach = (t: Thread) => act(async () => {
    const sel = await currentSelection();
    if ('error' in sel) throw new Error(sel.error);
    await api('POST', `/api/papers/${paperId}/comments/${t.id}/anchor`, sel);
  });

  const shown = threads.filter((t) => showResolved || t.state === 'OPEN');
  return (
    <section className="card" aria-label="코멘트" data-testid="comments">
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>코멘트</h2>
        <label className="inline"><input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> 해결된 코멘트도 보기</label>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {shown.length === 0 && <p className="hint">코멘트가 없습니다. 문장을 선택하고 "코멘트"를 누르세요.</p>}
      {shown.map((t) => (
        <article key={t.id} className="comment" data-testid="comment" data-thread-id={t.id} data-anchor={t.resolved.state}>
          <p className="hint">
            “{t.anchor.quote.replace(ATOM, '[인용]')}” · {t.state === 'RESOLVED' ? '해결됨' : '열림'}
            {t.resolved.state === 'ORPHANED' ? ` · 위치를 잃음(${ORPHAN_REASON[t.resolved.reason]})` : t.resolved.moved ? ' · 위치 이동됨' : ''}
          </p>
          {t.messages.map((m) => <p key={m.id} className="comment-message">{m.body}</p>)}
          <div className="toolbar">
            <input aria-label="답글" value={replies[t.id] ?? ''} onChange={(e) => setReplies((r) => ({ ...r, [t.id]: e.target.value }))} />
            <button type="button" onClick={() => void reply(t)} disabled={!(replies[t.id] ?? '').trim()}>답글</button>
            {t.state === 'OPEN'
              ? <button type="button" onClick={() => void act(() => api('POST', `/api/papers/${paperId}/comments/${t.id}/resolve`))}>해결</button>
              : <button type="button" onClick={() => void act(() => api('POST', `/api/papers/${paperId}/comments/${t.id}/reopen`))}>다시 열기</button>}
            {t.resolved.state === 'ORPHANED' && <button type="button" onClick={() => void reattach(t)}>선택한 곳에 다시 연결</button>}
          </div>
        </article>
      ))}
    </section>
  );
}
