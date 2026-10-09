// Selection toolbar and short instruction popup (PW-016, spec 04 "선택 → 작은 toolbar").
// - The toolbar appears for a non-empty selection inside one paragraph or heading. A selection across
//   blocks says so; an empty selection has no target (never the whole manuscript).
// - Choosing an action freezes the selection against the stored revision (request.ts). Typing an
//   instruction, moving focus, or further edits never change that frozen request.
// - Requests are enabled only while the screen equals the stored revision ("저장됨").
// - Ctrl/Cmd+Shift+K inside the editor moves focus to the toolbar; Esc closes the popup and puts the
//   frozen range back as the editor selection.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { SelectionError, type SelectionSnapshot } from '@pw/editor-core';
import { selectionTarget, type SelectionTarget } from './target.ts';
import { INTENTS, MAX_INSTRUCTION, buildSelectionRequest, freezeSelection, intentAllowed, type Intent, type SelectionRequest } from './request.ts';
import { frozenRange, setFrozenRange } from './frozen-highlight.ts';

type BlockTarget = Extract<SelectionTarget, { kind: 'block' }>;
interface Frozen { intent: Intent; target: BlockTarget; selection: SelectionSnapshot; baseRevisionId: string }

export interface SelectionChatProps {
  editor: Editor | null;
  documentId: string;
  baseRevisionId: string;
  // the screen equals the stored revision and the editor is editable
  canRequest: boolean;
  outlineApproved: boolean;
  onRequest?: (req: SelectionRequest) => void;
}

const blockLabel = (t: BlockTarget) => `${t.blockType === 'heading' ? '제목' : '문단'} ${t.blockIndex + 1}`;
const excerpt = (q: string) => (q.length > 80 ? `${q.slice(0, 77)}…` : q);

export function SelectionChat({ editor, documentId, baseRevisionId, canRequest, outlineApproved, onRequest }: SelectionChatProps) {
  const [target, setTarget] = useState<SelectionTarget>({ kind: 'none' });
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [instruction, setInstruction] = useState('');
  const [message, setMessage] = useState('');
  const [requests, setRequests] = useState<SelectionRequest[]>([]);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  // follow the editor selection while no popup is open
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const { from, to } = editor.state.selection;
      const t = selectionTarget(editor.state.doc, from, to);
      setTarget(t);
      if (t.kind === 'none' || !hostRef.current) { setPos(null); return; }
      const host = hostRef.current.getBoundingClientRect();
      const c = editor.view.coordsAtPos(Math.min(from, to));
      setPos({ top: c.top - host.top - 40, left: Math.max(0, c.left - host.left) });
    };
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    return () => { editor.off('selectionUpdate', update); editor.off('transaction', update); };
  }, [editor]);

  // keyboard: Ctrl/Cmd+Shift+K in the editor focuses the toolbar
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const t = selectionTarget(editor.state.doc, editor.state.selection.from, editor.state.selection.to);
        if (t.kind !== 'block') { setMessage(t.kind === 'multi' ? '한 문단 안에서 선택하세요' : '먼저 문장을 선택하세요'); return; }
        setMessage('');
        toolbarRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
      }
    };
    dom.addEventListener('keydown', onKey);
    return () => dom.removeEventListener('keydown', onKey);
  }, [editor]);

  const open = useCallback(async (intent: Intent) => {
    if (!editor || target.kind !== 'block' || !canRequest) return;
    const t = target; // frozen now, before anything else can change
    const json = editor.getJSON();
    try {
      const selection = await freezeSelection(json, t);
      setFrozen({ intent, target: t, selection, baseRevisionId });
      setInstruction('');
      setMessage('');
      setFrozenRange(editor.view, { from: t.absFrom, to: t.absTo });
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (e) {
      setMessage(e instanceof SelectionError && /SPLITS/.test(e.code) ? '선택 경계가 글자 중간에 있습니다 — 다시 선택하세요' : `선택을 고정하지 못했습니다 (${e instanceof Error ? e.message : String(e)})`);
    }
  }, [editor, target, canRequest, baseRevisionId]);

  const close = useCallback(() => {
    if (!editor) return;
    const r = frozenRange(editor.state);
    setFrozenRange(editor.view, null);
    setFrozen(null);
    setMessage('');
    if (r) editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, r.from, r.to)));
    editor.view.focus();
  }, [editor]);

  const submit = () => {
    if (!frozen) return;
    const r = buildSelectionRequest({ documentId, baseRevisionId: frozen.baseRevisionId, selection: frozen.selection }, frozen.intent, instruction);
    if (!r.ok) { setMessage(r.error); return; }
    setRequests((rs) => [...rs, r.request]);
    onRequest?.(r.request);
    close();
  };

  const onInputKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    // Enter sends; Shift+Enter is a new line; Enter that ends an IME composition never sends
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
  };

  const hint = !canRequest ? '저장된 뒤 요청할 수 있습니다' : '';
  return (
    <div ref={hostRef} className="selection-chat-host">
      {!frozen && target.kind !== 'none' && pos && (
        <div ref={toolbarRef} role="toolbar" aria-label="선택 도구" className="selection-toolbar" data-testid="selection-toolbar" style={{ top: pos.top, left: pos.left }}>
          {target.kind === 'multi' ? (
            <span className="hint">한 문단 안에서 선택하세요</span>
          ) : (
            <>
              {(Object.keys(INTENTS) as Intent[]).map((i) => {
                const allowed = intentAllowed(i, outlineApproved);
                return (
                  <button key={i} type="button" disabled={!canRequest || !allowed} title={!allowed ? '개요를 승인한 뒤 사용할 수 있습니다' : hint || undefined}
                    onMouseDown={(e) => e.preventDefault()} onClick={() => void open(i)}>{INTENTS[i].label}</button>
                );
              })}
              {hint && <span className="hint">{hint}</span>}
            </>
          )}
        </div>
      )}
      {frozen && (
        <div role="dialog" aria-label={`${INTENTS[frozen.intent].label} 요청`} className="selection-popup card" data-testid="selection-popup">
          <p className="hint" data-testid="selection-scope">
            대상: {blockLabel(frozen.target)} · 선택 {frozen.selection.quote.length}자 “{excerpt(frozen.selection.quote)}”
          </p>
          <p className="hint">
            {INTENTS[frozen.intent].edits
              ? '이 선택 범위만 바꾸는 제안을 만듭니다. 원고는 diff를 확인하고 적용할 때만 바뀝니다.'
              : '질문에 답만 합니다. 원고는 바뀌지 않습니다.'}
          </p>
          <label>
            {frozen.intent === 'ask' ? '질문' : '지시(선택)'}
            <textarea ref={inputRef} value={instruction} maxLength={MAX_INSTRUCTION} rows={3} onChange={(e) => setInstruction(e.target.value)} onKeyDown={onInputKey} />
          </label>
          {message && <p role="alert" className="error">{message}</p>}
          <div className="toolbar">
            <button type="button" className="primary" onClick={submit}>보내기</button>
            <button type="button" onClick={close}>취소</button>
          </div>
        </div>
      )}
      {!frozen && message && <p role="alert" className="error" data-testid="selection-message">{message}</p>}
      {requests.length > 0 && (
        <section aria-label="선택 요청" data-testid="selection-requests">
          {requests.map((r, i) => (
            <p key={i} className="hint" data-request={JSON.stringify(r)}>
              {INTENTS[r.intent].label}: “{excerpt(r.selection.quote)}”{r.instruction ? ` — ${r.instruction}` : ''} · 준비됨(AI 연결 전)
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
