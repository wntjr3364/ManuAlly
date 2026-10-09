// Importing references (PW-038): a CSL-JSON, BibTeX, RIS file or a DOI list, pasted or chosen as a file,
// and a read-only read of a Zotero library. Each entry's outcome is shown as the server decided it; a DOI
// the library does not know is not looked up or filled in. The Zotero part says what it cannot do.
import { useEffect, useState, type FormEvent } from 'react';
import { api, errorText } from '../../app/api.ts';

type Format = 'csl-json' | 'bibtex' | 'ris' | 'doi-list';
const FORMAT_LABEL: Record<Format, string> = { 'csl-json': 'CSL-JSON', bibtex: 'BibTeX', ris: 'RIS', 'doi-list': 'DOI 목록(한 줄에 하나)' };
const STATUS_LABEL: Record<string, string> = {
  created: '새로 추가',
  linked_existing: '서재의 같은 문헌과 연결',
  kept_library_metadata: '서재에 다른 정보로 있음 — 서재 정보를 유지',
  already_in_paper: '이미 이 논문에 있음',
  invalid: '가져오지 않음',
  unknown_doi: '가져오지 않음(서재에 없는 DOI, 정보 없음)',
};
const REASON_LABEL: Record<string, string> = { duplicate_key_in_file: '파일 안에서 같은 키가 반복됨', no_title: '제목 없음' };
interface Result { key: string; status: string; reference_id: string | null; title: string | null; warnings: string[]; reason?: string }
interface Capabilities { read: boolean; write: boolean; sync: string; note: string }

function guessFormat(name: string): Format | null {
  const n = name.toLowerCase();
  if (n.endsWith('.bib')) return 'bibtex';
  if (n.endsWith('.ris')) return 'ris';
  if (n.endsWith('.json')) return 'csl-json';
  if (n.endsWith('.txt')) return 'doi-list';
  return null;
}

export function ImportReferences({ paperId, onImported }: { paperId: string; onImported: () => void }) {
  const [format, setFormat] = useState<Format>('bibtex');
  const [text, setText] = useState('');
  const [results, setResults] = useState<{ source: string; items: Result[]; total?: number | null } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [zot, setZot] = useState({ library_type: 'user', library_id: '', api_key: '' });

  useEffect(() => {
    api<{ capabilities: Capabilities }>('GET', `/api/papers/${paperId}/references/zotero`).then((r) => setCaps(r.capabilities), () => setCaps(null));
  }, [paperId]);

  const run = async (fn: () => Promise<{ source: string; results: Result[]; zotero_total?: number | null }>) => {
    setBusy(true); setError('');
    try {
      const r = await fn();
      setResults({ source: r.source, items: r.results, total: r.zotero_total });
      onImported();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const submitFile = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api('POST', `/api/papers/${paperId}/references/import`, { format, text }));
  };
  const submitZotero = (e: FormEvent) => {
    e.preventDefault();
    const body = { library_type: zot.library_type, library_id: zot.library_id.trim(), ...(zot.api_key.trim() ? { api_key: zot.api_key.trim() } : {}) };
    // the key is used for this one request; it is not kept here or on the server
    void run(() => api('POST', `/api/papers/${paperId}/references/zotero/import`, body)).then(() => setZot((z) => ({ ...z, api_key: '' })));
  };
  const counts = results ? results.items.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {}) : {};

  return (
    <div data-testid="reference-import">
      <h3>문헌 가져오기</h3>
      <form onSubmit={submitFile} aria-label="참고문헌 파일에서 가져오기">
        <div className="toolbar">
          <label className="inline">파일 형식
            <select aria-label="참고문헌 파일 형식" value={format} onChange={(e) => setFormat(e.target.value as Format)}>
              {(Object.keys(FORMAT_LABEL) as Format[]).map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
            </select>
          </label>
          <label className="inline">참고문헌 파일
            <input type="file" aria-label="참고문헌 파일" accept=".bib,.ris,.json,.txt" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const g = guessFormat(f.name);
              if (g) setFormat(g);
              setText(await f.text());
            }} />
          </label>
        </div>
        <textarea aria-label="참고문헌 붙여넣기" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="@article{key, title = {…}, …}" />
        <button type="submit" disabled={busy || !text.trim()}>가져오기</button>
      </form>
      {caps && (
        <details data-testid="zotero">
          <summary>Zotero에서 읽기(읽기 전용)</summary>
          <p data-testid="zotero-capabilities">{caps.note}</p>
          <ul className="plain">
            <li>읽기: {caps.read ? '가능' : '불가'}</li>
            <li>Zotero에 쓰기: {caps.write ? '가능' : '하지 않음'}</li>
            <li>동기화: {caps.sync === 'none' ? '없음' : caps.sync}</li>
          </ul>
          <form onSubmit={submitZotero} className="toolbar" aria-label="Zotero에서 가져오기">
            <select aria-label="Zotero 라이브러리 종류" value={zot.library_type} onChange={(e) => setZot({ ...zot, library_type: e.target.value })}>
              <option value="user">개인</option><option value="group">그룹</option>
            </select>
            <input aria-label="Zotero 라이브러리 번호" inputMode="numeric" value={zot.library_id} onChange={(e) => setZot({ ...zot, library_id: e.target.value })} />
            <input aria-label="Zotero API 키(선택, 저장하지 않음)" type="password" autoComplete="off" value={zot.api_key} onChange={(e) => setZot({ ...zot, api_key: e.target.value })} />
            <button type="submit" disabled={busy || !zot.library_id.trim()}>Zotero에서 가져오기</button>
          </form>
        </details>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {results && (
        <div role="status" data-testid="import-results">
          <p>
            {results.source === 'zotero' ? 'Zotero에서 읽음' : '파일에서 읽음'} · {results.items.length}개 항목
            {results.total != null && results.total > results.items.length ? ` (Zotero 전체 ${results.total}개 중 앞부분)` : ''}
            {' — '}{Object.entries(counts).map(([s, n]) => `${STATUS_LABEL[s] ?? s} ${n}`).join(', ')}
          </p>
          <ul className="plain">
            {results.items.map((r, i) => (
              <li key={`${r.key}-${i}`} data-testid="import-item" data-status={r.status}>
                <strong>{STATUS_LABEL[r.status] ?? r.status}</strong>: {r.title ?? r.key}
                {r.reason && <> — {REASON_LABEL[r.reason] ?? r.reason}</>}
                {r.warnings.length > 0 && <> (주의: {r.warnings.join(', ')})</>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
