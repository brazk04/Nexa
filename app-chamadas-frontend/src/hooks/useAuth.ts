import { useCallback, useEffect, useState } from 'react';
import type { AuthUser } from '../../../shared/protocol';
import { api } from '../lib/api';

export interface RegisterInput { username: string; birthDate: string; email: string; password: string }

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      // Verification links are handled once by AuthScreen. Keeping the
      // session bootstrap read-only prevents the one-time token from being
      // consumed twice when the app and the verification screen mount.
        setUser((await api<{ user: AuthUser }>('/auth/me')).user);
    }
    catch { setUser(null); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);
  const login = useCallback(async (username: string, password: string) => {
    const result = await api<{ user: AuthUser; sessionToken?: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    if (result.sessionToken) localStorage.setItem('nexa-session-token', result.sessionToken);
    setUser(result.user);
  }, []);
  const register = useCallback((input: RegisterInput) => api<{ emailSent: boolean; message: string }>('/auth/register', { method: 'POST', body: JSON.stringify(input) }), []);
  const verify = useCallback(async (token: string) => {
    const result = await api<{ user: AuthUser; sessionToken?: string }>('/auth/verify', { method: 'POST', body: JSON.stringify({ token }) });
    if (result.sessionToken) localStorage.setItem('nexa-session-token', result.sessionToken);
    setUser(result.user);
    window.history.replaceState({}, '', window.location.pathname);
  }, []);
  const resend = useCallback((username: string, password: string) => api<{ message: string }>('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ username, password }) }), []);
  const logout = useCallback(async () => { await api<void>('/auth/logout', { method: 'POST' }); localStorage.removeItem('nexa-session-token'); setUser(null); }, []);
  return { user, loading, login, register, verify, resend, logout, updateUser: setUser };
}
