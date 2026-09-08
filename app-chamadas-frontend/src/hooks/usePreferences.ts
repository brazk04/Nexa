import { useCallback, useEffect, useState } from 'react';
import type { UserPreferences } from '../../../shared/protocol';
import { api } from '../lib/api';

export const defaultPreferences: UserPreferences = {
  theme: 'system', fontScale: 100, density: 'comfortable', reduceMotion: false, accent: 'violet', sounds: true,
  messageNotifications: true, mentionNotifications: true, callNotifications: true, doNotDisturb: false,
  status: 'online', cameraId: '', microphoneId: '', speakerId: '',
};

function preferredTheme(): UserPreferences['theme'] {
  try {
    const value = localStorage.getItem('cw-theme');
    return value === 'dark' || value === 'light' || value === 'system' ? value : 'system';
  } catch { return 'system'; }
}

export function usePreferences() {
  const [preferences, setPreferences] = useState<UserPreferences>(() => ({ ...defaultPreferences, theme: preferredTheme() }));
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try { setPreferences((await api<{ preferences: UserPreferences }>('/preferences')).preferences); }
    catch { console.warn('Não foi possível carregar preferências; usando os padrões locais.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    const systemTheme = matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const dark = preferences.theme === 'dark' || (preferences.theme === 'system' && systemTheme.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', dark ? '#101116' : '#f4f5f9');
    };
    applyTheme();
    try { localStorage.setItem('cw-theme', preferences.theme); } catch { /* Persistence can be unavailable in privacy mode. */ }
    document.documentElement.dataset.density = preferences.density;
    document.documentElement.dataset.accent = preferences.accent;
    document.documentElement.style.fontSize = `${preferences.fontScale}%`;
    document.documentElement.classList.toggle('reduce-motion', preferences.reduceMotion);
    if (preferences.theme === 'system') systemTheme.addEventListener('change', applyTheme);
    return () => systemTheme.removeEventListener('change', applyTheme);
  }, [preferences]);
  const save = useCallback(async (next: UserPreferences) => {
    setPreferences(next);
    try { localStorage.setItem('cw-theme', next.theme); } catch { /* Keep server persistence as the source of truth. */ }
    const saved = (await api<{ preferences: UserPreferences }>('/preferences', { method: 'PUT', body: JSON.stringify(next) })).preferences;
    setPreferences(saved); return saved;
  }, []);
  return { preferences, setPreferences, save, loading };
}
