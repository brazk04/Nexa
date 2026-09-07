const configuredUrl = import.meta.env.VITE_API_URL || import.meta.env.VITE_SOCKET_URL;
export const API_URL = configuredUrl || `${window.location.protocol}//${window.location.hostname}:3333`;

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code; }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const jsonBody = init.body && !(init.body instanceof FormData);
  const sessionToken = localStorage.getItem('nexa-session-token');
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { ...(jsonBody ? { 'Content-Type': 'application/json' } : {}), ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}), ...init.headers },
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({})) as { error?: string; code?: string } & T;
  if (!response.ok) throw new ApiError(data.error || 'Não foi possível concluir a operação.', response.status, data.code);
  return data;
}
