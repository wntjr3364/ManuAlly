// Exports of the manuscript (PW-056): Word (.docx) and CSL-JSON, made from the current saved version and
// kept as made. Each shows the export check: "검사 통과" only when nothing is wrong; an export whose citations
// are not all linked to stored references is a draft (the file says so too).
// PW-057: the reading PDF (the same Word file converted by LibreOffice on the server's computer) and the
// source archive of a named snapshot — for sharing (only originals whose licence allows it; the rest are
// listed as left out) or as the owner's own copy (every original). An archive with an original missing from
// the store says "불완전" and names it; it is never shown as passed.
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../../app/api.ts';

interface Issue { kind: string; severity: 'error' | 'warning'; count: number; examples: string[]; note: string }
interface LeftOut { sha256: string; original_name: string | null; license: string; reason: string }
interface ExportRow {
  id: string; format: 'docx' | 'csl_json' | 'pdf' | 'source_archive'; status: 'clean' | 'needs_attention' | 'draft_with_errors' | 'incomplete';
  revision_id: string | null; snapshot_id: string | null; purpose: 'share' | 'private' | null; style: string; sha256: string; byte_size: number; created_at: string;
  report: {
    issues?: Issue[];
    pdf?: { converter: { version: string }; text_check: { status: 'passed' | 'failed' | 'not_run' } };
    snapshot?: { label: string }; excluded?: LeftOut[]; missing?: LeftOut[]; verification?: { ok: boolean; reproduced: boolean | null };
  };
}
interface Snapshot { id: string; label: string; created_at: string }
const STATUS: Record<ExportRow['status'], string> = { clean: '검사 통과', needs_attention: '확인 필요(경고)', draft_with_errors: '초안 — 고칠 문제 있음(제출용 아님)', incomplete: '불완전 — 빠진 원본 있음' };
const FORMAT: Record<ExportRow['format'], string> = { docx: 'Word', csl_json: 'CSL-JSON(문헌)', pdf: 'PDF(읽기용)', source_archive: '원본 묶음' };
const PURPOSE = { share: '공유용', private: '내 보관용' };
const REASON: Record<string, string> = { licence_does_not_allow_sharing: '라이선스상 공유 불가', licence_unknown: '라이선스 미확인', licence_conflict: '같은 파일에 서로 다른 라이선스 결정', missing_in_store: '저장소에 없음', damaged_in_store: '저장소에서 손상됨', hash_mismatch: '해시 불일치' };
const TEXT_CHECK = { passed: '본문 확인됨', failed: '일부 제목 없음', not_run: '본문 확인 안 함(pdftotext 없음)' };
const when = (t: string) => new Date(t).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' });
const name = (x: LeftOut) => x.original_name ?? `${x.sha256.slice(0, 12)}…`;

export function ExportPanel({ paperId, documentId, canChange, snapshotsChanged = 0 }: { paperId: string; documentId: string; canChange: boolean; snapshotsChanged?: number }) {
  const [rows, setRows] = useState<ExportRow[] | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotId, setSnapshotId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setRows(await api<ExportRow[]>('GET', `/api/papers/${paperId}/exports`));
      const s = await api<Snapshot[]>('GET', `/api/papers/${paperId}/snapshots`);
      setSnapshots(s);
      setSnapshotId((cur) => (cur && s.some((x) => x.id === cur) ? cur : (s[0]?.id ?? '')));
    } catch (e) { setError(errorText(e)); }
  }, [paperId]);
  useEffect(() => { void load(); }, [load, snapshotsChanged]);
  const make = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try { await api('POST', `/api/papers/${paperId}/exports`, body); } catch (e) { setError(errorText(e)); } finally { setBusy(false); await load(); }
  };
  return (
    <section className="card" data-testid="exports">
      <h2>내보내기</h2>
      <p className="hint">지금 저장된 원고 버전으로 만듭니다. 인용 번호·참고문헌·그림 번호는 화면과 같은 규칙으로 저장된 문헌과 그림 순서에서만 계산됩니다. Word의 학술지별 인용 양식(CSL)은 아직 적용하지 않습니다 — CSL-JSON을 문헌 관리기(Zotero 등)에 넣어 바꿀 수 있습니다. PDF는 읽기용이며 서버 컴퓨터의 LibreOffice로 Word 파일을 변환합니다(배치가 Word와 다를 수 있습니다).</p>
      <div className="toolbar">
        <button type="button" disabled={busy || !canChange} onClick={() => void make({ document_id: documentId, format: 'docx' })}>Word로 내보내기</button>
        <button type="button" disabled={busy || !canChange} onClick={() => void make({ document_id: documentId, format: 'pdf' })}>PDF로 내보내기</button>
        <button type="button" disabled={busy || !canChange} onClick={() => void make({ document_id: documentId, format: 'csl_json' })}>문헌 CSL-JSON 내보내기</button>
      </div>
      <h3>원본 묶음(재현용)</h3>
      <p className="hint">이름 붙인 스냅샷의 원고(편집기 JSON)·스토리·아웃라인·문헌(CSL-JSON, BibTeX)·그림·글쓰기 프로필·AI 도움 기록과 그 스냅샷으로 다시 만든 Word 파일을 SHA-256 목록과 함께 묶습니다. 묶음 안의 manifest만으로 파일과 출력물을 검증할 수 있습니다. 공유용에는 라이선스가 공유를 허락하는 원본(자기 작업, CC0, 퍼블릭 도메인, CC BY, CC BY-SA)만 넣고, 나머지는 해시와 이유만 적습니다.</p>
      {snapshots.length === 0 ? <p className="hint" data-testid="archive-needs-snapshot">원본 묶음을 만들려면 먼저 스냅샷 탭에서 스냅샷을 만드세요.</p> : (
        <div className="toolbar">
          <label style={{ margin: 0 }}>스냅샷
            <select value={snapshotId} onChange={(e) => setSnapshotId(e.target.value)} data-testid="archive-snapshot">
              {snapshots.map((s) => <option key={s.id} value={s.id}>{s.label} ({when(s.created_at)})</option>)}
            </select>
          </label>
          <button type="button" disabled={busy || !canChange || !snapshotId} onClick={() => void make({ format: 'source_archive', snapshot_id: snapshotId, purpose: 'share' })}>공유용 원본 묶음</button>
          <button type="button" disabled={busy || !canChange || !snapshotId} onClick={() => void make({ format: 'source_archive', snapshot_id: snapshotId, purpose: 'private' })}>내 보관용 원본 묶음</button>
        </div>
      )}
      {busy && <p className="hint" role="status">만드는 중…</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {rows && rows.length === 0 && <p className="hint">아직 내보낸 파일이 없습니다.</p>}
      <ul className="exports">
        {rows?.map((r) => (
          <li key={r.id} data-testid="export" data-status={r.status} data-format={r.format} data-purpose={r.purpose ?? undefined}>
            <strong>{FORMAT[r.format]}{r.purpose ? ` (${PURPOSE[r.purpose]})` : ''}</strong> · {when(r.created_at)} · <span data-testid="export-status" className={r.status === 'clean' ? '' : 'warn'}>{STATUS[r.status]}</span>
            {' · '}<a href={`/api/papers/${paperId}/exports/${r.id}/file`} data-testid="export-file">내려받기</a>
            <span className="hint">
              {r.report.snapshot ? ` · 스냅샷 「${r.report.snapshot.label}」` : r.revision_id ? ` · 버전 ${r.revision_id.slice(0, 8)}` : ''} · SHA-256 {r.sha256.slice(0, 12)}…
              {r.report.pdf && ` · LibreOffice ${r.report.pdf.converter.version} · ${TEXT_CHECK[r.report.pdf.text_check.status]}`}
              {r.report.verification && ` · ${r.report.verification.ok ? '묶음 자체 검증 통과' : '묶음 자체 검증 실패'}${r.report.verification.reproduced ? ' · Word 출력 재현됨' : ''}`}
            </span>
            {(r.report.missing ?? []).length > 0 && (
              <ul className="error" data-testid="export-missing">
                {r.report.missing!.map((x) => <li key={x.sha256}>빠진 원본: {name(x)} — {REASON[x.reason] ?? x.reason}</li>)}
              </ul>
            )}
            {(r.report.excluded ?? []).length > 0 && (
              <ul className="hint" data-testid="export-excluded">
                {r.report.excluded!.map((x) => <li key={x.sha256}>넣지 않은 원본: {name(x)} ({x.license}) — {REASON[x.reason] ?? x.reason}</li>)}
              </ul>
            )}
            {(r.report.issues ?? []).length > 0 && (
              <ul className={r.status === 'draft_with_errors' ? 'error' : 'warn'} data-testid="export-issues">
                {r.report.issues!.map((i) => <li key={i.kind} data-kind={i.kind}>{i.note} ({i.count}곳{i.examples.length ? `: ${i.examples.join(', ')}` : ''})</li>)}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
