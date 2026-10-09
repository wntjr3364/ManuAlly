import { useState, type FormEvent } from 'react';
import { api, errorText, setCsrf } from './api.ts';

export interface Owner { id: string; username: string }

export function Login({ onLogin }: { onLogin: (o: Owner) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'setup'>('login');
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      if (mode === 'setup') await api('POST', '/api/setup', { username, password });
      const r = await api<{ owner: Owner; csrfToken: string }>('POST', '/api/auth/login', { username, password });
      setCsrf(r.csrfToken);
      onLogin(r.owner);
    } catch (err) {
      setError(errorText(err));
    }
  }
  return (
    <main className="login">
      <h1>Paper Workspace</h1>
      <form onSubmit={submit}>
        <label>사용자 이름<input name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>비밀번호<input name="password" type="password" autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <button type="submit">{mode === 'setup' ? '계정 만들고 로그인' : '로그인'}</button>
        {error && <p role="alert" className="error">{error}</p>}
      </form>
      <p className="hint">
        {mode === 'login'
          ? <button type="button" className="link" onClick={() => setMode('setup')}>처음 사용: 계정 만들기 (이 컴퓨터에서만)</button>
          : <button type="button" className="link" onClick={() => setMode('login')}>로그인으로 돌아가기</button>}
      </p>
    </main>
  );
}
