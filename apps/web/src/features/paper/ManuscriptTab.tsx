// The manuscript editor. Saving is explicit (button or Ctrl/Cmd+S) and shows 저장됨 only after the
// server stored exactly the content on screen. A failed or conflicting save leaves the text in the
// editor, marked unsaved, and leaving the page asks first.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import { EDITOR_SCHEMA_VERSION, validateDocument } from '@pw/editor-core';
import { ApiError, api, errorText } from '../../app/api.ts';
import { assignBlockIds, editorExtensions, unsupportedTypes } from './editor-extensions.ts';
import { initialSaveState, isUnsaved, saveLabel, saveReducer } from './save-state.ts';

interface Revision { id: string; content_json: JSONContent; schema_version: number }
interface DocInfo { document: { id: string; kind: string; head_revision_id: string }; head: Revision }

export function ManuscriptTab({ paperId }: { paperId: string }) {
  const [doc, setDoc] = useState<DocInfo | null | undefined>(undefined);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const docs = await api<{ id: string; kind: string }[]>('GET', `/api/papers/${paperId}/documents`);
    const m = docs.find((d) => d.kind === 'manuscript');
    setDoc(m ? await api<DocInfo>('GET', `/api/papers/${paperId}/documents/${m.id}`) : null);
  }, [paperId]);
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [load]);
  if (error) return <p role="alert" className="error">{error}</p>;
  if (doc === undefined) return <p className="loading">불러오는 중…</p>;
  if (doc === null) {
    return (
      <section className="card">
        <p>이 논문에는 아직 원고가 없습니다.</p>
        <button type="button" className="primary" onClick={() => api('POST', `/api/papers/${paperId}/documents`, { kind: 'manuscript' }).then(load).catch((e) => setError(errorText(e)))}>원고 만들기</button>
      </section>
    );
  }
  return <Editor key={doc.document.id} paperId={paperId} info={doc} />;
}

function Editor({ paperId, info }: { paperId: string; info: DocInfo }) {
  const [save, dispatch] = useReducer(saveReducer, info.head.id, initialSaveState);
  const saveRef = useRef(save);
  saveRef.current = save;
  const [problems, setProblems] = useState<string[]>([]);
  const unsupported = unsupportedTypes(info.head.content_json);
  const initial = info.head.content_json.content?.length ? info.head.content_json : undefined;
  const editor = useEditor({
    extensions: editorExtensions,
    content: initial,
    editable: unsupported.length === 0,
    onCreate: ({ editor: ed }) => {
      // give the initial blocks their ids without marking the document edited
      const tr = ed.state.tr;
      if (assignBlockIds(ed.state.doc, tr)) ed.view.dispatch(tr.setMeta('addToHistory', false).setMeta('pw-init', true));
    },
    onUpdate: ({ transaction }) => {
      if (transaction.docChanged && !transaction.getMeta('pw-init')) dispatch({ type: 'edit' });
    },
  });

  const doSave = useCallback(async () => {
    if (!editor || saveRef.current.inFlight !== null) return;
    const json = editor.getJSON();
    const checked = validateDocument(json, EDITOR_SCHEMA_VERSION);
    if (!checked.ok) {
      setProblems(checked.errors.map((e) => `${e.code}: ${e.message}`));
      return;
    }
    setProblems([]);
    const version = saveRef.current.editVersion;
    dispatch({ type: 'saveStart' });
    try {
      const rev = await api<Revision>('POST', `/api/papers/${paperId}/documents/${info.document.id}/revisions`, {
        expected_head_revision_id: saveRef.current.headRevisionId, content_json: json, schema_version: EDITOR_SCHEMA_VERSION, reason: 'manual',
      });
      dispatch({ type: 'saveOk', version, headRevisionId: rev.id });
    } catch (e) {
      const conflict = e instanceof ApiError && e.status === 409;
      dispatch({ type: 'saveFailed', version, error: e instanceof ApiError ? `서버 응답 ${e.status}` : '네트워크 오류', conflict });
    }
  }, [editor, info.document.id, paperId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void doSave();
      }
    };
    const onLeave = (e: BeforeUnloadEvent) => {
      if (isUnsaved(saveRef.current)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    addEventListener('keydown', onKey);
    addEventListener('beforeunload', onLeave);
    return () => {
      removeEventListener('keydown', onKey);
      removeEventListener('beforeunload', onLeave);
    };
  }, [doSave]);

  const unsaved = isUnsaved(save);
  const mark = (name: 'bold' | 'italic' | 'subscript' | 'superscript', label: string) => (
    <button type="button" aria-pressed={editor?.isActive(name) ?? false} onClick={() => editor?.chain().focus().toggleMark(name).run()}>{label}</button>
  );
  return (
    <section className="card">
      {unsupported.length > 0 && <p role="alert" className="error">이 원고에는 아직 편집기가 지원하지 않는 요소({unsupported.join(', ')})가 있어 읽기 전용으로 엽니다. 내용은 그대로 보존됩니다.</p>}
      <div className="toolbar">
        {mark('bold', '굵게')}
        {mark('italic', '기울임')}
        {mark('subscript', '아래첨자')}
        {mark('superscript', '위첨자')}
        <button type="button" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>제목</button>
        <button type="button" className="primary" onClick={() => void doSave()} disabled={save.status === 'saving'}>저장</button>
        <span role="status" data-testid="save-status" className={`save-status ${unsaved ? 'unsaved' : 'saved'}`}>{saveLabel(save)}</span>
      </div>
      {problems.length > 0 && <ul role="alert" className="error">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <div className="editor" data-testid="editor"><EditorContent editor={editor} /></div>
    </section>
  );
}
