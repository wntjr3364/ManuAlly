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
import { INTENTS, MAX_INSTRUCTION, buildSelectionRequest, describeQuote, freezeSelection, intentAllowed, type Intent, type SelectionRequest } from './request.ts';
import { frozenRange, setFrozenRange } from './frozen-highlight.ts';

type BlockTarget = Extract<SelectionTarget, { kind: 'block' }>;
type Mode = Intent | 'comment';
interface Frozen { intent: Mode; target: BlockTarget; selection: SelectionSnapshot; baseRevisionId: string }

export interface SelectionChatProps {
  editor: Editor | null;
  documentId: string;
  baseRevisionId: string;
  // the screen equals the stored revision and the editor is editable
  canRequest: boolean;
  outlineApproved: boolean;
  // sends the request (e.g. stores the selection handle on the server); the text is shown with it
  onRequest?: (req: SelectionRequest) => Promise<string>;
  // starts a comment thread on the frozen selection (PW-018); resolves to an error text or ''
  onComment?: (target: { document_id: string; base_revision_id: string; selection: SelectionSnapshot }, body: string) => Promise<string>;
}

const blockLabel = (t: BlockTarget) => `${t.blockType === 'heading' ? '제목' : '문단'} ${t.blockIndex + 1}`;
const excerpt = (q: string) => (q.length > 80 ? `${q.slice(0, 77)}…` : q);

export function SelectionChat({ editor, documentId, baseRevisionId, canRequest, outlineApproved, onRequest, onComment }: SelectionChatProps) {
  const [target, setTarget] = useState<SelectionTarget>({ kind: 'none' });
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [instruction, setInstruction] = useState('');
  const [message, setMessage] = useState('');
  const [requests, setRequests] = useState<{ request: SelectionRequest; state: string }[]>([]);
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
      if (t.kind === 'block') setMessage(''); // an earlier "select first" no longer applies
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
        const button = toolbarRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])');
        if (button) { setMessage(''); button.focus(); return; }
        // every action is disabled: say why (the hint next to the buttons is not announced)
        setMessage(toolbarRef.current?.querySelector('.hint')?.textContent || '이 선택에는 지금 사용할 수 있는 작업이 없습니다');
      }
    };
    dom.addEventListener('keydown', onKey);
    return () => dom.removeEventListener('keydown', onKey);
  }, [editor]);

  const open = useCallback(async (intent: Mode) => {
    if (!editor || target.kind !== 'block' || !canRequest) return;
    const t = target; // frozen now, before anything else can change
    const json = editor.getJSON();
    const docAtStart = editor.state.doc;
    try {
      const selection = await freezeSelection(json, t);
      // the document changed while hashing: the screen positions no longer fit, start over
      if (editor.state.doc !== docAtStart) { setMessage('문서가 바뀌었습니다 — 다시 선택하세요'); return; }
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

  // Esc closes the open popup wherever the focus is: right after opening, the focus reaches the box a
  // tick later, and an Esc in between went to the editor and was lost. In the box its own handler
  // decides (an Esc that ends an IME composition keeps the popup). The editor's keymap may already have
  // marked the key handled; while the popup is open nothing else uses Esc.
  useEffect(() => {
    if (!frozen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
      if (e.target instanceof Node && e.target === inputRef.current) return;
      // only from the editor, the popup or no focused control: an Esc meant for another dialog or
      // menu opened on top does not close this one (and lose its text; review nit)
      const t = e.target instanceof Node ? e.target : null;
      const fromHere = !t || t === document.body || editor?.view.dom.contains(t) || hostRef.current?.contains(t);
      if (!fromHere) return;
      e.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [frozen, close, editor]);

  const submit = () => {
    if (!frozen) return;
    if (frozen.intent === 'comment') {
      const body = instruction.trim();
      if (!body) { setMessage('코멘트 내용을 입력하세요'); return; }
      if (body.length > 10000) { setMessage('코멘트는 10000자 이하로 써 주세요'); return; }
      const target = { document_id: documentId, base_revision_id: frozen.baseRevisionId, selection: frozen.selection };
      close();
      void onComment?.(target, body).then((err) => { if (err) setMessage(err); });
      return;
    }
    const r = buildSelectionRequest({ documentId, baseRevisionId: frozen.baseRevisionId, selection: frozen.selection }, frozen.intent, instruction);
    if (!r.ok) { setMessage(r.error); return; }
    const index = requests.length;
    setRequests((rs) => [...rs, { request: r.request, state: onRequest ? '보내는 중…' : '준비됨(AI 연결 전)' }]);
    if (onRequest) {
      void onRequest(r.request).then((state) => setRequests((rs) => rs.map((x, i) => (i === index ? { ...x, state } : x))));
    }
    close();
  };

  const onInputKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    // Esc during an IME composition cancels the composition, not the popup
    if (e.key === 'Escape' && !composing) { e.preventDefault(); close(); return; }
    // Enter sends; Shift+Enter is a new line; Enter that ends an IME composition never sends
    if (e.key === 'Enter' && !e.shiftKey && !composing) { e.preventDefault(); submit(); }
  };

  const hint = !canRequest ? '저장된 뒤 요청할 수 있습니다' : '';
  return (
    <div ref={hostRef} className="selection-chat-host">
      {!frozen && target.kind !== 'none' && pos && (
        <div ref={toolbarRef} role="toolbar" aria-label="선택 도구" className="selection-toolbar" data-testid="selection-toolbar" style={{ top: pos.top, left: pos.left }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); editor?.view.focus(); } }}>
          {target.kind === 'multi' ? (
            <span className="hint">한 문단 안에서 선택하세요</span>
          ) : (
            <>
              {(Object.keys(INTENTS) as Intent[]).map((i) => {
                const allowed = intentAllowed(i, outlineApproved);
                const textless = INTENTS[i].edits && !describeQuote(target.quote).editable;
                return (
                  <button key={i} type="button" disabled={!canRequest || !allowed || textless}
                    title={!allowed ? '개요를 승인한 뒤 사용할 수 있습니다' : textless ? '글자가 없는 선택(인용·공백만)은 고칠 수 없습니다' : hint || undefined}
                    onMouseDown={(e) => e.preventDefault()} onClick={() => void open(i)}>{INTENTS[i].label}</button>
                );
              })}
              {onComment && (
                <button type="button" disabled={!canRequest} title={hint || undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => void open('comment')}>코멘트</button>
              )}
              {hint && <span className="hint">{hint}</span>}
            </>
          )}
        </div>
      )}
      {frozen && (
        <div role="dialog" aria-label={frozen.intent === 'comment' ? '코멘트' : `${INTENTS[frozen.intent].label} 요청`} className="selection-popup card" data-testid="selection-popup">
          <p className="hint" data-testid="selection-scope">
            {(() => {
              const q = describeQuote(frozen.target.quote, frozen.selection.atoms); // the target quote keeps a placeholder per atom
              return <>대상: {blockLabel(frozen.target)} · 선택 {q.chars}자{q.atomCount ? ` · 인용 등 ${q.atomCount}개` : ''} “{excerpt(q.display)}”</>;
            })()}
          </p>
          <p className="hint">
            {frozen.intent === 'comment'
              ? '이 선택에 코멘트를 남깁니다. 원고는 바뀌지 않습니다.'
              : INTENTS[frozen.intent].edits
                ? '이 선택 범위만 바꾸는 제안을 만듭니다. 원고는 diff를 확인하고 적용할 때만 바뀝니다.'
                : '질문에 답만 합니다. 원고는 바뀌지 않습니다.'}
          </p>
          <label>
            {frozen.intent === 'comment' ? '코멘트' : frozen.intent === 'ask' ? '질문' : '지시(선택)'}
            <textarea ref={inputRef} value={instruction} maxLength={frozen.intent === 'comment' ? 10000 : MAX_INSTRUCTION} rows={3} onChange={(e) => setInstruction(e.target.value)} onKeyDown={onInputKey} />
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
          {requests.map(({ request: r, state }, i) => (
            <p key={i} className="hint" data-request={JSON.stringify(r)} data-state={state}>
              {INTENTS[r.intent].label}: “{excerpt(r.selection.quote)}”{r.selection.atoms.length ? ` (인용 등 ${r.selection.atoms.length}개)` : ''}{r.instruction ? ` — ${r.instruction}` : ''} · {state}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
