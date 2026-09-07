import { API_URL } from '../lib/api';

export function Avatar({ name, small = false, url }: { name: string; small?: boolean; url?: string | null }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map(word => word.charAt(0)).join('').toUpperCase();
  return <span className={`avatar ${small ? 'avatar-small' : ''}`} aria-hidden="true">
    {url ? <img src={`${API_URL}${url}`} alt="" /> : initials}
  </span>;
}
