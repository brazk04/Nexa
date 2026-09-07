import type { AuthUser, OnlineUser, PresenceStatus, Room } from '../../../shared/protocol';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { NexaLogo } from './NexaLogo';

interface Props {
  sala: string | null; rooms: Room[]; loading?: boolean; user: AuthUser; users: OnlineUser[]; selfId?: string; connected: boolean;
  status: PresenceStatus; onStatus: (status: PresenceStatus) => void; onFavorite: (room: Room) => void;
  onRoom: (sala: string) => void; onCreate: () => void; onJoin: () => void; onSettings: () => void; onLogout: () => void; onClose?: () => void;
}

export function Sidebar({ sala, rooms, loading, user: account, users, selfId, connected, status, onStatus, onFavorite, onRoom, onCreate, onJoin, onSettings, onLogout, onClose }: Props) {
  const favorites = rooms.filter(room => room.favorite);
  const channels = rooms.filter(room => !room.favorite);
  const renderRoom = (room: Room) => <RoomRow key={room.id} room={room} active={room.id === sala} onRoom={onRoom} onFavorite={onFavorite} />;
  return <div className="sidebar-content">
    <div className="workspace-brand"><NexaLogo compact />{onClose && <button className="icon-button" onClick={onClose} aria-label="Fechar menu"><Icon name="close" /></button>}</div>
    <div className="sidebar-scroll"><nav aria-label="Salas">
      {favorites.length > 0 && <section className="channel-section"><div className="sidebar-section-title"><h2>Favoritos</h2></div>{favorites.map(renderRoom)}</section>}
      <section className="channel-section"><div className="sidebar-section-title"><h2>Suas salas</h2><button className="icon-button compact-button" onClick={onCreate} aria-label="Criar sala" data-tooltip="Criar sala"><Icon name="plus" size={16} /></button></div>
        {loading && !rooms.length && <div className="sidebar-skeleton" aria-label="Carregando salas"><i /><i /><i /></div>}
        {!loading && !rooms.length && <p className="muted sidebar-empty">Você ainda não participa de nenhuma sala.</p>}
        {channels.map(renderRoom)}
      </section>
      <div className="room-shortcuts"><button onClick={onCreate}><Icon name="plus" size={16} />Criar sala</button><button onClick={onJoin}><Icon name="enter" size={16} />Entrar com código</button></div></nav>
      {sala && <section className="online-section" aria-label="Pessoas online"><h2><span>Nesta sala</span><span className="count">{users.length}</span></h2>{!users.length && <p className="muted sidebar-empty">{connected ? 'Ninguém online por aqui.' : 'Aguardando conexão…'}</p>}<ul className="online-list">{users.map(person => <li key={person.userId}><Avatar name={person.displayName} url={person.avatarUrl} small /><span className="online-name"><strong>{person.displayName}{person.socketId === selfId && <small> você</small>}</strong><small>{person.inCall ? 'Na chamada' : statusLabel(person.status)}</small></span><span className={`presence-dot status-${person.status}`} /></li>)}</ul></section>}
      <div className="sidebar-note"><Icon name="video" size={17} /><p>Cada sala reúne conversa, presença e chamadas em grupo.</p></div>
    </div>
    <div className="profile"><Avatar name={account.displayName} url={account.avatarUrl} small /><span><strong>{account.displayName}</strong><select aria-label="Status de presença" value={status} onChange={event => onStatus(event.target.value as PresenceStatus)}><option value="online">Online</option><option value="busy">Ocupado</option><option value="dnd">Não perturbe</option><option value="away">Ausente</option></select></span><button className="icon-button" onClick={onSettings} aria-label="Configurações" data-tooltip="Configurações"><Icon name="settings" size={18} /></button><button className="icon-button" aria-label="Sair da conta" onClick={onLogout} data-tooltip="Sair"><Icon name="logout" size={17} /></button></div>
  </div>;
}

function RoomRow({ room, active, onRoom, onFavorite }: { room: Room; active: boolean; onRoom: (id: string) => void; onFavorite: (room: Room) => void }) {
  return <div className="channel-row"><button className={`channel-item ${active ? 'is-active' : ''}`} onClick={() => onRoom(room.id)}><Icon name="hash" size={18} /><span>{room.name}</span>{room.mentionCount > 0 ? <b className="mention-badge">@{room.mentionCount}</b> : room.unreadCount > 0 ? <b className="unread-badge">{room.unreadCount}</b> : null}</button><button className={`favorite-button ${room.favorite ? 'is-favorite' : ''}`} onClick={() => onFavorite(room)} aria-label={room.favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'} data-tooltip={room.favorite ? 'Desfavoritar' : 'Favoritar'}><Icon name="star" size={15} /></button></div>;
}

function statusLabel(status: PresenceStatus) { return status === 'busy' ? 'Ocupado' : status === 'dnd' ? 'Não perturbe' : status === 'away' ? 'Ausente' : 'Disponível'; }
