import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSocket } from '../lib/socket';
import type { History, Message, Presence, RoomCall, OnlineUser, Result, TypingUser } from '../../../shared/protocol';

type Connection = 'connecting' | 'joining' | 'connected' | 'idle' | 'error';
function mergeMessages(first: Message[], second: Message[]) {
  return [...new Map([...first, ...second].map(message => [message.id, message])).values()].sort((a, b) => a.id - b.id);
}
export function useRoom(socket: AppSocket, roomId: string | null, onUnauthorized: () => void) {
  const [status, setStatus] = useState<Connection>(roomId ? 'connecting' : 'idle');
  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<OnlineUser[]>([]);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const [roomCall, setRoomCall] = useState<RoomCall>({ sala: roomId ?? '', callId: null, startedAt: null, participants: [] });
  const [error, setError] = useState('');
  const roomRef = useRef<string | null>(roomId);
  const requestRef = useRef('');
  const mounted = useRef(false);
  const unauthorizedRef = useRef(onUnauthorized);
  useEffect(() => { unauthorizedRef.current = onUnauthorized; }, [onUnauthorized]);

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
      setRoomCall({ sala: roomRef.current ?? '', callId: null, startedAt: null, participants: [] });
    };
    const onError = (failure: Error) => {
      setStatus('error');
      if (failure.message === 'unauthorized') { setError('Sua sessão expirou. Entre novamente.'); unauthorizedRef.current(); }
      else setError('Servidor indisponível. Tentando reconectar…');
    };
    const onHistory = (history: History) => {
      if (history.sala !== roomRef.current || history.requestId !== requestRef.current) return;
      setMessages(previous => mergeMessages(history.mensagens, previous)); setStatus('connected'); setError('');
    };
    const onMessage = (message: Message) => {
      if (message.sala !== roomRef.current) return;
      setMessages(previous => mergeMessages(previous, [message]));
      if (document.visibilityState === 'visible') socket.emit('marcar_sala_lida', { sala: message.sala });
    };
    const onMessageUpdated = (message: Message) => {
      if (message.sala === roomRef.current) setMessages(previous => previous.map(item => item.id === message.id ? { ...message, mentioned: item.mentioned || message.mentioned } : item));
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
    socket.connect();
    return () => {
      mounted.current = false; requestRef.current = '';
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
      setMessages([]); setUsers([]); setTypingUsers([]); setError('');
      setRoomCall({ sala: roomId ?? '', callId: null, startedAt: null, participants: [] });
      setStatus(roomId ? (socket.connected ? 'joining' : 'connecting') : 'idle');
      if (roomId && socket.connected) join();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [roomId, socket, join]);

  const reconnect = () => { socket.disconnect(); setStatus(roomRef.current ? 'connecting' : 'idle'); setError(''); socket.connect(); };
  const sendMessage = async (texto: string, replyToId?: number | null) => {
    if (!roomRef.current || !socket.connected || status !== 'connected') throw new Error('Espere a conexão com a sala para enviar.');
    const result: Result<Message> = await socket.timeout(10_000).emitWithAck('mensagem_chat', { sala: roomRef.current, texto, replyToId });
    if (!result.ok) throw new Error(result.error);
  };
  const editMessage = async (messageId: number, texto: string) => {
    if (!roomRef.current) throw new Error('Sala indisponível.');
    const result: Result<Message> = await socket.timeout(10_000).emitWithAck('editar_mensagem', { sala: roomRef.current, messageId, texto });
    if (!result.ok) throw new Error(result.error);
  };
  const deleteMessage = async (messageId: number) => {
    if (!roomRef.current) throw new Error('Sala indisponível.');
    const result: Result<Message> = await socket.timeout(10_000).emitWithAck('excluir_mensagem', { sala: roomRef.current, messageId });
    if (!result.ok) throw new Error(result.error);
  };
  const setTyping = useCallback((isTyping: boolean) => {
    if (roomRef.current && socket.connected && status === 'connected') socket.emit('digitando', { sala: roomRef.current, typing: isTyping });
  }, [socket, status]);
  return { status, messages, users, typingUsers, roomCall, error, reconnect, sendMessage, editMessage, deleteMessage, setTyping };
}
