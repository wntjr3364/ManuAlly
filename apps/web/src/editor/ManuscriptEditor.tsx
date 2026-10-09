// The manuscript editor (PW-015): rich text, autosave with server acknowledgement, a local recovery
// copy, and IME safety.
// - "저장됨" only after the server stored exactly what is on screen (save-state.ts, autosave.ts)
// - no save and no outside change while an IME composition is in progress
// - unsaved text is also kept in this browser (per account, document and tab; 7 days; can be turned
//   off; removed at logout) and offered back when the page is opened again. A copy made from an older
//   server version is shown for copying, never merged silently. Copies of tabs that are still open
//   are left to them (Web Locks, recovery.ts). A logout in another tab stops copies in this one.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import { EDITOR_SCHEMA_VERSION, canonicalJson, validateDocument } from '@pw/editor-core';
import { ApiError, api, setCsrf } from '../app/api.ts';
import { setUnsaved } from '../app/unsaved.ts';
import { editorExtensions } from '../features/paper/editor-extensions.ts';
import { reconcileBlockIds } from '../features/paper/block-ids.ts';
import { initialSaveState, isUnsaved, saveLabel, saveReducer } from '../features/paper/save-state.ts';
import { Autosave, type SaveRequest, type SendResult } from './autosave.ts';
import { applyExternalPatch } from './patch-gate.ts';
import {
  browserLocks, browserStorage, clearDraft, endRecoveryForPage, isLogoutEvent, isRecoveryEnabled, loadDrafts, openTabIds, pageTabId, purgeExpired,
  recoveryEndedForPage, recoveryOwner, saveDraft, setRecoveryEnabled, storageWorks, type Draft,
} from './recovery.ts';
import { ReadOnlyDocument, renderDocument } from './ReadOnlyDocument.tsx';
import { SelectionChat } from '../features/selection-chat/SelectionChat.tsx';
import { FrozenSelection } from '../features/selection-chat/frozen-highlight.ts';
import type { SelectionRequest } from '../features/selection-chat/request.ts';
import { ProposalPanel, type AppliedRevision } from '../features/diff/ProposalPanel.tsx';
import { JobStreams, type JobRef } from '../features/chat/JobStream.tsx';
import { CommentsPanel } from '../features/comments/CommentsPanel.tsx';
import { CommentHighlights } from '../features/comments/comment-highlights.ts';
import { ReferenceLabels } from '../features/references/reference-labels.ts';
import { ReferencesPanel } from '../features/references/ReferencesPanel.tsx';
import { selectionTarget } from '../features/selection-chat/target.ts';
import { freezeSelection } from '../features/selection-chat/request.ts';
import type { SelectionSnapshot } from '@pw/editor-core';

export interface Revision { id: string; content_json: JSONContent; schema_version: number }
export interface DocInfo { document: { id: string; kind: string; head_revision_id: string }; head: Revision }

const DRAFT_DELAY_MS = 400;
const LOGIN_EXPIRED = '로그인이 만료되었습니다 — 다른 탭에서 다시 로그인한 뒤 저장을 누르세요';

// recovery copies to offer when the editor opens; copies equal to the stored text are dropped
function findOffers(info: DocInfo, tabId: string, openTabs: Set<string> | null): Draft[] {
  const storage = browserStorage();
  const owner = recoveryOwner();
  if (!storage || !owner) return [];
  purgeExpired(storage, Date.now());
  return loadDrafts(storage, owner, info.document.id, tabId, Date.now(), openTabs).filter((d) => {
    if (canonicalJson(d.content) !== canonicalJson(info.head.content_json)) return true;
    clearDraft(storage, d);
    return false;
  });
}

const extensions = [...editorExtensions, FrozenSelection, CommentHighlights, ReferenceLabels];

// onState: the stored head and whether the screen equals it (the versions tab changes the head only then)
export interface EditorState { documentId: string; headRevisionId: string; clean: boolean }

export function ManuscriptEditor({ paperId, info, outlineApproved = false, onState }: { paperId: string; info: DocInfo; outlineApproved?: boolean; onState?: (s: EditorState) => void }) {
  const [save, dispatch] = useReducer(saveReducer, info.head.id, initialSaveState);
  const containerRef = useRef<HTMLDivElement>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [contentError, setContentError] = useState('');
  // this tab's id (and which other tabs are open) is known shortly after the page loads; until then
  // the editor stays locked so no copy is written or offered under the wrong id
  const [tabId, setTabId] = useState<string | null>(null);
  const [offers, setOffers] = useState<Draft[]>([]);
  const [draftNote, setDraftNote] = useState('');
  const storage = useMemo(() => browserStorage(), []);
  const storageOk = useMemo(() => storageWorks(storage), [storage]);
  // fixed for this editor's lifetime (a logout elsewhere stops copies via recoveryOwner(), checked on write)
  const owner = useMemo(() => recoveryOwner(), []);
  const [recoveryOn, setRecoveryOn] = useState(() => (storage && owner ? isRecoveryEnabled(storage, owner) : false));
  // signed out in another tab: nothing is kept in this page any more (the setting cannot be turned on)
  const [endedHere, setEndedHere] = useState(() => recoveryEndedForPage());
  const recoveryOnRef = useRef(recoveryOn);
  recoveryOnRef.current = recoveryOn;
  const autoRef = useRef<Autosave | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initial = info.head.content_json.content?.length ? info.head.content_json : undefined;

  const editor = useEditor({
    extensions,
    content: initial,
    editable: false,
    enableContentCheck: true,
    onContentError: ({ error }) => setContentError(error.message),
    onCreate: ({ editor: ed }) => {
      // give blocks without ids their ids without marking the document edited
      const fix = reconcileBlockIds(ed.state.doc, ed.state, []);
      if (fix) ed.view.dispatch(fix.setMeta('pw-init', true));
    },
    onUpdate: ({ transaction }) => {
      // pw-remote: a change the server already stored (an applied proposal), not an edit
      if (transaction.docChanged && !transaction.getMeta('pw-init') && !transaction.getMeta('pw-remote')) {
        autoRef.current?.edit();
        scheduleDraft();
      }
    },
  });
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useEffect(() => {
    let live = true;
    void (async () => {
      const { id } = await pageTabId();
      const open = await openTabIds(browserLocks());
      if (!live) return;
      setOffers(findOffers(info, id, open));
      setTabId(id);
    })();
    return () => { live = false; };
  }, [info]);

  // locked until the tab id is known, and while this tab's own copy waits for a decision (typing
  // would overwrite it); other tabs' copies do not lock the editor
  // an apply request is in flight: no typing until its result is on screen
  const [applying, setApplying] = useState(false);
  const [proposalRefresh, setProposalRefresh] = useState(0);
  // AI jobs started on this page, and a tick after each apply/reject so jobs re-read their proposal
  const [jobs, setJobs] = useState<JobRef[]>([]);
  const [proposalTick, setProposalTick] = useState(0);
  const [commentRefresh, setCommentRefresh] = useState(0);
  const locked = tabId === null || applying || offers.some((d) => d.tabId === tabId);
  useEffect(() => { editor?.setEditable(!locked); }, [editor, locked]);

  const cancelDraftTimer = () => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = null;
  };
  // writes this tab's copy of the unsaved text, based on the head it was edited from
  const writeDraft = useCallback(() => {
    draftTimer.current = null;
    const ed = editorRef.current;
    const auto = autoRef.current;
    if (!ed || !auto || !storage || !owner || !tabId || !recoveryOnRef.current || recoveryOwner() !== owner) return;
    if (auto.version === 0) return;
    const r = saveDraft(storage, { ownerId: owner, paperId, documentId: info.document.id, tabId, baseRevisionId: auto.headRevisionId, schemaVersion: EDITOR_SCHEMA_VERSION, content: ed.getJSON(), savedAt: Date.now() });
    setDraftNote(r.ok || r.error === 'disabled' ? '' : r.error);
  }, [storage, owner, paperId, info.document.id, tabId]);

  function scheduleDraft() {
    cancelDraftTimer();
    draftTimer.current = setTimeout(writeDraft, DRAFT_DELAY_MS);
  }

  // a logout in another tab: keep nothing of this manuscript in the browser any more
  useEffect(() => {
    if (!storage) return;
    const onStorage = (e: StorageEvent) => {
      if (!isLogoutEvent(e)) return;
      endRecoveryForPage();
      cancelDraftTimer();
      if (owner && tabId) clearDraft(storage, { ownerId: owner, documentId: info.document.id, tabId });
      setRecoveryOn(false);
      recoveryOnRef.current = false;
      setEndedHere(true);
    };
    addEventListener('storage', onStorage);
    return () => removeEventListener('storage', onStorage);
  }, [storage, owner, tabId, info.document.id]);

  // the autosave controller lives as long as this editor
  useEffect(() => {
    if (!editor) return;
    const url = `/api/papers/${paperId}/documents/${info.document.id}/saves`;
    const post = (req: SaveRequest) => api<{ id: string }>('POST', url, {
      expected_head_revision_id: req.expectedHead, content_json: req.json, schema_version: EDITOR_SCHEMA_VERSION, reason: req.manual ? 'manual' : 'autosave',
    });
    const failure = (e: unknown): SendResult => {
      if (e instanceof ApiError) {
        if (e.status === 409) return { ok: false, kind: 'conflict', message: '서버 응답 409' };
        if (e.status >= 500) return { ok: false, kind: 'server', message: `서버 응답 ${e.status} — 잠시 후 다시 시도합니다` };
        if (e.body?.errors) setProblems(e.body.errors.map((x) => `${x.code}: ${x.message}`));
        return { ok: false, kind: 'rejected', message: e.status === 401 ? LOGIN_EXPIRED : `서버 응답 ${e.status}` };
      }
      return { ok: false, kind: 'network', message: navigator.onLine ? '네트워크 오류 — 잠시 후 다시 시도합니다' : '오프라인 — 연결되면 다시 저장합니다' };
    };
    const send = async (req: SaveRequest): Promise<SendResult> => {
      let rev: { id: string };
      try {
        rev = await post(req);
      } catch (e) {
        if (!(e instanceof ApiError && (e.status === 401 || e.status === 403))) return failure(e);
        // the login may have been renewed in another tab: take its CSRF token and try once more
        const fresh = await api<{ csrfToken: string }>('GET', '/api/auth/session').catch(() => null);
        if (!fresh) return { ok: false, kind: 'rejected', message: LOGIN_EXPIRED };
        setCsrf(fresh.csrfToken);
        try {
          rev = await post(req);
        } catch (e2) {
          return failure(e2);
        }
      }
      setProblems([]);
      return { ok: true, headRevisionId: rev.id };
    };
    const auto = new Autosave({
      headRevisionId: info.head.id,
      // what the server is known to hold: the stored revision itself
      savedKey: canonicalJson(info.head.content_json),
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
        if (!storage || !owner || !tabId) return;
        if (auto.version === req.version) {
          // fully saved: this tab's copy is no longer needed (and no pending write may bring it back)
          cancelDraftTimer();
          clearDraft(storage, { ownerId: owner, documentId: info.document.id, tabId });
        } else writeDraft(); // newer text on screen: keep it, now based on the new head
      },
    });
    autoRef.current = auto;
    const dom = editor.view.dom;
    // ProseMirror leaves composing mode just after compositionend
    const onCompositionEnd = () => setTimeout(() => auto.compositionEnded(), 0);
    const onOnline = () => auto.online();
    const onResume = () => { if (document.visibilityState === 'visible') auto.resume(); };
    dom.addEventListener('compositionend', onCompositionEnd);
    addEventListener('online', onOnline);
    addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      dom.removeEventListener('compositionend', onCompositionEnd);
      removeEventListener('online', onOnline);
      removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
      auto.dispose();
      autoRef.current = null;
      cancelDraftTimer();
    };
  }, [editor, info.document.id, info.head.id, info.head.content_json, paperId, storage, owner, tabId, writeDraft]);

  const unsaved = isUnsaved(save);
  const clean = save.status === 'saved' && !unsaved && !applying;
  useEffect(() => { onState?.({ documentId: info.document.id, headRevisionId: save.headRevisionId, clean }); }, [onState, info.document.id, save.headRevisionId, clean]);
  useEffect(() => { setUnsaved(`manuscript:${info.document.id}`, unsaved ? '원고' : null); }, [unsaved, info.document.id]);
  useEffect(() => () => setUnsaved(`manuscript:${info.document.id}`, null), [info.document.id]);

  const saveNow = useCallback(() => { autoRef.current?.saveNow(); }, []);

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
      // selects the first occurrence of text (inside one block) as a user would with the mouse
      selectText: (text: string) => {
        let found: { from: number; to: number } | null = null;
        editor.state.doc.descendants((node, pos) => {
          if (found || !node.isText) return;
          const i = node.text!.indexOf(text);
          if (i >= 0) found = { from: pos + i, to: pos + i + text.length };
        });
        if (found) editor.chain().focus().setTextSelection(found).run();
        return found;
      },
      // moves block i after block j, as drag and drop does (the block keeps its attributes)
      moveBlock: (i: number, j: number) => {
        const starts: number[] = [];
        editor.state.doc.forEach((_n, offset) => starts.push(offset));
        const node = editor.state.doc.child(i);
        const tr = editor.state.tr.delete(starts[i]!, starts[i]! + node.nodeSize);
        const target = editor.state.doc.child(j);
        tr.insert(tr.mapping.map(starts[j]! + target.nodeSize), node);
        editor.view.dispatch(tr);
      },
    };
  }, [editor]);

  const offer = offers[0];
  // a copy can be put back only onto the very revision it was edited from, with nothing unsaved on screen
  const canRestore = offer !== undefined && offer.baseRevisionId === save.headRevisionId && !unsaved;
  const restore = () => {
    if (!editor || !offer || !canRestore) return;
    // the text now belongs to this tab: its own copy replaces the old one once it is written
    if (storage && offer.tabId !== tabId) clearDraft(storage, offer);
    setOffers(offers.slice(1));
    editor.setEditable(true);
    // replaces the screen with the recovered text; it is then unsaved and autosaved like typing
    editor.commands.setContent(offer.content as JSONContent, { emitUpdate: true });
  };
  const discard = () => {
    if (!offer) return;
    if (storage) clearDraft(storage, offer);
    setOffers(offers.slice(1));
  };
  const toggleRecovery = (on: boolean) => {
    if (!storage || !owner) return;
    setRecoveryEnabled(storage, owner, on);
    setRecoveryOn(on);
    recoveryOnRef.current = on;
    if (on && unsaved) writeDraft();
  };

  // Puts an applied proposal's paragraph on screen and adopts the server's new head, so no extra
  // autosave follows. If the screen does not then equal the stored revision exactly, nothing is adopted.
  const adoptApplied = (rev: AppliedRevision, afterBlock: JSONContent): boolean => {
    if (!editor || editor.view.composing) return false;
    let at = -1;
    editor.state.doc.forEach((n, offset) => { if (n.attrs.id === afterBlock.attrs?.id) at = offset; });
    if (at < 0) return false;
    const node = editor.state.doc.nodeAt(at)!;
    editor.view.dispatch(editor.state.tr.replaceWith(at, at + node.nodeSize, editor.schema.nodeFromJSON(afterBlock)).setMeta('pw-remote', true).setMeta('addToHistory', false));
    const key = canonicalJson(rev.content_json);
    if (canonicalJson(editor.getJSON()) !== key) return false;
    if (!autoRef.current?.adopt(rev.id, key)) return false;
    if (storage && owner && tabId) clearDraft(storage, { ownerId: owner, documentId: info.document.id, tabId });
    return true;
  };
  // A request becomes a server job (selection handle + job in one transaction). A resend after a lost
  // answer uses the same key, so it never creates a second job.
  const sendSelection = async (req: SelectionRequest): Promise<string> => {
    const key = crypto.randomUUID();
    const body = { base_revision_id: req.base_revision_id, selection: req.selection, intent: req.intent, instruction: req.instruction, idempotency_key: key };
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await api<{ job: { id: string } }>('POST', `/api/papers/${paperId}/documents/${info.document.id}/ai-requests`, body);
        setJobs((js) => (js.some((j) => j.id === r.job.id) ? js : [...js, { id: r.job.id, intent: req.intent, instruction: req.instruction, quote: req.selection.quote.replace(/\ufffc/g, '[…]') }]));
        return '서버 확인됨 — AI 작업 등록(아래 “AI 작업”에서 진행 확인)';
      } catch (e) {
        if (!(e instanceof ApiError) && attempt === 0) continue; // answer lost: resend once with the same key
        return `보내지 못함: ${e instanceof ApiError ? (e.body?.message ?? `서버 응답 ${e.status}`) : '네트워크 오류'}`;
      }
    }
  };

  const sendComment = async (target: { base_revision_id: string; selection: SelectionSnapshot }, body: string): Promise<string> => {
    try {
      await api('POST', `/api/papers/${paperId}/documents/${info.document.id}/comments`, { base_revision_id: target.base_revision_id, selection: target.selection, body });
      setCommentRefresh((n) => n + 1);
      return '';
    } catch (e) {
      return `코멘트를 남기지 못했습니다: ${e instanceof ApiError ? (e.body?.message ?? `서버 응답 ${e.status}`) : '네트워크 오류'}`;
    }
  };
  // the current editor selection frozen against the stored head (for attaching a comment again)
  const currentSelection = async (): Promise<{ base_revision_id: string; selection: unknown } | { error: string }> => {
    if (!editor || save.status !== 'saved' || locked) return { error: '저장된 뒤 다시 연결할 수 있습니다' };
    const t = selectionTarget(editor.state.doc, editor.state.selection.from, editor.state.selection.to);
    if (t.kind !== 'block') return { error: t.kind === 'multi' ? '한 문단 안에서 선택하세요' : '먼저 연결할 문장을 선택하세요' };
    try {
      return { base_revision_id: save.headRevisionId, selection: await freezeSelection(editor.getJSON(), t) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };

  if (contentError) return <ReadOnlyDocument content={info.head.content_json} reason={`편집기가 읽을 수 없는 내용(${contentError})`} />;
  // a mouse click on a formatting button leaves focus and selection in the text, so the next key
  // goes to the editor (not to the button, where Space would press it again); keyboard users can
  // still Tab to the buttons
  const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();
  const mark = (name: 'bold' | 'italic' | 'subscript' | 'superscript', label: string) => (
    <button type="button" aria-pressed={editor?.isActive(name) ?? false} disabled={locked} onMouseDown={keepFocus} onClick={() => editor?.chain().focus().toggleMark(name).run()}>{label}</button>
  );
  const when = offer ? new Date(offer.savedAt).toLocaleString() : '';
  return (
    <section className="card" ref={containerRef}>
      {offer && canRestore && (
        <div role="alert" className="notice" data-testid="recovery-offer">
          <p>이 브라우저에 저장되지 않은 원고 변경이 남아 있습니다({when}). 불러오면 화면에 올린 뒤 자동 저장합니다.</p>
          <button type="button" className="primary" onClick={restore}>복구본 불러오기</button>
          <button type="button" onClick={discard}>복구본 버리기</button>
        </div>
      )}
      {offer && !canRestore && (
        <div role="alert" className="notice" data-testid="recovery-offer">
          <p>이 브라우저에 남은 복구본({when})은 지금 화면의 원고와 다른 버전을 바탕으로 합니다. 자동으로 합치지 않습니다. 필요한 부분을 아래에서 복사한 뒤 버리세요.</p>
          <div className="editor readonly" data-testid="recovery-text">{renderDocument(offer.content as JSONContent)}</div>
          <button type="button" onClick={discard}>복구본 버리기</button>
        </div>
      )}
      <div className="toolbar">
        {mark('bold', '굵게')}
        {mark('italic', '기울임')}
        {mark('subscript', '아래첨자')}
        {mark('superscript', '위첨자')}
        <button type="button" disabled={locked} onMouseDown={keepFocus} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>제목</button>
        <button type="button" className="primary" onClick={saveNow} disabled={save.status === 'saving' || locked}>저장</button>
        <span role="status" data-testid="save-status" className={`save-status ${unsaved || applying ? 'unsaved' : 'saved'}`}>{applying ? '수정 제안 적용 확인 중 — 편집 잠김' : saveLabel(save)}</span>
      </div>
      {problems.length > 0 && <ul role="alert" className="error">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <SelectionChat editor={editor} documentId={info.document.id} baseRevisionId={save.headRevisionId} canRequest={save.status === 'saved' && !locked} outlineApproved={outlineApproved} onRequest={sendSelection} onComment={sendComment} />
      <div className="editor" data-testid="editor"><EditorContent editor={editor} /></div>
      {endedHere && <p role="alert" className="hint" data-testid="recovery-ended">다른 탭에서 로그아웃되어 이 화면에서는 저장되지 않은 변경을 임시 보관하지 않습니다. 새로고침하거나 다시 로그인하면 다시 켜집니다.</p>}
      {owner && storage && storageOk && !endedHere && (
        <p className="hint">
          <label className="inline">
            <input type="checkbox" checked={recoveryOn} onChange={(e) => toggleRecovery(e.target.checked)} /> 저장되지 않은 변경을 이 브라우저에 임시 보관(7일, 로그아웃하면 삭제)
          </label>
          {draftNote && <span role="alert" className="error"> {draftNote}</span>}
        </p>
      )}
      <JobStreams paperId={paperId} documentId={info.document.id} jobs={jobs} proposalRefresh={proposalTick} onProposal={() => setProposalRefresh((n) => n + 1)} />
      <ProposalPanel paperId={paperId} documentId={info.document.id} headRevisionId={save.headRevisionId} canApply={save.status === 'saved' && !locked}
        onApplying={setApplying} onApplied={adoptApplied} refreshKey={proposalRefresh} onChanged={() => setProposalTick((n) => n + 1)} />
      <ReferencesPanel paperId={paperId} editor={editor} canInsert={!locked} headRevisionId={save.headRevisionId} />
      <CommentsPanel paperId={paperId} documentId={info.document.id} editor={editor} headRevisionId={save.headRevisionId}
        screenIsHead={save.status === 'saved'} refreshKey={commentRefresh} currentSelection={currentSelection} />
      {owner && !storageOk && <p role="alert" className="hint" data-testid="recovery-unavailable">이 브라우저가 사이트 저장소를 막아 저장되지 않은 변경을 임시 보관할 수 없습니다. 저장 상태를 확인하세요.</p>}
    </section>
  );
}
