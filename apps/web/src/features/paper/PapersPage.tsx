import { useEffect, useState, type FormEvent } from 'react';
import { api, errorText } from '../../app/api.ts';
import { navigate } from '../../app/router.ts';

export interface Paper { id: string; working_title: string; status: string; updated_at: string; active_story_revision_id: string | null; active_outline_revision_id: string | null }

export function PapersPage() {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const load = () => api<Paper[]>('GET', '/api/papers').then(setPapers).catch((e) => setError(errorText(e)));
  useEffect(() => { void load(); }, []);
  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    const submitted = title;
    try {
      await api('POST', '/api/papers', { working_title: submitted, article_type: 'research_article' });
      // clear only what was sent: a title typed while the request was running is kept
      setTitle((t) => (t === submitted ? '' : t));
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  }
  return (
    <main>
      <h1>내 논문</h1>
      <section className="card">
        <form onSubmit={create} className="toolbar">
          <label style={{ flex: 1, margin: 0 }}>새 논문 제목<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <button type="submit" className="primary">새 논문</button>
        </form>
        {error && <p role="alert" className="error">{error}</p>}
      </section>
      <section className="card">
        <ul className="plain">
          {papers.map((p) => (
            <li key={p.id}>
              <a href={`/papers/${p.id}`} onClick={(e) => { e.preventDefault(); navigate(`/papers/${p.id}`); }}>{p.working_title}</a>
              <span className="hint">스토리 {p.active_story_revision_id ? '승인됨' : '미승인'} · 개요 {p.active_outline_revision_id ? '승인됨' : '미승인'}</span>
            </li>
          ))}
          {papers.length === 0 && <li className="hint">아직 논문이 없습니다.</li>}
        </ul>
      </section>
    </main>
  );
}
