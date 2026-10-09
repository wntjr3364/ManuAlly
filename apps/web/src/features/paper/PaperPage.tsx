import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../../app/api.ts';
import type { Paper } from './PapersPage.tsx';
import { StoryOutlineTab } from './StoryOutlineTab.tsx';
import { EvidenceTab } from './EvidenceTab.tsx';
import { ManuscriptTab } from './ManuscriptTab.tsx';
import { VersionsTab } from '../versions/VersionsTab.tsx';
import type { EditorState } from '../../editor/ManuscriptEditor.tsx';

const TABS = [['plan', '구상·개요'], ['sources', '자료'], ['manuscript', '원고'], ['versions', '버전']] as const;
type Tab = (typeof TABS)[number][0];

export function PaperPage({ paperId }: { paperId: string }) {
  const [paper, setPaper] = useState<Paper | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('plan');
  // tabs stay mounted once opened: switching tabs never discards unsaved work
  const [opened, setOpened] = useState<Set<Tab>>(() => new Set(['plan']));
  const open = (t: Tab) => { setTab(t); setOpened((o) => (o.has(t) ? o : new Set([...o, t]))); };
  // AI rewrite needs what the draft gate needs: an approved outline built on the active approved story
  const [outlineApproved, setOutlineApproved] = useState(false);
  const reload = useCallback(async () => {
    try {
      const p = await api<Paper>('GET', `/api/papers/${paperId}`);
      const o = await api<{ active: { status: string; story_revision_id: string } | null }>('GET', `/api/papers/${paperId}/outline`);
      setOutlineApproved(!!o.active && o.active.status === 'APPROVED' && o.active.story_revision_id === p.active_story_revision_id);
      setPaper(p);
    } catch (e) {
      setError(errorText(e));
    }
  }, [paperId]);
  useEffect(() => { void reload(); }, [reload]);
  // the manuscript editor's state (if open), and a counter that makes it open a new head
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [manuscriptReload, setManuscriptReload] = useState(0);
  const headChanged = useCallback(() => setManuscriptReload((n) => n + 1), []);
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!paper) return <p className="loading">불러오는 중…</p>;
  return (
    <main>
      <h1>{paper.working_title}</h1>
      <div role="tablist" aria-label="논문 영역">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => open(id)}>{label}</button>
        ))}
      </div>
      <div role="tabpanel" hidden={tab !== 'plan'}>{opened.has('plan') && <StoryOutlineTab paper={paper} onChange={reload} visible={tab === 'plan'} />}</div>
      <div role="tabpanel" hidden={tab !== 'sources'}>{opened.has('sources') && <EvidenceTab paperId={paper.id} visible={tab === 'sources'} />}</div>
      <div role="tabpanel" hidden={tab !== 'manuscript'}>{opened.has('manuscript') && <ManuscriptTab paperId={paper.id} outlineApproved={outlineApproved} reloadKey={manuscriptReload} onState={setEditorState} />}</div>
      <div role="tabpanel" hidden={tab !== 'versions'}>{opened.has('versions') && <VersionsTab paperId={paper.id} visible={tab === 'versions'} editor={opened.has('manuscript') ? editorState : null} onHeadChanged={headChanged} />}</div>
    </main>
  );
}
