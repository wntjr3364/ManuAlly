// Versions of the manuscript (PW-021): history, comparison of any two revisions, restore, undo of an
// applied AI edit, and text/Markdown import. Every change of the head is a new revision made by the
// server against the head this tab shows (expected head); nothing is deleted. Head changes are offered
// only while the manuscript editor has nothing unsaved; afterwards the editor opens the new head.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSONContent } from '@tiptap/core';
import { api, errorText } from '../../app/api.ts';
import { renderDocument } from '../../editor/ReadOnlyDocument.tsx';
import type { EditorState } from '../../editor/ManuscriptEditor.tsx';
import { SnapshotsTab } from '../paper/SnapshotsTab.tsx';
import { DocxImport } from '../import/DocxImport.tsx';
import { ExportPanel } from '../exports/ExportPanel.tsx';
import { MockBadge } from '../chat/JobStream.tsx';
import { blockTokens, diffTokens, type DiffPart } from '../diff/diff.ts';
import { compareDocuments, type BlockChange } from './compare.ts';

interface Rev { id: string; reason: string; created_at: string; restored_from_revision_id: string | null; content_json?: JSONContent }
interface Doc { document: { id: string }; head: Rev & { content_json: JSONContent } }
interface AppliedEdit {
  proposal_id: string; intent: string; origin: string; explanation: string | null; applied_at: string;
  undo_revision_id: string | null; can_undo: boolean; before_block: JSONContent | null; after_block: JSONContent | null;
}
interface Loss { kind: string; count: number; examples: string[]; note: string }
interface ImportView { id: string; format: string; filename: string | null; byte_size: number; preview: JSONContent; report: { blocks: number; characters: number; losses: Loss[] }; applied: unknown }

const REASON: Record<string, string> = { initial: '처음', manual: '저장', autosave: '자동 저장', restore: '복원', import: '가져오기', ai_apply: 'AI 제안 적용', undo: 'AI 수정 되돌리기' };
const INTENT: Record<string, string> = { grammar: '문법', concise: '간결화', rewrite: '학술적 재작성' };
const when = (t: string) => new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
const short = (id: string) => id.slice(0, 8);

function Diff({ parts }: { parts: DiffPart[] }) {
  return <>{parts.map((x, i) => (x.kind === 'same' ? <span key={i}>{x.text}</span> : x.kind === 'del' ? <del key={i}>{x.text}</del> : <ins key={i}>{x.text}</ins>))}</>;
}
const CHANGE: Record<BlockChange['kind'], string> = { same: '같음', changed: '바뀜', moved: '위치 이동', added: '추가', removed: '삭제' };

export function VersionsTab({ paperId, visible, editor, onHeadChanged }: { paperId: string; visible: boolean; editor: EditorState | null; onHeadChanged: () => void }) {
  const [doc, setDoc] = useState<Doc | null | undefined>(undefined);
  const [revs, setRevs] = useState<Rev[]>([]);
  const [edits, setEdits] = useState<AppliedEdit[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [older, setOlder] = useState('');
  const [newer, setNewer] = useState('');
  const [diff, setDiff] = useState<BlockChange[] | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const lastHead = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const docs = await api<{ id: string; kind: string }[]>('GET', `/api/papers/${paperId}/documents`);
      const m = docs.find((d) => d.kind === 'manuscript');
      if (!m) { setDoc(null); setRevs([]); setEdits([]); return; }
      const d = await api<Doc>('GET', `/api/papers/${paperId}/documents/${m.id}`);
      const list = await api<Rev[]>('GET', `/api/papers/${paperId}/documents/${m.id}/revisions`);
      setEdits(await api<AppliedEdit[]>('GET', `/api/papers/${paperId}/documents/${m.id}/applied-edits`));
      setDoc(d);
      setRevs(list);
      setOlder((o) => (list.some((r) => r.id === o) ? o : list[1]?.id ?? list[0]?.id ?? ''));
      // "이후 버전" follows the head while it showed the head
      const prevHead = lastHead.current; // the updater below runs later
      setNewer((n) => (n && n !== prevHead && list.some((r) => r.id === n) ? n : d.head.id));
      lastHead.current = d.head.id;
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, [paperId]);
  useEffect(() => { if (visible) void load(); }, [visible, load, editor?.headRevisionId]);

  // the editor (if open) must show exactly the stored head this tab works from
  const blockedReason = doc && editor && editor.documentId === doc.document.id && (!editor.clean || editor.headRevisionId !== doc.head.id)
    ? (editor.clean ? '원고가 방금 바뀌었습니다 — 다시 불러오는 중' : '원고 탭에 저장되지 않은 변경이 있습니다 — 저장된 뒤 버전을 바꿀 수 있습니다')
    : '';
  const canChange = !!doc && !busy && !blockedReason;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setError('');
      setDiff(null);
      onHeadChanged();
      await load();
      return true;
    } catch (e) {
      setError(errorText(e));
      await load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const compare = async () => {
    if (!doc || !older || !newer) return;
    try {
      const get = (id: string) => api<Rev>('GET', `/api/papers/${paperId}/documents/${doc.document.id}/revisions/${id}`);
      const [a, b] = await Promise.all([get(older), get(newer)]);
      setDiff(compareDocuments(a.content_json, b.content_json));
    } catch (e) {
      setError(errorText(e));
    }
  };
  const label = (r: Rev) => `${when(r.created_at)} · ${REASON[r.reason] ?? r.reason}${doc && r.id === doc.head.id ? ' (현재)' : ''}`;

  return (
    <>
      <section className="card" data-testid="versions">
        <h2>원고 버전</h2>
        {error && <p role="alert" className="error">{error}</p>}
        {blockedReason && <p role="status" className="hint" data-testid="versions-blocked">{blockedReason}</p>}
        {doc === null && <p className="hint">아직 원고가 없습니다. 아래에서 가져오거나 원고 탭에서 만드세요.</p>}
        {doc && (
          <>
            <div className="toolbar">
              <label className="inline">이전 버전 <select aria-label="이전 버전" value={older} onChange={(e) => setOlder(e.target.value)}>{revs.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}</select></label>
              <label className="inline">이후 버전 <select aria-label="이후 버전" value={newer} onChange={(e) => setNewer(e.target.value)}>{revs.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}</select></label>
              <button type="button" onClick={() => void compare()} disabled={!older || !newer}>비교</button>
            </div>
            {diff && (
              <div data-testid="version-diff">
                {diff.every((c) => c.kind === 'same') && <p className="hint">두 버전의 내용이 같습니다.</p>}
                {diff.filter((c) => c.kind !== 'same').map((c) => (
                  <p key={`${c.kind}:${c.id}`} className={`diff change-${c.kind}`} data-change={c.kind}>
                    <span className="hint">[{CHANGE[c.kind]}{c.kind === 'moved' && c.changed ? '·바뀜' : ''}]</span>{' '}
                    {(c.kind === 'changed' || c.kind === 'moved') && c.parts ? <Diff parts={c.parts} /> : c.kind === 'removed' ? <del>{c.text}</del> : c.kind === 'added' ? <ins>{c.text}</ins> : c.text}
                  </p>
                ))}
              </div>
            )}
            <ul className="plain" data-testid="revision-list">
              {revs.map((r) => (
                <li key={r.id} data-testid="revision" data-reason={r.reason}>
                  <span>{label(r)}</span>
                  <span className="hint">{short(r.id)}{r.restored_from_revision_id ? ` · ${short(r.restored_from_revision_id)}에서 복원` : ''}</span>
                  {r.id !== doc.head.id && confirmRestore !== r.id && <button type="button" disabled={!canChange} onClick={() => setConfirmRestore(r.id)}>이 버전으로 복원</button>}
                  {confirmRestore === r.id && (
                    <span role="group" aria-label="복원 확인">
                      <span className="hint">이 버전을 새 현재 버전으로 만듭니다. 지금 원고도 기록에 남아 다시 복원할 수 있습니다. </span>
                      <button type="button" className="primary" disabled={!canChange} onClick={() => void act(() => api('POST', `/api/papers/${paperId}/documents/${doc.document.id}/restore`, { revision_id: r.id, expected_head_revision_id: doc.head.id })).then(() => setConfirmRestore(null))}>복원 확인</button>
                      <button type="button" onClick={() => setConfirmRestore(null)}>취소</button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {doc && (
        <section className="card" data-testid="applied-edits">
          <h2>적용된 AI 수정</h2>
          {edits.length === 0 && <p className="hint">적용된 AI 수정이 없습니다.</p>}
          {edits.map((e) => (
            <article key={e.proposal_id} className="proposal" data-testid="applied-edit">
              <p className="hint">{INTENT[e.intent] ?? e.intent} · {when(e.applied_at)} 적용 <MockBadge label={/^worker:(provider\.mock|tool-gateway:mock)$/.test(e.origin) ? 'MOCK' : null} /></p>
              {e.before_block && e.after_block && <p className="diff"><Diff parts={diffTokens(blockTokens(e.before_block), blockTokens(e.after_block))} /></p>}
              {e.undo_revision_id ? <p className="hint" data-testid="undo-state">되돌림 — 새 버전 {short(e.undo_revision_id)}</p>
                : e.can_undo ? <button type="button" disabled={!canChange} onClick={() => void act(() => api('POST', `/api/papers/${paperId}/proposals/${e.proposal_id}/undo`, { expected_head_revision_id: doc.head.id }))}>되돌리기</button>
                : <p className="hint" data-testid="undo-state">적용 뒤 이 문단이 바뀌어 자동으로 되돌릴 수 없습니다 — 위에서 버전을 비교해 복원하거나 직접 고치세요.</p>}
            </article>
          ))}
        </section>
      )}

      {doc !== undefined && <ImportPanel paperId={paperId} doc={doc} canChange={!busy && !blockedReason} act={act} />}
      {/* PW-056: exports of the saved manuscript (Word, CSL-JSON) with their check */}
      {doc && <ExportPanel paperId={paperId} documentId={doc.document.id} canChange={!busy} />}
      {/* PW-055: Word import (preview, losses, tracked-change choice, original kept) */}
      {doc !== undefined && <DocxImport paperId={paperId} doc={doc} canChange={!busy && !blockedReason} act={act} />}
      <SnapshotsTab paperId={paperId} visible={visible} />
    </>
  );
}

function ImportPanel({ paperId, doc, canChange, act }: { paperId: string; doc: Doc | null; canChange: boolean; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const [format, setFormat] = useState<'text' | 'markdown'>('markdown');
  const [filename, setFilename] = useState<string | null>(null);
  const [text, setText] = useState('');
  // the chosen file's bytes (base64), sent as received; cleared when the text is edited by hand
  const [bytes, setBytes] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportView | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setFilename(f.name);
    setFormat(/\.(md|markdown)$/i.test(f.name) ? 'markdown' : 'text');
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    setBytes(btoa(bin));
    setText(new TextDecoder().decode(buf)); // shown only; the server decodes the bytes strictly
    setPreview(null);
  };
  const makePreview = async () => {
    try {
      setPreview(await api<ImportView>('POST', `/api/papers/${paperId}/imports`, bytes ? { format, filename, content_base64: bytes } : { format, filename, text }));
      setConfirm(false);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  };
  const apply = async () => {
    if (!preview) return;
    const body = doc
      ? { mode: 'replace_manuscript', document_id: doc.document.id, expected_head_revision_id: doc.head.id, confirm_replace: confirm }
      : { mode: 'new_manuscript' };
    if (await act(() => api('POST', `/api/papers/${paperId}/imports/${preview.id}/apply`, body))) { setPreview(null); setText(''); setBytes(null); setFilename(null); }
  };
  return (
    <section className="card" data-testid="import">
      <h2>텍스트·Markdown 가져오기</h2>
      <p className="hint">가져온 파일은 원본 그대로 보관되고, 미리 보기와 손실 보고를 확인한 뒤에만 원고에 반영됩니다. 현재 원고는 자동으로 바뀌지 않습니다.</p>
      <div className="toolbar">
        <label className="inline">파일 <input type="file" aria-label="가져올 파일" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={(e) => void pick(e.target.files?.[0])} /></label>
        <label className="inline">형식 <select aria-label="형식" value={format} onChange={(e) => setFormat(e.target.value as 'text' | 'markdown')}><option value="markdown">Markdown</option><option value="text">텍스트</option></select></label>
      </div>
      <label>내용(붙여넣기 가능)<textarea aria-label="가져올 내용" rows={6} value={text} onChange={(e) => { setText(e.target.value); setBytes(null); setPreview(null); }} /></label>
      <button type="button" onClick={() => void makePreview()} disabled={!text.trim()}>미리 보기</button>
      {error && <p role="alert" className="error">{error}</p>}
      {preview && (
        <div data-testid="import-preview">
          <p className="hint">{preview.filename ?? '붙여넣은 내용'} · {preview.report.blocks}개 문단 · {preview.report.characters}자</p>
          {preview.report.losses.length > 0 ? (
            <ul className="error" data-testid="import-losses">
              {preview.report.losses.map((l) => <li key={l.kind}>{l.note} ({l.count}곳: {l.examples.join(', ')})</li>)}
            </ul>
          ) : <p className="hint" data-testid="import-losses">옮기지 못한 요소가 없습니다.</p>}
          <div className="editor readonly">{renderDocument(preview.preview)}</div>
          {doc ? (
            <>
              <label className="inline"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> 현재 원고를 이 내용으로 바꿉니다(지금 원고는 이전 버전으로 남고 다시 복원할 수 있습니다)</label>
              <button type="button" className="primary" disabled={!confirm || !canChange} onClick={() => void apply()}>원고를 가져온 내용으로 바꾸기</button>
            </>
          ) : <button type="button" className="primary" disabled={!canChange} onClick={() => void apply()}>새 원고로 만들기</button>}
        </div>
      )}
    </section>
  );
}
