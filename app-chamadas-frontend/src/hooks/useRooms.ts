import { useCallback, useEffect, useState } from 'react';
import type { Room } from '../../../shared/protocol';
import { api } from '../lib/api';

export function useRooms() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const result = await api<{ rooms: Room[] }>('/rooms');
      setRooms(result.rooms);
      setSelectedId(current => current && result.rooms.some(room => room.id === current) ? current : result.rooms[0]?.id ?? null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível carregar suas salas.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  const saveRoom = useCallback((room: Room) => {
    setRooms(current => current.some(item => item.id === room.id) ? current : [...current, room]);
    setSelectedId(room.id);
    return room;
  }, []);
  const createRoom = useCallback(async (name: string) => saveRoom((await api<{ room: Room }>('/rooms', { method: 'POST', body: JSON.stringify({ name }) })).room), [saveRoom]);
  const joinRoom = useCallback(async (code: string) => saveRoom((await api<{ room: Room }>('/rooms/join', { method: 'POST', body: JSON.stringify({ code }) })).room), [saveRoom]);
  const patchRoom = useCallback((roomId: string, patch: Partial<Room>) => setRooms(current => current.map(room => room.id === roomId ? { ...room, ...patch } : room)), []);
  const updateRoom = useCallback(async (roomId: string, name: string, description: string) => {
    const room = (await api<{ room: Room }>(`/rooms/${roomId}`, { method: 'PATCH', body: JSON.stringify({ name, description }) })).room;
    patchRoom(roomId, room); return room;
  }, [patchRoom]);
  const favoriteRoom = useCallback(async (roomId: string, favorite: boolean) => {
    await api(`/rooms/${roomId}/favorite`, { method: 'PUT', body: JSON.stringify({ favorite }) }); patchRoom(roomId, { favorite });
  }, [patchRoom]);
  const notifyRoom = useCallback(async (roomId: string, enabled: boolean) => {
    await api(`/rooms/${roomId}/notifications`, { method: 'PUT', body: JSON.stringify({ enabled }) }); patchRoom(roomId, { notificationsEnabled: enabled });
  }, [patchRoom]);
  const markRead = useCallback((roomId: string) => { patchRoom(roomId, { unreadCount: 0, mentionCount: 0 }); void api(`/rooms/${roomId}/read`, { method: 'POST' }).catch(() => setError('Não foi possível atualizar a leitura da sala.')); }, [patchRoom]);
  const notify = useCallback((roomId: string, mention: boolean) => setRooms(current => current.map(room => room.id === roomId
    ? { ...room, unreadCount: room.unreadCount + 1, mentionCount: room.mentionCount + (mention ? 1 : 0) } : room)), []);
  const removeRoom = useCallback((roomId: string) => {
    const next = rooms.filter(room => room.id !== roomId);
    setRooms(next); setSelectedId(current => current === roomId ? next[0]?.id ?? null : current);
  }, [rooms]);
  return { rooms, selectedId, selected: rooms.find(room => room.id === selectedId) ?? null, loading, error, setSelectedId, createRoom, joinRoom,
    updateRoom, favoriteRoom, notifyRoom, markRead, notify, removeRoom, patchRoom, reload: load };
}
