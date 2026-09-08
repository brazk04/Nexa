import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { ClientEvents, ServerEvents } from '../../../shared/protocol';

export type AppSocket = Socket<ServerEvents, ClientEvents>;
export function createSocket(): AppSocket {
  const url = import.meta.env.VITE_SOCKET_URL || `${window.location.protocol}//${window.location.hostname}:3333`;
  const websocketOnly = import.meta.env.VITE_SOCKET_TRANSPORTS === 'websocket';
  return io(url, {
    autoConnect: false,
    withCredentials: true,
    timeout: 20_000,
    reconnection: true,
    reconnectionDelay: 750,
    reconnectionDelayMax: 8_000,
    randomizationFactor: 0.5,
    auth: { token: localStorage.getItem('nexa-session-token') || undefined },
    ...(websocketOnly ? { transports: ['websocket'] as const } : {}),
  });
}
