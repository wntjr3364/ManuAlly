// The manuscript editor. Saving is explicit (button, or Ctrl/Cmd+S inside the editor) and shows
// 저장됨 only after the server stored exactly the content on screen. A failed or conflicting save
// leaves the text in the editor, marked unsaved; leaving the paper or the page asks first.
// A stored document the editor cannot represent (e.g. a table) is shown read-only from the stored
// JSON and can never be saved over.
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import { EDITOR_SCHEMA_VERSION, validateDocument } from '@pw/editor-core';
import { ApiError, api, errorText } from '../../app/api.ts';
import { setUnsaved } from '../../app/unsaved.ts';
import { editorExtensions, unsupportedTypes } from './editor-extensions.ts';
import { reconcileBlockIds } from './block-ids.ts';
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
  if (doc.head.schema_version !== EDITOR_SCHEMA_VERSION) return <ReadOnly info={doc} reason={`다른 문서 형식 버전(${doc.head.schema_version}; 현재 ${EDITOR_SCHEMA_VERSION}) — 변환(migration)이 필요한 내용`} />;
  const unsupported = unsupportedTypes(doc.head.content_json);
  if (unsupported.length) return <ReadOnly info={doc} reason={`편집기가 아직 지원하지 않는 요소(${unsupported.join(', ')})`} />;
  return <Editor key={doc.document.id} paperId={paperId} info={doc} />;
}

// Plain rendering of stored JSON (text only, no HTML): nothing is lost and nothing can be saved.
function ReadOnly({ info, reason }: { info: DocInfo; reason: string }) {
  const render = (n: JSONContent, key: number): ReactNode => {
    const kids = (n.content ?? []).map(render);
    switch (n.type) {
      case 'text': return n.text;
      case 'heading': return <h3 key={key}>{kids}</h3>;
      case 'paragraph': return <p key={key}>{kids}</p>;
      case 'table': return <table key={key}><tbody>{kids}</tbody></table>;
      case 'table_row': return <tr key={key}>{kids}</tr>;
      case 'table_cell': return <td key={key}>{kids}</td>;
      case 'citation': return <span key={key} className="atom">[인용]</span>;
      case 'math_inline': return <span key={key} className="atom">⟨{String(n.attrs?.latex ?? '')}⟩</span>;
      case 'figure_ref': return <span key={key} className="atom">[그림/표]</span>;
      default: return <span key={key}>{kids}</span>;
    }
  };
  return (
    <section className="card">
      <p role="alert" className="error">이 원고에는 {reason}가 있어 읽기 전용으로 엽니다. 저장된 내용은 그대로 보존되며 이 화면에서는 저장할 수 없습니다.</p>
      <div className="editor readonly" data-testid="editor">{(info.head.content_json.content ?? []).map(render)}</div>
    </section>
  );
}

function Editor({ paperId, info }: { paperId: string; info: DocInfo }) {
  const [save, dispatch] = useReducer(saveReducer, info.head.id, initialSaveState);
  const saveRef = useRef(save);
  saveRef.current = save;
  // counts edits synchronously (the reducer state only updates on render)
  const versionRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [contentError, setContentError] = useState('');
  const initial = info.head.content_json.content?.length ? info.head.content_json : undefined;
  const editor = useEditor({
    extensions: editorExtensions,
    content: initial,
    enableContentCheck: true,
    onContentError: ({ error }) => setContentError(error.message),
    onCreate: ({ editor: ed }) => {
      // give blocks without ids their ids without marking the document edited
      const fix = reconcileBlockIds(ed.state.doc, ed.state, []);
      if (fix) ed.view.dispatch(fix.setMeta('pw-init', true));
    },
    onUpdate: ({ transaction }) => {
      if (transaction.docChanged && !transaction.getMeta('pw-init')) {
        versionRef.current += 1;
        dispatch({ type: 'edit' });
      }
    },
  });

  const unsaved = isUnsaved(save);
  useEffect(() => { setUnsaved(`manuscript:${info.document.id}`, unsaved ? '원고' : null); }, [unsaved, info.document.id]);
  useEffect(() => () => setUnsaved(`manuscript:${info.document.id}`, null), [info.document.id]);

  const doSave = useCallback(async () => {
    if (!editor || contentError || saveRef.current.inFlight !== null) return;
    const json = editor.getJSON();
    const checked = validateDocument(json, EDITOR_SCHEMA_VERSION);
    if (!checked.ok) {
      setProblems(checked.errors.map((e) => `${e.code}: ${e.message}`));
      return;
    }
    setProblems([]);
    const version = versionRef.current;
    saveRef.current = { ...saveRef.current, inFlight: version };
    dispatch({ type: 'saveStart', version });
    try {
      const rev = await api<Revision>('POST', `/api/papers/${paperId}/documents/${info.document.id}/revisions`, {
        expected_head_revision_id: saveRef.current.headRevisionId, content_json: json, schema_version: EDITOR_SCHEMA_VERSION, reason: 'manual',
      });
      dispatch({ type: 'saveOk', version, headRevisionId: rev.id });
    } catch (e) {
      const conflict = e instanceof ApiError && e.status === 409;
      dispatch({ type: 'saveFailed', version, error: e instanceof ApiError ? `서버 응답 ${e.status}` : '네트워크 오류', conflict });
    }
  }, [editor, contentError, info.document.id, paperId]);

  // Ctrl/Cmd+S only while focus is in this editor area (spec 04: shortcuts work inside the editor)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && containerRef.current?.contains(document.activeElement)) {
        e.preventDefault();
        void doSave();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [doSave]);

  if (contentError) return <ReadOnly info={info} reason={`편집기가 읽을 수 없는 내용(${contentError})`} />;
  const mark = (name: 'bold' | 'italic' | 'subscript' | 'superscript', label: string) => (
    <button type="button" aria-pressed={editor?.isActive(name) ?? false} onClick={() => editor?.chain().focus().toggleMark(name).run()}>{label}</button>
  );
  return (
    <section className="card" ref={containerRef}>
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
