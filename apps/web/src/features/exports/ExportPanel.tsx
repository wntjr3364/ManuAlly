// Exports of the manuscript (PW-056): Word (.docx) and CSL-JSON, made from the current saved version and
// kept as made. Each shows the export check: "검사 통과" only when nothing is wrong; an export whose citations
// are not all linked to stored references is a draft (the file says so too).
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../../app/api.ts';

interface Issue { kind: string; severity: 'error' | 'warning'; count: number; examples: string[]; note: string }
interface ExportRow { id: string; format: 'docx' | 'csl_json'; status: 'clean' | 'needs_attention' | 'draft_with_errors'; revision_id: string; style: string; sha256: string; byte_size: number; created_at: string; report: { issues?: Issue[] } }
const STATUS: Record<ExportRow['status'], string> = { clean: '검사 통과', needs_attention: '확인 필요(경고)', draft_with_errors: '초안 — 고칠 문제 있음(제출용 아님)' };
const FORMAT: Record<ExportRow['format'], string> = { docx: 'Word', csl_json: 'CSL-JSON(문헌)' };
const when = (t: string) => new Date(t).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });

export function ExportPanel({ paperId, documentId, canChange }: { paperId: string; documentId: string; canChange: boolean }) {
  const [rows, setRows] = useState<ExportRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setRows(await api<ExportRow[]>('GET', `/api/papers/${paperId}/exports`)); } catch (e) { setError(errorText(e)); }
  }, [paperId]);
  useEffect(() => { void load(); }, [load]);
  const make = async (format: ExportRow['format']) => {
    setBusy(true);
    setError('');
    try { await api('POST', `/api/papers/${paperId}/exports`, { document_id: documentId, format }); } catch (e) { setError(errorText(e)); } finally { setBusy(false); await load(); }
  };
  return (
    <section className="card" data-testid="exports">
      <h2>내보내기</h2>
      <p className="hint">지금 저장된 원고 버전으로 만듭니다. 인용 번호·참고문헌·그림 번호는 화면과 같은 규칙으로 저장된 문헌과 그림 순서에서만 계산됩니다. Word의 학술지별 인용 양식(CSL)은 아직 적용하지 않습니다 — CSL-JSON을 문헌 관리기(Zotero 등)에 넣어 바꿀 수 있습니다.</p>
      <div className="toolbar">
        <button type="button" disabled={busy || !canChange} onClick={() => void make('docx')}>Word로 내보내기</button>
        <button type="button" disabled={busy || !canChange} onClick={() => void make('csl_json')}>문헌 CSL-JSON 내보내기</button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {rows && rows.length === 0 && <p className="hint">아직 내보낸 파일이 없습니다.</p>}
      <ul className="exports">
        {rows?.map((r) => (
          <li key={r.id} data-testid="export" data-status={r.status} data-format={r.format}>
            <strong>{FORMAT[r.format]}</strong> · {when(r.created_at)} · <span data-testid="export-status" className={r.status === 'clean' ? '' : 'warn'}>{STATUS[r.status]}</span>
            {' · '}<a href={`/api/papers/${paperId}/exports/${r.id}/file`} data-testid="export-file">내려받기</a>
            <span className="hint"> · 버전 {r.revision_id.slice(0, 8)} · SHA-256 {r.sha256.slice(0, 12)}…</span>
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
