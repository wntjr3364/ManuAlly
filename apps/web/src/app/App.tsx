import { useEffect, useState } from 'react';
import { api, setCsrf } from './api.ts';
import { Login, type Owner } from './Login.tsx';
import { navigate, usePath } from './router.ts';
import { PapersPage } from '../features/paper/PapersPage.tsx';
import { PaperPage } from '../features/paper/PaperPage.tsx';

export function App() {
  const [owner, setOwner] = useState<Owner | null | undefined>(undefined);
  const path = usePath();
  useEffect(() => {
    api<{ owner: Owner; csrfToken: string }>('GET', '/api/auth/session')
      .then((s) => { setCsrf(s.csrfToken); setOwner(s.owner); })
      .catch(() => setOwner(null));
  }, []);
  if (owner === undefined) return <p className="loading">불러오는 중…</p>;
  if (owner === null) return <Login onLogin={setOwner} />;
  const logout = async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    setOwner(null);
    navigate('/');
  };
  const m = /^\/papers\/([0-9a-f-]{36})$/.exec(path);
  return (
    <div className="app">
      <header className="topbar">
        <a href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>Paper Workspace</a>
        <span className="who">{owner.username} <button type="button" className="link" onClick={logout}>로그아웃</button></span>
      </header>
      {m ? <PaperPage paperId={m[1]!} /> : <PapersPage />}
    </div>
  );
}
