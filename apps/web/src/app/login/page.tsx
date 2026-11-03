'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { endpoints, session } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await endpoints.login(username, password);
      session.set(res.accessToken, res.user);
      router.replace('/');
    } catch (err) {
      setError((err as Error).message || 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <span className="logo">◈</span>
          <div>
            <strong>Unified Intelligent Infrastructure</strong>
            <span className="muted small">Connect Everything. Understand Anything. Automate Intelligence.</span>
          </div>
        </div>
        <label>
          Username
          <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted small">Sovereign deployment — all data stays on-premises.</p>
      </form>
    </div>
  );
}
