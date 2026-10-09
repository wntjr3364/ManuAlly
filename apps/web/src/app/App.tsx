import { useEffect, useState } from 'react';
import { api, setCsrf } from './api.ts';
import { Login, type Owner } from './Login.tsx';
import { navigate, usePath } from './router.ts';
import { confirmLeave } from './unsaved.ts';
import { announceLogout, browserStorage, clearAllRecoveryData, clearOtherAccounts, endRecoveryForPage, isLogoutEvent, resumeRecoveryForPage, setRecoveryOwner } from '../editor/recovery.ts';
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
  // the editor keeps its browser recovery copies under the signed-in account
  setRecoveryOwner(owner?.id ?? null);
  // a logout in another tab of this browser: this page keeps no recovery copies until it signs in or
  // is loaded again (also when no editor is open right now)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (isLogoutEvent(e)) endRecoveryForPage(); };
    addEventListener('storage', onStorage);
    return () => removeEventListener('storage', onStorage);
  }, []);
  // signing in leaves nothing of another account on this device (spec 04 shared device)
  useEffect(() => {
    const storage = browserStorage();
    if (owner && storage) clearOtherAccounts(storage, owner.id);
  }, [owner]);
  if (owner === undefined) return <p className="loading">불러오는 중…</p>;
  if (owner === null) return <Login onLogin={(o) => { resumeRecoveryForPage(); setOwner(o); }} />;
  const logout = async () => {
    if (!confirmLeave()) return;
    await api('POST', '/api/auth/logout').catch(() => {});
    // leave no manuscript text behind on a shared device (spec 04)
    const storage = browserStorage();
    if (storage) {
      clearAllRecoveryData(storage);
      announceLogout(storage); // other open tabs stop keeping copies
    }
    setOwner(null);
    navigate('/');
  };
  const m = /^\/papers\/([0-9a-f-]{36})$/.exec(path);
  return (
    <div className="app">
      <header className="topbar">
        <a href="/" onClick={(e) => { e.preventDefault(); if (confirmLeave()) navigate('/'); }}>Paper Workspace</a>
        <span className="who">{owner.username} <button type="button" className="link" onClick={logout}>로그아웃</button></span>
      </header>
      {m ? <PaperPage paperId={m[1]!} /> : <PapersPage />}
    </div>
  );
}
