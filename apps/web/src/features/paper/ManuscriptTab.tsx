// The manuscript tab: loads (or creates) the paper's manuscript and opens it in the editor
// (apps/web/src/editor, PW-015: autosave, local recovery, IME safety). A stored document the editor
// cannot represent (e.g. a table) is shown read-only from the stored JSON and can never be saved over.
import { useCallback, useEffect, useState } from 'react';
import { EDITOR_SCHEMA_VERSION } from '@pw/editor-core';
import { api, errorText } from '../../app/api.ts';
import { unsupportedTypes } from './editor-extensions.ts';
import { ManuscriptEditor, type DocInfo, type EditorState } from '../../editor/ManuscriptEditor.tsx';
import { ReadOnlyDocument } from '../../editor/ReadOnlyDocument.tsx';

// reloadKey: bumped after the versions tab made a new head (restore, undo, import); the editor then
// opens that head
export function ManuscriptTab({ paperId, outlineApproved = false, reloadKey = 0, onState }: { paperId: string; outlineApproved?: boolean; reloadKey?: number; onState?: (s: EditorState | null) => void }) {
  const [doc, setDoc] = useState<DocInfo | null | undefined>(undefined);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const docs = await api<{ id: string; kind: string }[]>('GET', `/api/papers/${paperId}/documents`);
    const m = docs.find((d) => d.kind === 'manuscript');
    setDoc(m ? await api<DocInfo>('GET', `/api/papers/${paperId}/documents/${m.id}`) : null);
  }, [paperId]);
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [load, reloadKey]);
  // no editable manuscript on screen: nothing unsaved here
  const editable = !!doc && doc.head.schema_version === EDITOR_SCHEMA_VERSION && !unsupportedTypes(doc.head.content_json).length;
  useEffect(() => { if (!editable) onState?.(null); }, [editable, onState]);
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
  if (doc.head.schema_version !== EDITOR_SCHEMA_VERSION) return <ReadOnlyDocument content={doc.head.content_json} reason={`다른 문서 형식 버전(${doc.head.schema_version}; 현재 ${EDITOR_SCHEMA_VERSION}) — 변환(migration)이 필요한 내용`} />;
  const unsupported = unsupportedTypes(doc.head.content_json);
  if (unsupported.length) return <ReadOnlyDocument content={doc.head.content_json} reason={`편집기가 아직 지원하지 않는 요소(${unsupported.join(', ')})`} />;
  return <ManuscriptEditor key={`${doc.document.id}:${doc.head.id}`} paperId={paperId} info={doc} outlineApproved={outlineApproved} onState={onState} />;
}
