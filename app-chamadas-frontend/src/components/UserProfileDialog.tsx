import type { OnlineUser, PresenceStatus } from '../../../shared/protocol';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

const statusText: Record<PresenceStatus, string> = {
  online: 'Disponível', busy: 'Ocupado', dnd: 'Não perturbe', away: 'Ausente',
};

export function UserProfileDialog({ person, self, onClose }: { person: OnlineUser; self: boolean; onClose: () => void }) {
  return <div className="inline-modal-backdrop profile-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="user-profile-dialog" role="dialog" aria-modal="true" aria-labelledby="user-profile-title">
      <button className="icon-button profile-close" aria-label="Fechar perfil" onClick={onClose}><Icon name="close" size={17} /></button>
      <div className="profile-cover" />
      <div className="profile-avatar"><Avatar name={person.displayName} url={person.avatarUrl} /></div>
      <div className="profile-details">
        <h2 id="user-profile-title">{person.displayName}{self && <small> você</small>}</h2>
        <p>@{person.username}</p>
        <div className="profile-presence"><span className={`presence-dot status-${person.status}`} /><span><strong>{statusText[person.status]}</strong><small>{person.inCall ? 'Participando da chamada desta sala' : 'Presente nesta sala'}</small></span></div>
      </div>
    </section>
  </div>;
}
