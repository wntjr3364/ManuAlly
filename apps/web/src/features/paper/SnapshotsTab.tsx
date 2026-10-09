// Named snapshots pin the exact revisions of the manuscript, story and outline at that moment.
import { useEffect, useState } from 'react';
import { api, errorText } from '../../app/api.ts';

interface Snapshot { id: string; label: string; created_at: string; story_revision_id: string | null; outline_revision_id: string | null }

export function SnapshotsTab({ paperId }: { paperId: string }) {
  const [list, setList] = useState<Snapshot[]>([]);
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const load = () => api<Snapshot[]>('GET', `/api/papers/${paperId}/snapshots`).then(setList).catch((e) => setError(errorText(e)));
  useEffect(() => { void load(); }, [paperId]);
  async function create() {
    setError('');
    try {
      await api('POST', `/api/papers/${paperId}/snapshots`, { label });
      setLabel('');
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <section className="card">
      <h2>이름 붙인 스냅샷</h2>
      <div className="toolbar">
        <label style={{ flex: 1, margin: 0 }}>스냅샷 이름<input value={label} onChange={(e) => setLabel(e.target.value)} /></label>
        <button type="button" className="primary" onClick={create}>스냅샷 만들기</button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      <ul className="plain">
        {list.map((s) => (
          <li key={s.id}>
            <strong>{s.label}</strong>
            <span className="hint">{new Date(s.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</span>
            <span className="hint" data-testid="snapshot-pins">story {s.story_revision_id ? s.story_revision_id.slice(0, 8) : '없음'} · outline {s.outline_revision_id ? s.outline_revision_id.slice(0, 8) : '없음'}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
