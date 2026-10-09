import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../../app/api.ts';
import type { Paper } from './PapersPage.tsx';
import { StoryOutlineTab } from './StoryOutlineTab.tsx';
import { EvidenceTab } from './EvidenceTab.tsx';
import { ManuscriptTab } from './ManuscriptTab.tsx';
import { SnapshotsTab } from './SnapshotsTab.tsx';

const TABS = [['plan', '구상·개요'], ['sources', '자료'], ['manuscript', '원고'], ['versions', '버전']] as const;
type Tab = (typeof TABS)[number][0];

export function PaperPage({ paperId }: { paperId: string }) {
  const [paper, setPaper] = useState<Paper | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('plan');
  const reload = useCallback(() => api<Paper>('GET', `/api/papers/${paperId}`).then(setPaper).catch((e) => setError(errorText(e))), [paperId]);
  useEffect(() => { void reload(); }, [reload]);
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!paper) return <p className="loading">불러오는 중…</p>;
  return (
    <main>
      <h1>{paper.working_title}</h1>
      <div role="tablist" aria-label="논문 영역">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'plan' && <StoryOutlineTab paper={paper} onChange={reload} />}
      {tab === 'sources' && <EvidenceTab paperId={paper.id} />}
      {tab === 'manuscript' && <ManuscriptTab paperId={paper.id} />}
      {tab === 'versions' && <SnapshotsTab paperId={paper.id} />}
    </main>
  );
}
