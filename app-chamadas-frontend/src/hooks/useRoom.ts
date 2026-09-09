import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSocket } from '../lib/socket';
import { api } from '../lib/api';
import type { AuthUser, History, Message, Presence, RoomCall, OnlineUser, Result, TypingUser } from '../../../shared/protocol';

type Connection = 'connecting' | 'joining' | 'connected' | 'idle' | 'error';

function mergeMessages(first: Message[], second: Message[]) {
  const merged = [...first];
  const ids = new Map(first.map((message, index) => [message.id, index]));
  const clientIds = new Map(first.filter(message => message.clientMessageId).map(message => [message.clientMessageId, ids.get(message.id)!]));
  for (const message of second) {
    const index = ids.get(message.id) ?? (message.clientMessageId ? clientIds.get(message.clientMessageId) : undefined);
    if (index !== undefined) merged[index] = { ...merged[index], ...message };
    else merged.push(message);
    const position = index ?? merged.length - 1;
    ids.set(message.id, position); if (message.clientMessageId) clientIds.set(message.clientMessageId, position);
  }
  return merged.sort((a, b) => new Date(a.criadoEm).getTime() - new Date(b.criadoEm).getTime() || a.id - b.id);
}

const confirmed = (message: Message): Message => ({ ...message, deliveryStatus: 'sent' });

export function useRoom(socket: AppSocket, roomId: string | null, user: AuthUser, onUnauthorized: () => void) {
  const [status, setStatus] = useState<Connection>(roomId ? 'connecting' : 'idle');
  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<OnlineUser[]>([]);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [roomCall, setRoomCall] = useState<RoomCall>({ sala: roomId ?? '', callId: null, startedAt: null, participants: [] });
  const [error, setError] = useState('');
  const roomRef = useRef<string | null>(roomId);
  const requestRef = useRef('');
  const mounted = useRef(false);
  const unauthorizedRef = useRef(onUnauthorized);
  const messagesRef = useRef<Message[]>([]);
  const pendingId = useRef(-1);
  useEffect(() => { unauthorizedRef.current = onUnauthorized; }, [onUnauthorized]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const join = useCallback(() => {
    const sala = roomRef.current;
    if (!socket.connected || !sala) return;
    const requestId = crypto.randomUUID();
    requestRef.current = requestId;
    setStatus('joining'); setError('');
    socket.timeout(10_000).emit('entrar_sala', { sala, requestId }, (timeout, result) => {
      if (!mounted.current || requestRef.current !== requestId) return;
      if (timeout || !result?.ok) {
        setStatus('error');
        setError(result && !result.ok ? result.error : 'O servidor demorou a responder. Reconecte para carregar a sala.');
      }
    });
  }, [socket]);

  useEffect(() => {
    mounted.current = true;
    const onDisconnect = () => {
      requestRef.current = '';
      setStatus(roomRef.current ? 'connecting' : 'idle'); setUsers([]); setTypingUsers([]);
      // Keep the last room snapshot while signaling reconnects.
    };
    const onError = (failure: Error) => {
      setStatus('error');
      if (failure.message === 'unauthorized') { setError('Sua sessão expirou. Entre novamente.'); unauthorizedRef.current(); }
      else setError('Servidor indisponível. Tentando reconectar…');
    };
    const onHistory = (history: History) => {
      if (history.sala !== roomRef.current || history.requestId !== requestRef.current) return;
      setMessages(previous => mergeMessages(previous, history.mensagens.map(confirmed)));
      setHasMore(history.hasMore); setStatus('connected'); setError('');
    };
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRead = () => {
      if (readTimer || !roomRef.current || document.visibilityState !== 'visible') return;
      const sala = roomRef.current;
      readTimer = setTimeout(() => {
        readTimer = undefined;
        if (socket.connected && roomRef.current === sala && document.visibilityState === 'visible') socket.emit('marcar_sala_lida', { sala });
      }, 750);
    };
    const onMessage = (message: Message) => {
      if (message.sala !== roomRef.current) return;
      setMessages(previous => mergeMessages(previous, [confirmed(message)]));
      scheduleRead();
    };
    const onMessageUpdated = (message: Message) => {
      if (message.sala === roomRef.current) setMessages(previous => previous.map(item => item.id === message.id ? { ...confirmed(message), mentioned: item.mentioned || message.mentioned } : item));
    };
    const onPresence = (presence: Presence) => { if (presence.sala === roomRef.current) setUsers(presence.users); };
    const onCall = (call: RoomCall) => { if (call.sala === roomRef.current) setRoomCall(call); };
    const onTyping = (event: { sala: string; users: TypingUser[] }) => { if (event.sala === roomRef.current) setTypingUsers(event.users); };
    socket.on('connect', join);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onError);
    socket.on('historico_mensagens', onHistory);
    socket.on('nova_mensagem', onMessage);
    socket.on('mensagem_atualizada', onMessageUpdated);
    socket.on('usuarios_online', onPresence);
    socket.on('chamada_atualizada', onCall);
    socket.on('usuarios_digitando', onTyping);
    socket.on('erro_operacao', setError);
    document.addEventListener('visibilitychange', scheduleRead);
    socket.connect();
    return () => {
      mounted.current = false; requestRef.current = '';
      if (readTimer) clearTimeout(readTimer);
      document.removeEventListener('visibilitychange', scheduleRead);
      socket.off('connect', join); socket.off('disconnect', onDisconnect); socket.off('connect_error', onError);
      socket.off('historico_mensagens', onHistory); socket.off('nova_mensagem', onMessage); socket.off('mensagem_atualizada', onMessageUpdated);
      socket.off('usuarios_online', onPresence); socket.off('chamada_atualizada', onCall); socket.off('usuarios_digitando', onTyping); socket.off('erro_operacao', setError);
      if (roomRef.current && socket.connected) socket.emit('digitando', { sala: roomRef.current, typing: false });
      socket.disconnect();
    };
  }, [socket, join]);

  useEffect(() => {
    if (roomRef.current && socket.connected) socket.emit('digitando', { sala: roomRef.current, typing: false });
    roomRef.current = roomId; requestRef.current = '';
    const timer = window.setTimeout(() => {
      setMessages([]); setUsers([]); setTypingUsers([]); setHasMore(false); setLoadingEarlier(false); setError('');
      setRoomCall({ sala: roomId ?? '', callId: null, startedAt: null, participants: [] });
      setStatus(roomId ? (socket.connected ? 'joining' : 'connecting') : 'idle');
      if (roomId && socket.connected) join();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [roomId, socket, join]);

  const reconnect = useCallback(() => { socket.disconnect(); setStatus(roomRef.current ? 'connecting' : 'idle'); setError(''); socket.connect(); }, [socket]);
  const persistMessage = useCallback(async (sala: string, texto: string, replyToId: number | null, clientMessageId: string) => {
    const result: Result<Message> = await socket.timeout(10_000).emitWithAck('mensagem_chat', { sala, texto, replyToId, clientMessageId });
    if (!result.ok) throw new Error(result.error);
    if (roomRef.current === sala) setMessages(previous => mergeMessages(previous, [confirmed(result.data)]));
  }, [socket]);
  const sendMessage = useCallback(async (texto: string, replyToId?: number | null) => {
    if (!roomRef.current || !socket.connected || status !== 'connected') throw new Error('Espere a conexão com a sala para enviar.');
    const sala = roomRef.current; const text = texto.trim(); const clientMessageId = crypto.randomUUID(); const createdAt = new Date();
    const replied = replyToId ? messagesRef.current.find(message => message.id === replyToId) : undefined;
    const optimistic: Message = {
      id: pendingId.current--, clientMessageId, autor: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl,
      texto: text, sala, criadoEm: createdAt.toISOString(), horario: createdAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      userId: user.id, editedAt: null, deleted: false, mentioned: false, attachments: [], deliveryStatus: 'sending',
      replyTo: replied ? { id: replied.id, autor: replied.autor, texto: replied.texto, deleted: replied.deleted } : null,
    };
    setMessages(previous => mergeMessages(previous, [optimistic]));
    try { await persistMessage(sala, text, replyToId ?? null, clientMessageId); }
    catch (failure) {
      setMessages(previous => previous.map(message => message.clientMessageId === clientMessageId && message.id < 0 ? { ...message, deliveryStatus: 'failed' } : message));
      throw failure;
    }
  }, [persistMessage, socket, status, user]);
  const retryMessage = useCallback(async (clientMessageId: string) => {
    const message = messagesRef.current.find(item => item.clientMessageId === clientMessageId && item.deliveryStatus === 'failed');
    if (!message || !roomRef.current || !socket.connected) throw new Error('Não foi possível reenviar agora.');
    setMessages(previous => previous.map(item => item.clientMessageId === clientMessageId ? { ...item, deliveryStatus: 'sending' } : item));
    try { await persistMessage(roomRef.current, message.texto, message.replyTo?.id ?? null, clientMessageId); }
    catch (failure) {
      setMessages(previous => previous.map(item => item.clientMessageId === clientMessageId && item.id < 0 ? { ...item, deliveryStatus: 'failed' } : item));
      throw failure;
    }
  }, [persistMessage, socket]);
  const loadEarlier = useCallback(async () => {
    const sala = roomRef.current; const first = messagesRef.current.find(message => message.id > 0);
    if (!sala || !first || loadingEarlier || !hasMore) return;
    setLoadingEarlier(true);
    try {
      const result = await api<{ messages: Message[]; hasMore: boolean }>(`/rooms/${sala}/messages?before=${first.id}&limit=50`);
      if (sala !== roomRef.current) return;
      setMessages(previous => mergeMessages(result.messages.map(confirmed), previous)); setHasMore(result.hasMore);
    } finally { if (sala === roomRef.current) setLoadingEarlier(false); }
  }, [hasMore, loadingEarlier]);
  const editMessage = useCallback(async (messageId: number, texto: string) => {
    if (!roomRef.current) throw new Error('Sala indisponível.');
    const result: Result<Message> = await socket.timeout(10_000).emitWithAck('editar_mensagem', { sala: roomRef.current, messageId, texto });
    if (!result.ok) throw new Error(result.error);
  }, [socket]);
  const deleteMessage = useCallback(async (messageId: number) => {
    if (!roomRef.current) throw new Error('Sala indisponível.');
    const result: Result<Message> = await socket.timeout(10_000).emitWithAck('excluir_mensagem', { sala: roomRef.current, messageId });
    if (!result.ok) throw new Error(result.error);
  }, [socket]);
  const setTyping = useCallback((isTyping: boolean) => {
    if (roomRef.current && socket.connected && status === 'connected') socket.emit('digitando', { sala: roomRef.current, typing: isTyping });
  }, [socket, status]);
  return { status, messages, users, typingUsers, roomCall, error, hasMore, loadingEarlier, reconnect, sendMessage, retryMessage, loadEarlier, editMessage, deleteMessage, setTyping };
}
