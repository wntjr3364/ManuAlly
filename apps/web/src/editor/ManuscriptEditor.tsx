// The manuscript editor (PW-015): rich text, autosave with server acknowledgement, a local recovery
// copy, and IME safety.
// - "저장됨" only after the server stored exactly what is on screen (save-state.ts, autosave.ts)
// - no save and no outside change while an IME composition is in progress
// - unsaved text is also kept in this browser (per account and document, 7 days, can be turned off,
//   removed at logout) and offered back when the page is opened again; a copy made from an older
//   server version is shown for copying, never merged silently
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import { EDITOR_SCHEMA_VERSION, canonicalJson, validateDocument } from '@pw/editor-core';
import { ApiError, api } from '../app/api.ts';
import { setUnsaved } from '../app/unsaved.ts';
import { editorExtensions } from '../features/paper/editor-extensions.ts';
import { reconcileBlockIds } from '../features/paper/block-ids.ts';
import { initialSaveState, isUnsaved, saveLabel, saveReducer } from '../features/paper/save-state.ts';
import { Autosave, type SaveRequest, type SendResult } from './autosave.ts';
import { applyExternalPatch } from './patch-gate.ts';
import { browserStorage, clearDraft, isRecoveryEnabled, loadDraft, purgeExpired, recoveryOwner, saveDraft, setRecoveryEnabled, type Draft } from './recovery.ts';
import { ReadOnlyDocument, renderDocument } from './ReadOnlyDocument.tsx';

export interface Revision { id: string; content_json: JSONContent; schema_version: number }
export interface DocInfo { document: { id: string; kind: string; head_revision_id: string }; head: Revision }

const DRAFT_DELAY_MS = 400;

type Offer = { kind: 'restore' | 'diverged'; draft: Draft } | null;

function findOffer(info: DocInfo): Offer {
  const storage = browserStorage();
  const owner = recoveryOwner();
  if (!storage || !owner) return null;
  purgeExpired(storage, Date.now());
  const draft = loadDraft(storage, owner, info.document.id, Date.now());
  if (!draft) return null;
  if (canonicalJson(draft.content) === canonicalJson(info.head.content_json)) {
    clearDraft(storage, owner, info.document.id);
    return null;
  }
  return { kind: draft.baseRevisionId === info.head.id ? 'restore' : 'diverged', draft };
}

export function ManuscriptEditor({ paperId, info }: { paperId: string; info: DocInfo }) {
  const [save, dispatch] = useReducer(saveReducer, info.head.id, initialSaveState);
  const containerRef = useRef<HTMLDivElement>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [contentError, setContentError] = useState('');
  const [offer, setOffer] = useState<Offer>(() => findOffer(info));
  const [draftNote, setDraftNote] = useState('');
  const storage = useMemo(() => browserStorage(), []);
  const owner = recoveryOwner();
  const [recoveryOn, setRecoveryOn] = useState(() => (storage && owner ? isRecoveryEnabled(storage, owner) : false));
  const offerRef = useRef(offer);
  offerRef.current = offer;
  const recoveryOnRef = useRef(recoveryOn);
  recoveryOnRef.current = recoveryOn;
  const manualRef = useRef(false);
  const autoRef = useRef<Autosave | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initial = info.head.content_json.content?.length ? info.head.content_json : undefined;

  const editor = useEditor({
    extensions: editorExtensions,
    content: initial,
    editable: offer === null,
    enableContentCheck: true,
    onContentError: ({ error }) => setContentError(error.message),
    onCreate: ({ editor: ed }) => {
      // give blocks without ids their ids without marking the document edited
      const fix = reconcileBlockIds(ed.state.doc, ed.state, []);
      if (fix) ed.view.dispatch(fix.setMeta('pw-init', true));
    },
    onUpdate: ({ transaction }) => {
      if (transaction.docChanged && !transaction.getMeta('pw-init')) {
        autoRef.current?.edit();
        scheduleDraft();
      }
    },
  });
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const writeDraft = useCallback(() => {
    const ed = editorRef.current;
    const auto = autoRef.current;
    if (!ed || !auto || !storage || !owner || !recoveryOnRef.current || offerRef.current) return;
    if (auto.version === 0) return;
    const r = saveDraft(storage, { ownerId: owner, paperId, documentId: info.document.id, baseRevisionId: auto.headRevisionId, schemaVersion: EDITOR_SCHEMA_VERSION, content: ed.getJSON(), savedAt: Date.now() });
    setDraftNote(r.ok || r.error === 'disabled' ? '' : r.error);
  }, [storage, owner, paperId, info.document.id]);

  function scheduleDraft() {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(writeDraft, DRAFT_DELAY_MS);
  }

  // the autosave controller lives as long as this editor
  useEffect(() => {
    if (!editor) return;
    const send = async (req: SaveRequest): Promise<SendResult> => {
      const reason = manualRef.current ? 'manual' : 'autosave';
      manualRef.current = false;
      try {
        const rev = await api<{ id: string }>('POST', `/api/papers/${paperId}/documents/${info.document.id}/saves`, {
          expected_head_revision_id: req.expectedHead, content_json: req.json, schema_version: EDITOR_SCHEMA_VERSION, reason,
        });
        setProblems([]);
        return { ok: true, headRevisionId: rev.id };
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.status === 409) return { ok: false, kind: 'conflict', message: '서버 응답 409' };
          if (e.status >= 500) return { ok: false, kind: 'server', message: `서버 응답 ${e.status} — 잠시 후 다시 시도합니다` };
          if (e.body?.errors) setProblems(e.body.errors.map((x) => `${x.code}: ${x.message}`));
          return { ok: false, kind: 'rejected', message: e.status === 401 ? '로그인이 필요합니다' : `서버 응답 ${e.status}` };
        }
        return { ok: false, kind: 'network', message: navigator.onLine ? '네트워크 오류 — 잠시 후 다시 시도합니다' : '오프라인 — 연결되면 다시 저장합니다' };
      }
    };
    const auto = new Autosave({
      headRevisionId: info.head.id,
      savedKey: canonicalJson(editor.getJSON()),
      snapshot: () => {
        const json = editor.getJSON();
        const checked = validateDocument(json, EDITOR_SCHEMA_VERSION);
        if (!checked.ok) return { invalid: checked.errors.map((x) => `${x.code}: ${x.message}`) };
        setProblems([]);
        return { json, key: canonicalJson(json) };
      },
      isComposing: () => editor.view.composing,
      send,
      dispatch,
      onInvalid: setProblems,
      onSaved: (req) => {
        if (!storage || !owner) return;
        // fully saved: the recovery copy is no longer needed; otherwise rebase it on the new head
        if (auto.version === req.version) clearDraft(storage, owner, info.document.id);
        else writeDraft();
      },
    });
    autoRef.current = auto;
    const dom = editor.view.dom;
    // ProseMirror leaves composing mode just after compositionend
    const onCompositionEnd = () => setTimeout(() => auto.compositionEnded(), 0);
    const onOnline = () => auto.online();
    dom.addEventListener('compositionend', onCompositionEnd);
    addEventListener('online', onOnline);
    return () => {
      dom.removeEventListener('compositionend', onCompositionEnd);
      removeEventListener('online', onOnline);
      auto.dispose();
      autoRef.current = null;
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [editor, info.document.id, info.head.id, paperId, storage, owner, writeDraft]);

  const unsaved = isUnsaved(save);
  useEffect(() => { setUnsaved(`manuscript:${info.document.id}`, unsaved ? '원고' : null); }, [unsaved, info.document.id]);
  useEffect(() => () => setUnsaved(`manuscript:${info.document.id}`, null), [info.document.id]);

  const saveNow = useCallback(() => { manualRef.current = true; autoRef.current?.saveNow(); }, []);

  // Ctrl/Cmd+S only while focus is in this editor area (spec 04: shortcuts work inside the editor)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && containerRef.current?.contains(document.activeElement)) {
        e.preventDefault();
        saveNow();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [saveNow]);

  // development-only handle for browser tests of the outside-change gate (never in a production build)
  useEffect(() => {
    if (!import.meta.env.DEV || !editor || !(window as { __PW_TEST_HOOKS__?: boolean }).__PW_TEST_HOOKS__) return;
    (window as { __pwManuscript?: unknown }).__pwManuscript = {
      composing: () => editor.view.composing,
      insertAtStart: (text: string) => applyExternalPatch(editor.view, (s) => s.tr.insertText(text, 1)),
    };
  }, [editor]);

  const restore = () => {
    if (!editor || offer?.kind !== 'restore') return;
    setOffer(null);
    offerRef.current = null;
    editor.setEditable(true);
    // replaces the screen with the recovered text; it is then unsaved and autosaved like typing
    editor.commands.setContent(offer.draft.content as JSONContent, { emitUpdate: true });
  };
  const discard = () => {
    if (storage && owner) clearDraft(storage, owner, info.document.id);
    setOffer(null);
    offerRef.current = null;
    editor?.setEditable(true);
  };
  const toggleRecovery = (on: boolean) => {
    if (!storage || !owner) return;
    setRecoveryEnabled(storage, owner, on);
    setRecoveryOn(on);
    recoveryOnRef.current = on;
    if (on && autoRef.current && isUnsaved(save)) writeDraft();
  };

  if (contentError) return <ReadOnlyDocument content={info.head.content_json} reason={`편집기가 읽을 수 없는 내용(${contentError})`} />;
  // a mouse click on a formatting button leaves focus and selection in the text, so the next key
  // goes to the editor (not to the button, where Space would press it again); keyboard users can
  // still Tab to the buttons
  const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();
  const mark = (name: 'bold' | 'italic' | 'subscript' | 'superscript', label: string) => (
    <button type="button" aria-pressed={editor?.isActive(name) ?? false} disabled={offer !== null} onMouseDown={keepFocus} onClick={() => editor?.chain().focus().toggleMark(name).run()}>{label}</button>
  );
  const when = offer ? new Date(offer.draft.savedAt).toLocaleString() : '';
  return (
    <section className="card" ref={containerRef}>
      {offer?.kind === 'restore' && (
        <div role="alert" className="notice" data-testid="recovery-offer">
          <p>이 브라우저에 저장되지 않은 원고 변경이 남아 있습니다({when}). 불러오면 화면에 올린 뒤 자동 저장합니다.</p>
          <button type="button" className="primary" onClick={restore}>복구본 불러오기</button>
          <button type="button" onClick={discard}>복구본 버리기</button>
        </div>
      )}
      {offer?.kind === 'diverged' && (
        <div role="alert" className="notice" data-testid="recovery-offer">
          <p>이 브라우저에 남은 복구본({when})은 그 뒤 서버에서 바뀐 원고보다 오래된 버전을 바탕으로 합니다. 자동으로 합치지 않습니다. 필요한 부분을 아래에서 복사한 뒤 버리세요.</p>
          <div className="editor readonly" data-testid="recovery-text">{renderDocument(offer.draft.content as JSONContent)}</div>
          <button type="button" onClick={discard}>복구본 버리기</button>
        </div>
      )}
      <div className="toolbar">
        {mark('bold', '굵게')}
        {mark('italic', '기울임')}
        {mark('subscript', '아래첨자')}
        {mark('superscript', '위첨자')}
        <button type="button" disabled={offer !== null} onMouseDown={keepFocus} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>제목</button>
        <button type="button" className="primary" onClick={saveNow} disabled={save.status === 'saving' || offer !== null}>저장</button>
        <span role="status" data-testid="save-status" className={`save-status ${unsaved ? 'unsaved' : 'saved'}`}>{saveLabel(save)}</span>
      </div>
      {problems.length > 0 && <ul role="alert" className="error">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <div className="editor" data-testid="editor"><EditorContent editor={editor} /></div>
      {storage && owner && (
        <p className="hint">
          <label className="inline">
            <input type="checkbox" checked={recoveryOn} onChange={(e) => toggleRecovery(e.target.checked)} /> 저장되지 않은 변경을 이 브라우저에 임시 보관(7일, 로그아웃하면 삭제)
          </label>
          {draftNote && <span role="alert" className="error"> {draftNote}</span>}
        </p>
      )}
    </section>
  );
}
