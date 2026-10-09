// Source documents of the paper (PW-034/035): upload a PDF original with its rights, extract its text,
// read a page, confirm a selected quote as an evidence location, and re-open a confirmed location as
// a highlight on the page. Nothing is located by guessing: the server confirms only a quote that occurs
// exactly once on that page of the extracted text.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
// the legacy build: the modern one needs very recent JavaScript built-ins (e.g. Map.getOrInsertComputed)
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { ApiError, api, apiRaw, errorText } from '../../app/api.ts';
import { ANCHOR_ERROR, EXTRACTION, FLAG, KEEP, LICENSE, SEND } from './labels.ts';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface Asset {
  id: string; sha256: string; byte_size: number; original_name: string | null; source: string; page_count: number | null; created_at: string;
  policy: { license: string; keep_right: string; external_send: string };
}
interface Page { page_index: number; view_box: number[]; rotate: number; text: string; flags: string[] }
interface Extraction { extraction: { id: string; status: string; failure_reason: string | null; page_count: number | null } | null; pages: Page[] }
interface Anchor { id: string; page_index: number; exact: string; sha256: string; quadpoints: number[][]; status: string; page: { view_box: number[]; rotate: number } }

const SCALE = 1.25;
const CONTEXT = 32;

export function SourceDocsTab({ paperId, visible }: { paperId: string; visible: boolean }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [highlight, setHighlight] = useState<Anchor | null>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [boxes, setBoxes] = useState<{ left: number; top: number; width: number; height: number }[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [form, setForm] = useState({ license: 'unknown', external_send: 'unknown' });
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLPreElement>(null);
  const asset = assets.find((a) => a.id === selected) ?? null;

  const loadAssets = useCallback(async () => {
    try { setAssets((await api<{ assets: Asset[] }>('GET', `/api/papers/${paperId}/assets`)).assets); setError(''); } catch (e) { setError(errorText(e)); }
  }, [paperId]);
  useEffect(() => { if (visible) void loadAssets(); }, [visible, loadAssets]);

  const loadSelected = useCallback(async (id: string) => {
    try {
      setExtraction(await api<Extraction>('GET', `/api/papers/${paperId}/assets/${id}/extraction`));
      setAnchors((await api<{ anchors: Anchor[] }>('GET', `/api/papers/${paperId}/assets/${id}/anchors`)).anchors);
    } catch (e) { setError(errorText(e)); }
  }, [paperId]);

  // the original's bytes (only when the basis for keeping it is known)
  useEffect(() => {
    setDoc(null);
    if (!asset || asset.policy.keep_right === 'unknown') return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/papers/${paperId}/assets/${asset.id}/content`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()), enableXfa: false }).promise;
        if (!cancelled) setDoc(d);
      } catch (e) { if (!cancelled) setError(`PDF를 열 수 없습니다: ${errorText(e)}`); }
    })();
    return () => { cancelled = true; };
  }, [paperId, asset]);

  // render the page and the highlight boxes (page space → viewport, /Rotate included)
  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let cancelled = false;
    void (async () => {
      const page = await doc.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: SCALE });
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise.catch(() => undefined);
      if (cancelled) return;
      if (highlight && highlight.page_index === pageIndex) {
        const [x0, y0, x1, y1] = highlight.page.view_box as [number, number, number, number];
        setBoxes(highlight.quadpoints.map((q) => {
          const pts = [0, 2, 4, 6].map((i) => viewport.convertToViewportPoint(x0 + q[i]! * (x1 - x0), y0 + q[i + 1]! * (y1 - y0)) as [number, number]);
          const xs = pts.map((p) => p[0]);
          const ys = pts.map((p) => p[1]);
          return { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
        }));
      } else setBoxes([]);
    })();
    return () => { cancelled = true; };
  }, [doc, pageIndex, highlight]);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    try {
      const q = new URLSearchParams({ license: form.license, external_send: form.external_send, name: file.name });
      const a = await apiRaw<Asset & { already_stored?: boolean }>(`/api/papers/${paperId}/assets?${q}`, file, 'application/pdf');
      setNote(a.already_stored ? '이미 올린 파일입니다(설정은 바뀌지 않음).' : '올렸습니다. 원본은 바뀌지 않게 보관됩니다.');
      if (fileRef.current) fileRef.current.value = '';
      await loadAssets();
    } catch (err) {
      const b = err instanceof ApiError ? (err.body as { reason?: string } | null) : null;
      setError(b?.reason ? `받지 않았습니다: ${errorText(err)}` : errorText(err));
    }
  };
  const open = async (a: Asset) => {
    setSelected(a.id);
    setPageIndex(0);
    setHighlight(null);
    setError('');
    await loadSelected(a.id);
  };
  const extract = async () => {
    if (!asset) return;
    try {
      await api('POST', `/api/papers/${paperId}/assets/${asset.id}/extract`, { idempotency_key: crypto.randomUUID() });
      setNote('텍스트 추출을 요청했습니다. 끝나면 새로 고침하세요.');
    } catch (e) { setError(errorText(e)); }
  };
  const setKeep = async (keep_right: string) => {
    if (!asset) return;
    try {
      await api('POST', `/api/papers/${paperId}/assets/${asset.id}/policy`, { keep_right });
      await loadAssets();
    } catch (e) { setError(errorText(e)); }
  };
  const confirmSelection = async () => {
    const pre = textRef.current;
    const sel = window.getSelection();
    if (!pre || !sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (r.startContainer !== pre.firstChild || r.endContainer !== pre.firstChild || r.collapsed) { setError('이 쪽의 텍스트에서 문장을 선택하세요'); return; }
    const text = pre.textContent ?? '';
    const [s, e] = [r.startOffset, r.endOffset];
    try {
      const a = await api<Anchor>('POST', `/api/papers/${paperId}/assets/${asset!.id}/anchors`, { page_index: pageIndex, exact: text.slice(s, e), prefix: text.slice(Math.max(0, s - CONTEXT), s), suffix: text.slice(e, e + CONTEXT) });
      setNote('근거 위치를 확인했습니다.');
      setError('');
      setHighlight(a);
      await loadSelected(asset!.id);
    } catch (err) {
      const reason = err instanceof ApiError ? (err.body as { reason?: string } | null)?.reason : undefined;
      setError(reason && ANCHOR_ERROR[reason] ? ANCHOR_ERROR[reason] : errorText(err));
    }
  };
  const reopen = async (id: string) => {
    try {
      const a = await api<Anchor>('GET', `/api/papers/${paperId}/anchors/${id}`);
      setPageIndex(a.page_index);
      setHighlight(a);
    } catch (e) { setError(errorText(e)); }
  };

  const page = extraction?.pages.find((p) => p.page_index === pageIndex) ?? null;
  const pageCount = extraction?.pages.length || asset?.page_count || doc?.numPages || 0;
  return (
    <section aria-label="원문">
      <h2>원문 PDF</h2>
      {error && <p role="alert" className="error">{error}</p>}
      {note && <p role="status" className="hint">{note}</p>}
      <form onSubmit={(e) => void upload(e)} className="toolbar" aria-label="원문 올리기">
        <input ref={fileRef} type="file" accept="application/pdf" aria-label="PDF 파일" />
        <label>라이선스 <select value={form.license} onChange={(e) => setForm({ ...form, license: e.target.value })}>{Object.entries(LICENSE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>외부 AI 전송 <select value={form.external_send} onChange={(e) => setForm({ ...form, external_send: e.target.value })}><option value="unknown">정하지 않음</option><option value="allowed">허용</option><option value="denied">금지</option></select></label>
        <button type="submit">올리기</button>
      </form>
      <ul className="plain" data-testid="asset-list">
        {assets.map((a) => (
          <li key={a.id} data-testid="asset" data-asset-id={a.id}>
            <strong>{a.original_name ?? 'document.pdf'}</strong> · {a.page_count ?? '?'}쪽 · {LICENSE[a.policy.license]} · {KEEP[a.policy.keep_right]} · {SEND[a.policy.external_send]}
            {' '}<span className="hint">sha256 {a.sha256.slice(0, 12)}…</span>{' '}
            <button type="button" onClick={() => void open(a)}>열기</button>
          </li>
        ))}
      </ul>
      {asset && (
        <div data-testid="viewer">
          <h3>{asset.original_name}</h3>
          {asset.policy.keep_right === 'unknown' ? (
            <p className="warn" data-testid="keep-unknown">
              이 원본을 보관하는 근거를 아직 정하지 않았습니다. 정하기 전에는 열거나 추출하지 않습니다.{' '}
              <button type="button" onClick={() => void setKeep('user_supplied')}>내가 가진 파일</button>{' '}
              <button type="button" onClick={() => void setKeep('open_license')}>공개 라이선스</button>
            </p>
          ) : (
            <p>
              <span data-testid="extraction-status">{extraction?.extraction ? EXTRACTION[extraction.extraction.status] : '텍스트 미추출'}</span>
              {extraction?.extraction?.failure_reason && <span className="hint"> ({extraction.extraction.failure_reason})</span>}
              {' '}{!extraction?.extraction && <button type="button" onClick={() => void extract()}>텍스트 추출</button>}
              {' '}<button type="button" onClick={() => void loadSelected(asset.id)}>새로 고침</button>
            </p>
          )}
          {pageCount > 0 && (
            <p className="toolbar">
              <button type="button" disabled={pageIndex <= 0} onClick={() => { setPageIndex(pageIndex - 1); }}>이전 쪽</button>
              <span data-testid="page-number">{pageIndex + 1} / {pageCount}쪽</span>
              <button type="button" disabled={pageIndex >= pageCount - 1} onClick={() => { setPageIndex(pageIndex + 1); }}>다음 쪽</button>
            </p>
          )}
          {page?.flags.map((f) => <p key={f} className="warn" data-testid="page-flag">{FLAG[f] ?? f}</p>)}
          <div className="pdf-view" style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
            <div style={{ position: 'relative' }} data-testid="page-canvas-wrap">
              <canvas ref={canvasRef} data-testid="page-canvas" />
              {boxes.map((b, i) => (
                <div key={i} data-testid="anchor-box" style={{ position: 'absolute', left: b.left, top: b.top, width: b.width, height: b.height, background: 'rgba(255, 210, 0, 0.35)', outline: '2px solid #c90', pointerEvents: 'none' }} />
              ))}
            </div>
            {page && (
              <div style={{ maxWidth: '28rem' }}>
                <p className="hint">추출된 텍스트(이 쪽). 근거로 쓸 문장을 선택하고 확인하세요.</p>
                <pre ref={textRef} data-testid="page-text" style={{ whiteSpace: 'pre-wrap' }}>{page.text}</pre>
                <button type="button" onClick={() => void confirmSelection()} disabled={extraction?.extraction?.status !== 'ok'}>선택을 근거 위치로 확인</button>
              </div>
            )}
          </div>
          <h4>확인한 근거 위치</h4>
          <ul className="plain" data-testid="anchor-list">
            {anchors.map((a) => (
              <li key={a.id} data-testid="anchor" data-status={a.status}>
                {a.page_index + 1}쪽 · “{a.exact}” · sha256 {a.sha256.slice(0, 12)}… {a.status === 'stale' && <span className="warn">(원문과 맞지 않음)</span>}
                {' '}<button type="button" onClick={() => void reopen(a.id)}>다시 열기</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
