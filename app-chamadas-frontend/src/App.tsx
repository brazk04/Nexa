import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthUser, CallNotification, PresenceStatus, Room, RoomNotification } from '../../shared/protocol';
import { createSocket } from './lib/socket';
import { useAuth } from './hooks/useAuth';
import { useRooms } from './hooks/useRooms';
import { useRoom } from './hooks/useRoom';
import { useWebRTC } from './hooks/useWebRTC';
import { usePreferences } from './hooks/usePreferences';
import { AuthScreen } from './components/AuthScreen';
import { Sidebar } from './components/Sidebar';
import { Chat } from './components/Chat';
import { VideoCall } from './components/VideoCall';
import { RoomDialog } from './components/RoomDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { RoomTools } from './components/RoomTools';
import { Icon } from './components/Icon';
import { NexaLogo } from './components/NexaLogo';
import './App.css';

type ToastState = { kind: 'success' | 'error' | 'warning' | 'info'; title: string; message?: string };

function LoadingScreen() { return <main className="entry-page loading-page"><div className="entry-brand"><NexaLogo compact /></div><p>Preparando seu espaço…</p></main>; }

function playNotificationSound() {
  try {
    const context = new AudioContext(); const oscillator = context.createOscillator(); const gain = context.createGain();
    oscillator.frequency.value = 660; gain.gain.setValueAtTime(0.04, context.currentTime); gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16);
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.16);
    oscillator.onended = () => void context.close();
  } catch { /* Audio notifications are best-effort when autoplay is restricted. */ }
}

function Workspace({ user, logout, onUser }: { user: AuthUser; logout: () => Promise<void>; onUser: (user: AuthUser | null) => void }) {
  const [socket] = useState(createSocket); const { state: call, controller } = useWebRTC(socket); const rooms = useRooms(); const preferences = usePreferences();
  const drawer = useRef<HTMLDialogElement>(null); const [dialog, setDialog] = useState<'create' | 'join' | null>(null); const [settings, setSettings] = useState(false); const [tools, setTools] = useState(false); const [toast, setToast] = useState<ToastState | null>(null);
  const room = useRoom(socket, rooms.selectedId, () => { controller.leave('', false); void logout(); }); const activeCall = call.phase !== 'idle'; const connected = room.status === 'connected';
  const { selectedId, loading: roomsLoading, joinRoom, markRead, notify } = rooms;
  const savePreference = preferences.save;
  useEffect(() => { controller.configureDevices(preferences.preferences); }, [controller, preferences.preferences]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 4500); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => { if (selectedId && connected) markRead(selectedId); }, [selectedId, connected, markRead]);
  useEffect(() => {
    const notification = (value: RoomNotification) => { if (value.roomId !== selectedId) { notify(value.roomId, value.mention); setToast({ kind: 'info', title: value.mention ? 'Menção' : 'Nova mensagem', message: `${value.author}: ${value.preview}` }); if (preferences.preferences.sounds && !preferences.preferences.doNotDisturb) playNotificationSound(); } };
    const callNotification = (value: CallNotification) => { setToast({ kind: 'info', title: 'Chamada iniciada', message: `${value.startedBy} iniciou uma chamada.` }); if (preferences.preferences.sounds && !preferences.preferences.doNotDisturb) playNotificationSound(); };
    socket.on('sala_notificada', notification); socket.on('chamada_notificada', callNotification);
    return () => { socket.off('sala_notificada', notification); socket.off('chamada_notificada', callNotification); };
  }, [socket, selectedId, notify, preferences.preferences.sounds, preferences.preferences.doNotDisturb]);
  useEffect(() => {
    if (roomsLoading) return; const match = window.location.pathname.match(/^\/join\/([A-Z0-9-]+)$/i); if (!match?.[1]) return;
    void joinRoom(match[1]).then(() => { history.replaceState({}, '', '/'); setToast({ kind: 'success', title: 'Convite aceito', message: 'Você entrou na sala pelo convite.' }); }).catch(error => setToast({ kind: 'error', title: 'Não foi possível entrar', message: error.message }));
  }, [roomsLoading, joinRoom]);
  const savePreferences = useCallback(async (value: Parameters<typeof savePreference>[0]) => {
    const saved = await savePreference(value); socket.emit('atualizar_status', { status: saved.status }); return saved;
  }, [savePreference, socket]);
  const updateUser = useCallback((value: AuthUser | null) => { onUser(value); if (value) socket.emit('atualizar_perfil'); else socket.disconnect(); }, [onUser, socket]);
  const selectRoom = (roomId: string) => { drawer.current?.close(); if (roomId === rooms.selectedId) return; controller.leave('', true); rooms.setSelectedId(roomId); rooms.markRead(roomId); };
  const doLogout = async () => { controller.leave('', true); socket.disconnect(); await logout(); };
  const setStatus = (status: PresenceStatus) => { const next = { ...preferences.preferences, status, doNotDisturb: status === 'dnd' }; preferences.setPreferences(next); void preferences.save(next); socket.emit('atualizar_status', { status }); };
  const sidebarProps = { sala: rooms.selectedId, rooms: rooms.rooms, loading: rooms.loading, user, users: room.users, selfId: socket.id, connected, status: preferences.preferences.status,
    onStatus: setStatus, onFavorite: (target: Room) => void rooms.favoriteRoom(target.id, !target.favorite), onRoom: selectRoom, onCreate: () => setDialog('create' as const), onJoin: () => setDialog('join' as const), onSettings: () => setSettings(true), onLogout: () => void doLogout() };
  return <div className="workspace"><aside className="desktop-sidebar"><Sidebar {...sidebarProps} /></aside><dialog ref={drawer} className="mobile-drawer" onClick={event => { if (event.target === event.currentTarget) drawer.current?.close(); }}><Sidebar {...sidebarProps} onClose={() => drawer.current?.close()} /></dialog>
    <main className="main-panel">{rooms.selected ? <><header className="room-header"><button className="icon-button mobile-menu" onClick={() => drawer.current?.showModal()}><Icon name="menu" /></button><div className="room-heading"><Icon name="hash" size={24} /><div><h1>{rooms.selected.name}</h1><p>{rooms.selected.description}</p></div></div><span className="room-code"><small>Código</small><span>{rooms.selected.code}</span></span>
      <button className={`header-tool ${rooms.selected.favorite ? 'is-active' : ''}`} onClick={() => void rooms.favoriteRoom(rooms.selected!.id, !rooms.selected!.favorite)} aria-label="Alternar favorito" data-tooltip="Favorito"><Icon name="star" size={18} /></button><button className={`header-tool ${rooms.selected.notificationsEnabled ? 'is-active' : ''}`} onClick={() => void rooms.notifyRoom(rooms.selected!.id, !rooms.selected!.notificationsEnabled)} aria-label="Alternar notificações" data-tooltip="Notificações"><Icon name="bell" size={18} /></button><button className="secondary-button room-tools-button" onClick={() => setTools(true)}>Convidar e organizar</button><span className={`connection-status ${connected ? 'is-online' : ''}`}><i />{connected ? 'Conectado' : 'Conectando…'}</span>
      {!activeCall && <button className="primary-button header-call" disabled={!connected || room.roomCall.participants.length >= 15} onClick={() => void controller.join(rooms.selected!.id)}><Icon name="video" size={18} /><span>{room.roomCall.participants.length ? 'Entrar na chamada' : 'Iniciar chamada'}</span></button>}</header>
      {room.error && <div className="feedback feedback-error"><span>{room.error}</span><button onClick={room.reconnect}>Reconectar</button></div>}{(call.notice || call.error) && <div className={`feedback ${call.error ? 'feedback-error' : ''}`}><span>{call.error || call.notice}</span><button className="icon-button" onClick={controller.dismissNotice}><Icon name="close" size={17} /></button></div>}
      {!activeCall && room.roomCall.participants.length > 0 && <div className="call-banner"><span className="call-light" /><p><strong>{room.roomCall.participants.map(person => person.displayName).join(', ')}</strong> estão na chamada.</p><span>{room.roomCall.participants.length}/15</span></div>}
      {activeCall && <VideoCall state={call} controller={controller} username={user.displayName} selfId={socket.id} selfUserId={user.id} selfAvatarUrl={user.avatarUrl} ownerId={rooms.selected.createdBy.id} speakerId={preferences.preferences.speakerId} />}
      <Chat key={rooms.selected.id} room={rooms.selected} messages={room.messages} ready={connected} userId={user.id} typingUsers={room.typingUsers} onTyping={room.setTyping} send={room.sendMessage} edit={room.editMessage} remove={room.deleteMessage} />
    </> : <section className="empty-workspace"><span className="empty-symbol"><Icon name="users" size={34} /></span><h1>{rooms.loading ? 'Carregando suas salas…' : 'Seu espaço começa aqui.'}</h1><p>{rooms.error || 'Crie a primeira sala ou entre com um código de convite.'}</p>{!rooms.loading && <div><button className="primary-button" onClick={() => setDialog('create')}><Icon name="plus" />Criar sala</button><button className="secondary-button" onClick={() => setDialog('join')}><Icon name="enter" />Entrar com código</button></div>}</section>}</main>
    {dialog && <RoomDialog mode={dialog} onClose={() => setDialog(null)} onSubmit={dialog === 'create' ? rooms.createRoom : rooms.joinRoom} />}
    {settings && <SettingsDialog user={user} preferences={preferences.preferences} loading={preferences.loading} onSavePreferences={savePreferences} onUser={updateUser} onClose={() => setSettings(false)} />}
    {tools && rooms.selected && <RoomTools room={rooms.selected} userId={user.id} onClose={() => setTools(false)} onRoomUpdated={value => rooms.patchRoom(value.id, value)} />}
    {toast && <div className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}><span className="toast-icon"><Icon name={toast.kind === 'success' ? 'check' : toast.kind === 'error' || toast.kind === 'warning' ? 'warning' : 'info'} size={18} /></span><span className="toast-content"><strong>{toast.title}</strong>{toast.message && <small>{toast.message}</small>}</span><button aria-label="Fechar aviso" onClick={() => setToast(null)}><Icon name="close" size={16} /></button></div>}
  </div>;
}
export function App() { const auth = useAuth(); if (auth.loading) return <LoadingScreen />; if (!auth.user) return <AuthScreen login={auth.login} register={auth.register} verify={auth.verify} resend={auth.resend} />; return <Workspace user={auth.user} logout={auth.logout} onUser={auth.updateUser} />; }
export default App;
