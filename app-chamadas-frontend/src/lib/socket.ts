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
    ...(websocketOnly ? { transports: ['websocket'] as const } : {}),
  });
}
