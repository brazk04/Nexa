import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AppSocket } from '../lib/socket';
import { CallController } from '../lib/CallController';

export function useWebRTC(socket: AppSocket) {
  const [controller] = useState(() => new CallController(socket));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => controller.attach(), [controller]);
  return { state, controller };
}
