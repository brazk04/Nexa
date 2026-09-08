import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { AuthUser, CallNotification, PresenceStatus, Room, RoomNotification, RoomRemoved } from '../../shared/protocol';
import { createSocket } from './lib/socket';
import { useRooms } from './hooks/useRooms';
import { useRoom } from './hooks/useRoom';
import { useWebRTC } from './hooks/useWebRTC';
import { usePreferences } from './hooks/usePreferences';
import type { PWAInstaller } from './hooks/usePWAInstall';
import { Sidebar } from './components/Sidebar';
import { Chat } from './components/Chat';
import { RoomDialog } from './components/RoomDialog';
import { Icon } from './components/Icon';
import './App.css';

const VideoCall = lazy(() => import('./components/VideoCall').then(module => ({ default: module.VideoCall })));
const SettingsDialog = lazy(() => import('./components/SettingsDialog').then(module => ({ default: module.SettingsDialog })));
const RoomTools = lazy(() => import('./components/RoomTools').then(module => ({ default: module.RoomTools })));

type ToastState = { kind: 'success' | 'error' | 'warning' | 'info'; title: string; message?: string };
type BadgeNavigator = Navigator & { setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };


function playNotificationSound() {
  try {
    const context = new AudioContext(); const oscillator = context.createOscillator(); const gain = context.createGain();
    oscillator.frequency.value = 660; gain.gain.setValueAtTime(0.04, context.currentTime); gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16);
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.16);
    oscillator.onended = () => void context.close();
  } catch { /* Audio notifications are best-effort when autoplay is restricted. */ }
}

export default function Workspace({ user, logout, onUser, installer }: { user: AuthUser; logout: () => Promise<void>; onUser: (user: AuthUser | null) => void; installer: PWAInstaller }) {
  const [socket] = useState(createSocket); const { state: call, controller } = useWebRTC(socket); const rooms = useRooms(); const preferences = usePreferences();
  const drawer = useRef<HTMLDialogElement>(null); const [dialog, setDialog] = useState<'create' | 'join' | null>(null); const [settings, setSettings] = useState(false); const [tools, setTools] = useState(false); const [toast, setToast] = useState<ToastState | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const [permissionDismissed, setPermissionDismissed] = useState(false);
  const [installDismissed, setInstallDismissed] = useState(false); const [iosInstallHelp, setIosInstallHelp] = useState(false);
  const room = useRoom(socket, rooms.selectedId, user, () => { controller.leave('', false); void logout(); }); const activeCall = call.phase !== 'idle'; const connected = room.status === 'connected';
  const { selectedId, loading: roomsLoading, joinRoom, markRead, notify } = rooms;
  const savePreference = preferences.save;
  useEffect(() => { controller.configureDevices(preferences.preferences); }, [controller, preferences.preferences]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 4500); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => { if (selectedId && connected) markRead(selectedId); }, [selectedId, connected, markRead]);
  const unreadTotal = rooms.rooms.reduce((total, item) => total + item.unreadCount, 0);
  useEffect(() => {
    const count = Math.min(99, unreadTotal);
    document.title = unreadTotal ? `(${unreadTotal > 99 ? '99+' : unreadTotal}) Nexa` : 'Nexa';
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (favicon) favicon.href = count ? notificationFavicon(count) : '/favicon.svg';
    const badge = navigator as BadgeNavigator;
    const badgeOperation = unreadTotal ? badge.setAppBadge?.(unreadTotal) : badge.clearAppBadge?.();
    if (badgeOperation) void badgeOperation.catch(() => undefined);
    return () => { document.title = 'Nexa'; if (favicon) favicon.href = '/favicon.svg'; };
  }, [unreadTotal]);
  useEffect(() => {
    const desktopNotification = (title: string, body: string, tag: string, roomId: string) => {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || preferences.preferences.doNotDisturb) return false;
      let item: Notification;
      try { item = new Notification(title, { body, icon: '/nexa-logo.png', badge: '/favicon.svg', tag, silent: !preferences.preferences.sounds }); }
      catch { return false; }
      item.onclick = () => { window.focus(); drawer.current?.close(); controller.leave('', true); rooms.setSelectedId(roomId); rooms.markRead(roomId); item.close(); };
      return true;
    };
    const notification = (value: RoomNotification) => {
      const outsideRoom = value.roomId !== selectedId;
      if (outsideRoom) { notify(value.roomId, value.mention); setToast({ kind: 'info', title: value.mention ? 'Menção' : 'Nova mensagem', message: `${value.author}: ${value.preview}` }); }
      const shown = desktopNotification(value.mention ? `${value.author} mencionou você` : `Nova mensagem de ${value.author}`, value.preview || 'Enviou um arquivo', `message-${value.messageId}`, value.roomId);
      if (!shown && outsideRoom && preferences.preferences.sounds && !preferences.preferences.doNotDisturb) playNotificationSound();
    };
    const callNotification = (value: CallNotification) => { setToast({ kind: 'info', title: 'Chamada iniciada', message: `${value.startedBy} iniciou uma chamada.` }); if (preferences.preferences.sounds && !preferences.preferences.doNotDisturb) playNotificationSound(); };
    socket.on('sala_notificada', notification); socket.on('chamada_notificada', callNotification);
    return () => { socket.off('sala_notificada', notification); socket.off('chamada_notificada', callNotification); };
  }, [socket, selectedId, notify, preferences.preferences.sounds, preferences.preferences.doNotDisturb, controller, rooms]);
  useEffect(() => {
    const removed = (event: RoomRemoved) => {
      if (rooms.selectedId === event.roomId) { controller.leave('', false); setTools(false); }
      rooms.removeRoom(event.roomId);
      setToast({ kind: event.reason === 'deleted' ? 'warning' : 'info', title: event.reason === 'deleted' ? 'Sala excluída' : 'Você saiu da sala', message: event.reason === 'deleted' ? 'A sala e seus dados foram removidos.' : 'A sala foi removida da sua lista.' });
    };
    socket.on('sala_removida', removed); return () => { socket.off('sala_removida', removed); };
  }, [controller, rooms, socket]);
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
  const requestNotifications = async () => {
    if (typeof Notification === 'undefined') { setNotificationPermission('unsupported'); return; }
    try {
      const permission = await Notification.requestPermission(); setNotificationPermission(permission); setPermissionDismissed(true);
      setToast(permission === 'granted' ? { kind: 'success', title: 'Notificações ativadas', message: 'Novas mensagens aparecerão no computador.' } : { kind: 'warning', title: 'Notificações bloqueadas', message: 'Você pode liberá-las nas configurações do navegador.' });
    } catch { setPermissionDismissed(true); setToast({ kind: 'warning', title: 'Notificações indisponíveis', message: 'O navegador não permitiu abrir a solicitação.' }); }
  };
  const installApp = async () => {
    try {
    const outcome = await installer.install();
    if (outcome === 'manual') { setIosInstallHelp(true); return; }
    setInstallDismissed(true);
    if (outcome === 'accepted') setToast({ kind: 'success', title: 'Instalação solicitada', message: 'O navegador está preparando o atalho do Nexa.' });
    } catch { setToast({ kind: 'warning', title: 'Não foi possível instalar', message: 'Tente novamente ou use a opção de instalação do navegador.' }); }
  };
  const setStatus = (status: PresenceStatus) => { const next = { ...preferences.preferences, status, doNotDisturb: status === 'dnd' }; preferences.setPreferences(next); void preferences.save(next); socket.emit('atualizar_status', { status }); };
  const sidebarProps = { sala: rooms.selectedId, rooms: rooms.rooms, loading: rooms.loading, user, users: room.users, selfId: socket.id, connected, status: preferences.preferences.status,
    onStatus: setStatus, onFavorite: (target: Room) => void rooms.favoriteRoom(target.id, !target.favorite), onRoom: selectRoom, onCreate: () => setDialog('create' as const), onJoin: () => setDialog('join' as const), onSettings: () => setSettings(true), onLogout: () => void doLogout() };
  return <div className="workspace"><aside className="desktop-sidebar"><Sidebar {...sidebarProps} /></aside><dialog ref={drawer} className="mobile-drawer" onClick={event => { if (event.target === event.currentTarget) drawer.current?.close(); }}><Sidebar {...sidebarProps} onClose={() => drawer.current?.close()} /></dialog>
    <main className="main-panel">{installer.available && !installDismissed && <aside className="notification-consent app-install-offer" aria-label="Instalar aplicativo"><span className="notification-consent-icon"><Icon name="download" size={20} /></span><span><strong>Instale o Nexa neste dispositivo</strong><small>Abra em uma janela própria e crie um atalho no sistema.</small></span><button className="primary-button" onClick={() => void installApp()}>{installer.manual ? 'Como instalar' : 'Instalar Nexa'}</button><button className="icon-button" aria-label="Agora não instalar" onClick={() => setInstallDismissed(true)}><Icon name="close" size={16} /></button></aside>}{!toast && !preferences.loading && preferences.preferences.messageNotifications && notificationPermission === 'default' && !permissionDismissed && <aside className="notification-consent" aria-label="Ativar notificações"><span className="notification-consent-icon"><Icon name="bell" size={20} /></span><span><strong>Receba novas mensagens</strong><small>O Nexa pode avisar você mesmo quando esta aba estiver em segundo plano.</small></span><button className="primary-button" onClick={() => void requestNotifications()}>Ativar</button><button className="icon-button" aria-label="Agora não" onClick={() => setPermissionDismissed(true)}><Icon name="close" size={16} /></button></aside>}{rooms.selected ? <><header className="room-header"><button className="icon-button mobile-menu" aria-label="Abrir menu" onClick={() => drawer.current?.showModal()}><Icon name="menu" /></button><div className="room-heading"><Icon name="hash" size={24} /><div><h1>{rooms.selected.name}</h1><p>{rooms.selected.description}</p></div></div><span className="room-code"><small>Código</small><span>{rooms.selected.code}</span></span>
      <button className={`header-tool ${rooms.selected.favorite ? 'is-active' : ''}`} onClick={() => void rooms.favoriteRoom(rooms.selected!.id, !rooms.selected!.favorite)} aria-label="Alternar favorito" data-tooltip="Favorito"><Icon name="star" size={18} /></button><button className={`header-tool ${rooms.selected.notificationsEnabled ? 'is-active' : ''}`} onClick={() => void rooms.notifyRoom(rooms.selected!.id, !rooms.selected!.notificationsEnabled)} aria-label="Alternar notificações" data-tooltip="Notificações"><Icon name="bell" size={18} /></button><button className="secondary-button room-tools-button" onClick={() => setTools(true)}>Convidar e organizar</button><span className={`connection-status ${connected ? 'is-online' : ''}`}><i />{connected ? 'Conectado' : 'Conectando…'}</span>
      {!activeCall && <button className="primary-button header-call" aria-label={room.roomCall.participants.length ? 'Entrar na chamada' : 'Iniciar chamada'} disabled={!connected || room.roomCall.participants.length >= 15} onClick={() => void controller.join(rooms.selected!.id)}><Icon name="video" size={18} /><span>{room.roomCall.participants.length ? 'Entrar na chamada' : 'Iniciar chamada'}</span></button>}</header>
      {room.error && <div className="feedback feedback-error"><span>{room.error}</span><button onClick={room.reconnect}>Reconectar</button></div>}{(call.notice || call.error) && <div className={`feedback ${call.error ? 'feedback-error' : ''}`}><span>{call.error || call.notice}</span><button className="icon-button" onClick={controller.dismissNotice}><Icon name="close" size={17} /></button></div>}
      {!activeCall && room.roomCall.participants.length > 0 && <div className="call-banner"><span className="call-light" /><p><strong>{room.roomCall.participants.map(person => person.displayName).join(', ')}</strong> estão na chamada.</p><span>{room.roomCall.participants.length}/15</span></div>}
      {activeCall && <Suspense fallback={<p role="status">Preparando chamada…</p>}><VideoCall state={call} controller={controller} username={user.displayName} selfId={socket.id} selfUserId={user.id} selfAvatarUrl={user.avatarUrl} ownerId={rooms.selected.createdBy.id} speakerId={preferences.preferences.speakerId} /></Suspense>}
      <Chat key={rooms.selected.id} room={rooms.selected} messages={room.messages} ready={connected} userId={user.id} typingUsers={room.typingUsers} hasMore={room.hasMore} loadingEarlier={room.loadingEarlier} onLoadEarlier={room.loadEarlier} onTyping={room.setTyping} send={room.sendMessage} retry={room.retryMessage} edit={room.editMessage} remove={room.deleteMessage} />
    </> : <section className="empty-workspace"><span className="empty-symbol"><Icon name="users" size={34} /></span><h1>{rooms.loading ? 'Carregando suas salas…' : 'Seu espaço começa aqui.'}</h1><p>{rooms.error || 'Crie a primeira sala ou entre com um código de convite.'}</p>{!rooms.loading && <div><button className="primary-button" onClick={() => setDialog('create')}><Icon name="plus" />Criar sala</button><button className="secondary-button" onClick={() => setDialog('join')}><Icon name="enter" />Entrar com código</button></div>}</section>}</main>
    {dialog && <RoomDialog mode={dialog} onClose={() => setDialog(null)} onSubmit={dialog === 'create' ? rooms.createRoom : rooms.joinRoom} />}
    <Suspense fallback={<p role="status">Carregando painel…</p>}>
    {settings && <SettingsDialog user={user} preferences={preferences.preferences} loading={preferences.loading} onSavePreferences={savePreferences} onUser={updateUser} onClose={() => setSettings(false)} />}
    {tools && rooms.selected && <RoomTools room={rooms.selected} userId={user.id} onClose={() => setTools(false)} onRoomUpdated={value => rooms.patchRoom(value.id, value)} onRoomRemoved={rooms.removeRoom} />}
    </Suspense>
    {iosInstallHelp && <div className="inline-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setIosInstallHelp(false); }}><section className="confirm-dialog install-help-dialog" role="dialog" aria-modal="true" aria-labelledby="install-help-title"><span className="confirm-icon install-icon"><Icon name="download" size={20} /></span><h2 id="install-help-title">Instalar o Nexa</h2><p>No Safari, toque em <strong>Compartilhar</strong> e depois em <strong>Adicionar à Tela de Início</strong>.</p><div className="confirm-actions"><button className="primary-button" onClick={() => { setIosInstallHelp(false); setInstallDismissed(true); }}>Entendi</button></div></section></div>}
    {toast && <div className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}><span className="toast-icon"><Icon name={toast.kind === 'success' ? 'check' : toast.kind === 'error' || toast.kind === 'warning' ? 'warning' : 'info'} size={18} /></span><span className="toast-content"><strong>{toast.title}</strong>{toast.message && <small>{toast.message}</small>}</span><button aria-label="Fechar aviso" onClick={() => setToast(null)}><Icon name="close" size={16} /></button></div>}
  </div>;
}
function notificationFavicon(count: number) {
  const label = count > 9 ? '9+' : String(count);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="2" y="2" width="38" height="38" rx="12" fill="#8b5cf6"/><path d="M14 14v17M14 14l14 17V14" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="37" cy="11" r="10" fill="#ef4655" stroke="#fff" stroke-width="2"/><text x="37" y="15" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="700" fill="#fff">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
