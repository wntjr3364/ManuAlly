// Word (.docx) import (PW-055, spec 10 "가져오기"). The file is sent as it is and kept unchanged (it can be
// downloaded again); the page shows the converted preview and every loss before anything changes. With
// unresolved tracked changes the owner chooses which text to take. Applying makes a new manuscript, or a
// new version of the current one after confirmation (the current text stays an earlier version). The page
// never says the conversion is a round trip.
import { useState } from 'react';
import type { JSONContent } from '@tiptap/core';
import { api, ApiError, errorText } from '../../app/api.ts';
import { renderDocument } from '../../editor/ReadOnlyDocument.tsx';

interface Loss { kind: string; count: number; examples: string[]; note: string }
interface DocxView {
  id: string; filename: string | null; byte_size: number; source_sha256: string; preview: JSONContent;
  report: { blocks: number; characters: number; losses: Loss[]; tracked_changes: { insertions: number; deletions: number; choice: 'accept' | 'reject' | null }; round_trip: string };
}
interface Doc { document: { id: string }; head: { id: string } }
type Pending = { insertions: number; deletions: number };

export function DocxImport({ paperId, doc, canChange, act }: { paperId: string; doc: Doc | null; canChange: boolean; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [choice, setChoice] = useState<'accept' | 'reject'>('accept');
  const [preview, setPreview] = useState<DocxView | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const send = async (f: { name: string; base64: string }, tracked?: 'accept' | 'reject') => {
    setBusy(true);
    setError('');
    try {
      setPreview(await api<DocxView>('POST', `/api/papers/${paperId}/imports`, { format: 'docx', filename: f.name, content_base64: f.base64, ...(tracked ? { tracked_changes: tracked } : {}) }));
      setPending(null);
      setConfirm(false);
    } catch (e) {
      const b = e instanceof ApiError ? (e.body as Record<string, unknown> | null) : null;
      if (b?.reason === 'TRACKED_CHANGES_CHOICE') setPending({ insertions: Number(b.insertions), deletions: Number(b.deletions) });
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const next = { name: f.name, base64: btoa(bin) };
    setFile(next);
    setPreview(null);
    setPending(null);
    await send(next);
  };
  const apply = async () => {
    if (!preview) return;
    const body = doc ? { mode: 'replace_manuscript', document_id: doc.document.id, expected_head_revision_id: doc.head.id, confirm_replace: confirm } : { mode: 'new_manuscript' };
    if (await act(() => api('POST', `/api/papers/${paperId}/imports/${preview.id}/apply`, body))) { setPreview(null); setFile(null); }
  };

  return (
    <section className="card" data-testid="docx-import">
      <h2>Word(.docx) 가져오기</h2>
      <p className="hint">파일은 받은 그대로 보관되며 언제든 다시 내려받을 수 있습니다. 변환 미리 보기와 손실 보고를 확인한 뒤에만 원고에 반영됩니다. 이 변환은 왕복 변환이 아닙니다 — 다시 Word로 내보내도 원래 파일과 같지 않습니다.</p>
      <label className="inline">Word 파일 <input type="file" aria-label="가져올 Word 파일" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => void pick(e.target.files?.[0])} /></label>
      {busy && <p className="loading">변환 중…</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {pending && file && (
        <div data-testid="docx-tracked-choice" role="group" aria-label="변경 내용 추적 선택">
          <p>이 문서에는 아직 수락·거부하지 않은 변경 내용 추적이 있습니다(삽입 {pending.insertions}곳, 삭제 {pending.deletions}곳). 어느 글을 가져올지 고르세요. 변경 기록 자체는 옮겨지지 않습니다.</p>
          <label className="inline"><input type="radio" name="tracked" checked={choice === 'accept'} onChange={() => setChoice('accept')} /> 변경을 수락한 글</label>
          <label className="inline"><input type="radio" name="tracked" checked={choice === 'reject'} onChange={() => setChoice('reject')} /> 변경 전 원문(변경 거부)</label>
          <button type="button" disabled={busy} onClick={() => void send(file, choice)}>이 글로 미리 보기</button>
        </div>
      )}
      {preview && (
        <div data-testid="docx-preview">
          <p className="hint">{preview.filename ?? 'Word 파일'} · {preview.report.blocks}개 블록 · {preview.report.characters}자
            {preview.report.tracked_changes.choice && ` · 변경 내용: ${preview.report.tracked_changes.choice === 'accept' ? '수락한 글' : '변경 전 원문'}`}
            {' · '}<a href={`/api/papers/${paperId}/imports/${preview.id}/original`} data-testid="docx-original">원본 파일 내려받기</a></p>
          <p className="warn" data-testid="docx-round-trip">왕복 변환 아님: 원고로 가져온 뒤 Word로 내보내도 댓글·변경 기록·인용 필드·수식 구조는 돌아오지 않습니다. 원본은 위 링크로 보관됩니다.</p>
          {preview.report.losses.length > 0 ? (
            <ul className="error" data-testid="docx-losses">
              {preview.report.losses.map((l) => <li key={l.kind} data-kind={l.kind}>{l.note} ({l.count}곳{l.examples.length ? `: ${l.examples.join(' / ')}` : ''})</li>)}
            </ul>
          ) : <p className="hint" data-testid="docx-losses">옮기지 못한 요소가 없습니다.</p>}
          <div className="editor readonly">{renderDocument(preview.preview)}</div>
          {doc ? (
            <>
              <label className="inline"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> 현재 원고를 이 내용으로 바꿉니다(지금 원고는 이전 버전으로 남고 다시 복원할 수 있습니다)</label>
              <button type="button" className="primary" disabled={!confirm || !canChange} onClick={() => void apply()}>원고를 Word 내용으로 바꾸기</button>
            </>
          ) : <button type="button" className="primary" disabled={!canChange} onClick={() => void apply()}>Word 내용으로 새 원고 만들기</button>}
        </div>
      )}
    </section>
  );
}
