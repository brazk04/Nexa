import { useState } from 'react';
import { API_URL } from '../lib/api';

export function Avatar({ name, small = false, url }: { name: string; small?: boolean; url?: string | null }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map(word => word.charAt(0)).join('').toUpperCase();
  const source = url ? (/^(?:https?:|data:)/u.test(url) ? url : `${API_URL}${url}`) : null;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return <span className={`avatar ${small ? 'avatar-small' : ''}`} aria-hidden="true">
    {source && source !== failedSource
      ? <img src={source} alt="" decoding="async" onError={() => setFailedSource(source)} />
      : initials}
  </span>;
}
