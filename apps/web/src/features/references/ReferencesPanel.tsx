// References, figures/tables and citation style of the paper (PW-019). References are entered as
// structured fields only (no free bibliography text); citations and cross-references are inserted as
// atoms that keep the stable id. Labels and the bibliography are computed (editor-core).
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Editor } from '@tiptap/core';
import { bibliography, type CitationStyle, type FigureMeta, type RefMeta } from '@pw/editor-core';
import { ApiError, api, errorText } from '../../app/api.ts';
import { labelsFor, setReferenceContext } from './reference-labels.ts';

const STYLE_LABEL: Record<CitationStyle, string> = { numeric: '번호 [1]', author_year: '저자-연도 (Kim 2020)' };

export function ReferencesPanel({ paperId, editor, canInsert, headRevisionId }: { paperId: string; editor: Editor | null; canInsert: boolean; headRevisionId?: string }) {
  const [refs, setRefs] = useState<RefMeta[]>([]);
  const [figures, setFigures] = useState<FigureMeta[]>([]);
  const [style, setStyle] = useState<CitationStyle>('numeric');
  const [error, setError] = useState('');
  const [form, setForm] = useState({ title: '', authors: '', year: '', container: '', doi: '' });
  const [figTitle, setFigTitle] = useState('');
  const [figKind, setFigKind] = useState<'figure' | 'table'>('figure');
  const [locator, setLocator] = useState('');
  // a DOI the library already has, with other details: the owner adds the library's work or corrects the entry
  const [known, setKnown] = useState<{ body: Record<string, unknown>; library: { title: string; year: number | null; authors: { family: string }[] } } | null>(null);
  const [, setTick] = useState(0); // re-render the bibliography preview when the document changes

  const load = useCallback(async () => {
    try {
      const [r, f, s] = await Promise.all([
        api<RefMeta[]>('GET', `/api/papers/${paperId}/references`),
        api<FigureMeta[]>('GET', `/api/papers/${paperId}/figures`),
        api<{ style: CitationStyle }>('GET', `/api/papers/${paperId}/citation-style`),
      ]);
      setRefs(r); setFigures(f); setStyle(s.style); setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, [paperId]);
  // another tab may change references, figure order or style: reload on each stored head and on focus
  useEffect(() => { void load(); }, [load, headRevisionId]);
  useEffect(() => {
    const onFocus = () => void load();
    addEventListener('focus', onFocus);
    return () => removeEventListener('focus', onFocus);
  }, [load]);
  useEffect(() => { if (editor) setReferenceContext(editor.view, { refs, figures, style }); }, [editor, refs, figures, style]);
  useEffect(() => {
    if (!editor) return;
    const bump = () => setTick((n) => n + 1);
    editor.on('update', bump);
    return () => { editor.off('update', bump); };
  }, [editor]);

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); await load(); } catch (e) { setError(errorText(e)); }
  };
  const addReference = (e: FormEvent) => {
    e.preventDefault();
    const authors = form.authors.split(';').map((a) => a.trim()).filter(Boolean).map((a) => {
      const [family, given] = a.split(',').map((x) => x.trim());
      return given ? { family: family!, given } : { family: family! };
    });
    const body = { title: form.title, authors, year: form.year ? Number(form.year) : null, container: form.container || null, doi: form.doi || null };
    void act(async () => {
      try {
        await api('POST', `/api/papers/${paperId}/references`, body);
      } catch (err) {
        const b = err instanceof ApiError ? (err.body as { reason?: string; library?: { title: string; year: number | null; authors: { family: string }[] } } | null) : null;
        if (b?.reason === 'doi_known_with_other_metadata' && b.library) { setKnown({ body, library: b.library }); return; }
        throw err;
      }
      setKnown(null);
      setForm({ title: '', authors: '', year: '', container: '', doi: '' });
    });
  };
  const addKnown = () => known && void act(async () => {
    await api('POST', `/api/papers/${paperId}/references`, { ...known.body, use_library_metadata: true });
    setKnown(null);
    setForm({ title: '', authors: '', year: '', container: '', doi: '' });
  });
  const insertCitation = (id: string) => editor?.chain().focus().insertContent({ type: 'citation', attrs: { referenceId: id, locator: locator.trim() || null } }).run();
  const insertFigure = (id: string) => editor?.chain().focus().insertContent({ type: 'figure_ref', attrs: { targetId: id } }).run();
  const move = (f: FigureMeta, dir: -1 | 1) => {
    const same = figures.filter((x) => x.kind === f.kind).sort((a, b) => a.position - b.position);
    const i = same.findIndex((x) => x.id === f.id);
    const j = i + dir;
    if (j < 0 || j >= same.length) return;
    [same[i], same[j]] = [same[j]!, same[i]!];
    void act(() => api('POST', `/api/papers/${paperId}/figures/order`, { kind: f.kind, ids: same.map((x) => x.id) }));
  };

  const info = editor ? labelsFor(editor.state.doc, { refs, figures, style }) : null;
  const bib = editor && info ? bibliography(info.cites, refs, style) : [];
  const numbers = info?.f.numbers;
  return (
    <section className="card" aria-label="인용과 그림/표" data-testid="references">
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>인용과 그림/표</h2>
        <button type="button" onClick={() => void load()}>새로고침</button>
        <label className="inline">인용 형식
          <select aria-label="인용 형식" value={style} onChange={(e) => void act(() => api('POST', `/api/papers/${paperId}/citation-style`, { style: e.target.value }))}>
            {(Object.keys(STYLE_LABEL) as CitationStyle[]).map((s) => <option key={s} value={s}>{STYLE_LABEL[s]}</option>)}
          </select>
        </label>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {info && (info.c.unresolved.length > 0 || info.f.unresolved.length > 0) && (
        <p role="alert" className="error" data-testid="unresolved">
          이 논문에 없는 인용 {info.c.unresolved.length}개, 없는 그림/표 참조 {info.f.unresolved.length}개 — 번호와 참고문헌에서 빠집니다. 확인이 필요합니다.
        </p>
      )}
      <h3>문헌</h3>
      <label className="inline">쪽/위치(선택) <input aria-label="인용 위치" value={locator} onChange={(e) => setLocator(e.target.value)} placeholder="p. 4" /></label>
      <ul className="plain" data-testid="reference-list">
        {refs.map((r) => (
          <li key={r.id}>
            {r.authors.map((a) => a.family).join(', ') || '저자 없음'} ({r.year ?? 'n.d.'}). {r.title}
            {' '}<button type="button" disabled={!canInsert} onMouseDown={(e) => e.preventDefault()} onClick={() => insertCitation(r.id)}>인용 넣기</button>
          </li>
        ))}
      </ul>
      <form onSubmit={addReference} className="toolbar" aria-label="문헌 추가">
        <input aria-label="제목" placeholder="제목" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <input aria-label="저자" placeholder="성, 이름; 성, 이름" value={form.authors} onChange={(e) => setForm({ ...form, authors: e.target.value })} />
        <input aria-label="연도" placeholder="연도" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} size={6} />
        <input aria-label="학술지" placeholder="학술지" value={form.container} onChange={(e) => setForm({ ...form, container: e.target.value })} />
        <input aria-label="DOI" placeholder="10.xxxx/…" value={form.doi} onChange={(e) => setForm({ ...form, doi: e.target.value })} />
        <button type="submit">문헌 추가</button>
      </form>
      {known && (
        <div role="alert" className="warn" data-testid="known-doi">
          이 DOI는 서재에 다른 정보로 있습니다: {known.library.authors.map((a) => a.family).join(', ') || '저자 없음'} ({known.library.year ?? 'n.d.'}). {known.library.title}
          {' — '}입력한 정보로 서재를 바꾸지 않습니다(다른 논문도 이 정보를 씁니다).{' '}
          <button type="button" onClick={addKnown}>서재 정보로 추가</button>{' '}
          <button type="button" onClick={() => setKnown(null)}>취소</button>
        </div>
      )}
      <h3>그림·표</h3>
      <ul className="plain" data-testid="figure-list">
        {figures.slice().sort((a, b) => (a.kind === b.kind ? a.position - b.position : a.kind < b.kind ? -1 : 1)).map((f) => (
          <li key={f.id} data-figure-id={f.id}>
            {f.kind === 'figure' ? 'Figure' : 'Table'} {numbers?.get(f.id)}: {f.title}
            {' '}<button type="button" aria-label={`${f.title} 위로`} onClick={() => move(f, -1)}>▲</button>
            <button type="button" aria-label={`${f.title} 아래로`} onClick={() => move(f, 1)}>▼</button>
            <button type="button" disabled={!canInsert} onMouseDown={(e) => e.preventDefault()} onClick={() => insertFigure(f.id)}>참조 넣기</button>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => { e.preventDefault(); void act(async () => { await api('POST', `/api/papers/${paperId}/figures`, { kind: figKind, title: figTitle }); setFigTitle(''); }); }} className="toolbar" aria-label="그림·표 추가">
        <select aria-label="종류" value={figKind} onChange={(e) => setFigKind(e.target.value as 'figure' | 'table')}><option value="figure">그림</option><option value="table">표</option></select>
        <input aria-label="그림·표 제목" value={figTitle} onChange={(e) => setFigTitle(e.target.value)} />
        <button type="submit">그림·표 추가</button>
      </form>
      <h3>참고문헌(미리보기)</h3>
      <ol className="plain" data-testid="bibliography">{bib.map((b) => <li key={b.id}>{b.label} {b.text}</li>)}</ol>
    </section>
  );
}
