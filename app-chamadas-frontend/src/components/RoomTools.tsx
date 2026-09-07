import { useCallback, useEffect, useState } from 'react';
import type { AuthUser, Room } from '../../../shared/protocol';
import { api, API_URL } from '../lib/api';
import { Icon } from './Icon';

type Section = 'share' | 'meeting' | 'history' | 'room';
interface Agenda { id: string; text: string; completed: boolean; position: number; resolvedAsyncAt: string | null }
interface Decision { id: string; text: string; author: string; createdAt: string }
interface Action { id: string; description: string; status: string; deadline: string | null; assignee: AuthUser | null }
interface CallLog { id: string; startedAt: string; endedAt: string | null; participants: string[] }
interface Member extends AuthUser { owner: boolean }
interface Props { room: Room; userId: string; onClose: () => void; onRoomUpdated: (room: Room) => void }
export function RoomTools({ room, userId, onClose, onRoomUpdated }: Props) {
  const [section, setSection] = useState<Section>('share'); const [feedback, setFeedback] = useState('');
  const [loading, setLoading] = useState(false);
  const [agenda, setAgenda] = useState<Agenda[]>([]); const [decisions, setDecisions] = useState<Decision[]>([]); const [actions, setActions] = useState<Action[]>([]); const [calls, setCalls] = useState<CallLog[]>([]);
  const [text, setText] = useState(''); const [members, setMembers] = useState<Member[]>([]); const [assigneeId, setAssigneeId] = useState(''); const [deadline, setDeadline] = useState('');
  const [name, setName] = useState(room.name); const [description, setDescription] = useState(room.description);
  const invite = `${window.location.origin}/join/${room.code}`;
  const loadMeeting = useCallback(() => {
    setLoading(true);
    void Promise.all([api<{ agenda: Agenda[]; decisions: Decision[]; actions: Action[] }>(`/rooms/${room.id}/meeting`), api<{ members: Member[] }>(`/rooms/${room.id}/members`)])
      .then(([result, people]) => { setAgenda(result.agenda); setDecisions(result.decisions); setActions(result.actions); setMembers(people.members); })
      .catch(error => setFeedback(error.message)).finally(() => setLoading(false));
  }, [room.id]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (section === 'meeting') loadMeeting();
      if (section === 'history') {
        setLoading(true);
        void api<{ calls: CallLog[] }>(`/rooms/${room.id}/calls`).then(result => setCalls(result.calls)).catch(error => setFeedback(error.message)).finally(() => setLoading(false));
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [section, room.id, loadMeeting]);
  const add = async (kind: 'agenda' | 'decisions' | 'actions') => { if (!text.trim()) return; await api(`/rooms/${room.id}/${kind}`, { method: 'POST', body: JSON.stringify(kind === 'agenda' || kind === 'decisions' ? { text } : { description: text, assigneeId: assigneeId || null, deadline }) }); setText(''); setDeadline(''); loadMeeting(); };
  const moveAgenda = async (index: number, direction: -1 | 1) => {
    const item = agenda[index]; const target = agenda[index + direction]; if (!item || !target) return;
    try {
      await Promise.all([
        api(`/rooms/${room.id}/agenda/${item.id}`, { method: 'PATCH', body: JSON.stringify({ position: target.position }) }),
        api(`/rooms/${room.id}/agenda/${target.id}`, { method: 'PATCH', body: JSON.stringify({ position: item.position }) }),
      ]); loadMeeting();
    } catch (error) { setFeedback(error instanceof Error ? error.message : 'Não foi possível reordenar a agenda.'); }
  };
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="room-tools" role="dialog" aria-modal="true"><header><nav>{(['share', 'meeting', 'history', 'room'] as Section[]).map(id => <button className={section === id ? 'is-active' : ''} key={id} onClick={() => { setSection(id); setLoading(false); }}>{id === 'share' ? 'Convidar' : id === 'meeting' ? 'Reunião' : id === 'history' ? 'Histórico' : 'Sala'}</button>)}</nav><button className="icon-button" onClick={onClose} aria-label="Fechar ferramentas"><Icon name="close" /></button></header>{feedback && <p className="settings-feedback">{feedback}</p>}
      {loading && <div className="tools-loading" aria-label="Carregando histórico"><i /><i /><i /></div>}
      {section === 'share' && <div className="tools-content share-panel"><h2>Convide sua equipe</h2><p>Quem abrir o link poderá entrar após autenticar uma conta.</p><div className="invite-link"><input readOnly value={invite} /><button onClick={() => void navigator.clipboard.writeText(invite).then(() => setFeedback('Link copiado.'))}><Icon name="copy" size={16} />Copiar</button></div><img className="qr-code" src={`${API_URL}/rooms/${room.id}/qr`} alt="QR code do convite" /><strong>Código: {room.code}</strong></div>}
      {section === 'meeting' && <div className="tools-content meeting-panel"><h2>Central da reunião</h2><p>Registre pauta, decisões e próximos passos. Marque uma pauta como resolvida sem chamada para reduzir reuniões.</p><div className="meeting-add"><input value={text} maxLength={500} onChange={event => setText(event.target.value)} placeholder="Novo item" /><button onClick={() => void add('agenda')}>+ Pauta</button><button onClick={() => void add('decisions')}>+ Decisão</button></div><div className="action-options"><select value={assigneeId} onChange={event => setAssigneeId(event.target.value)}><option value="">Sem responsável</option>{members.map(member => <option value={member.id} key={member.id}>{member.displayName}</option>)}</select><input type="date" value={deadline} onChange={event => setDeadline(event.target.value)} /><button onClick={() => void add('actions')}>+ Criar tarefa</button></div>
        <section><h3>Agenda</h3>{agenda.map((item, index) => <div className="meeting-row" key={item.id}><input aria-label={`Concluir ${item.text}`} type="checkbox" checked={item.completed} onChange={event => void api(`/rooms/${room.id}/agenda/${item.id}`, { method: 'PATCH', body: JSON.stringify({ completed: event.target.checked }) }).then(loadMeeting)} /><span className={item.completed ? 'is-done' : ''}>{item.text}</span><span className="agenda-order"><button disabled={index === 0} aria-label={`Mover ${item.text} para cima`} onClick={() => void moveAgenda(index, -1)}>↑</button><button disabled={index === agenda.length - 1} aria-label={`Mover ${item.text} para baixo`} onClick={() => void moveAgenda(index, 1)}>↓</button></span><button onClick={() => void api(`/rooms/${room.id}/agenda/${item.id}`, { method: 'PATCH', body: JSON.stringify({ resolvedAsync: !item.resolvedAsyncAt }) }).then(loadMeeting)}>{item.resolvedAsyncAt ? '🌿 Assíncrono' : 'Resolver sem reunião'}</button><button title="Excluir" onClick={() => void api(`/rooms/${room.id}/agenda/${item.id}`, { method: 'DELETE' }).then(loadMeeting)}>×</button></div>)}</section>
        <section><h3>Decisões</h3>{decisions.map(item => <div className="meeting-row" key={item.id}><span><strong>{item.text}</strong><small>{item.author} · {new Date(item.createdAt).toLocaleDateString('pt-BR')}</small></span></div>)}</section>
        <section><h3>Tarefas</h3>{actions.map(item => <div className="meeting-row" key={item.id}><input type="checkbox" checked={item.status === 'done'} onChange={event => void api(`/rooms/${room.id}/actions/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: event.target.checked ? 'done' : 'pending' }) }).then(loadMeeting)} /><span className={item.status === 'done' ? 'is-done' : ''}>{item.description}<small>{item.assignee?.displayName || 'Sem responsável'}{item.deadline ? ` · prazo ${new Date(item.deadline).toLocaleDateString('pt-BR')}` : ''}</small></span><button title="Excluir" onClick={() => void api(`/rooms/${room.id}/actions/${item.id}`, { method: 'DELETE' }).then(loadMeeting)}>×</button></div>)}</section>
      </div>}
      {section === 'history' && <div className="tools-content"><h2>Histórico de chamadas</h2>{!loading && !calls.length && <p>Nenhuma chamada registrada nesta sala.</p>}{calls.map(call => <div className="call-log" key={call.id}><strong>{new Date(call.startedAt).toLocaleString('pt-BR')}</strong><span>{call.endedAt ? `Duração ${formatDuration(call.startedAt, call.endedAt)}` : 'Em andamento'}</span><small>{call.participants.join(', ') || 'Sem participantes registrados'}</small></div>)}</div>}
      {section === 'room' && <div className="tools-content settings-form"><h2>Personalizar sala</h2>{room.createdBy.id !== userId ? <p>Somente {room.createdBy.displayName} pode alterar nome e descrição.</p> : <><label>Nome<input value={name} maxLength={60} onChange={event => setName(event.target.value)} /></label><label>Descrição<textarea value={description} maxLength={280} onChange={event => setDescription(event.target.value)} /></label><button className="primary-button" onClick={() => void api<{ room: Room }>(`/rooms/${room.id}`, { method: 'PATCH', body: JSON.stringify({ name, description }) }).then(result => { onRoomUpdated(result.room); setFeedback('Sala atualizada.'); }).catch(error => setFeedback(error.message))}>Salvar sala</button></>}</div>}
    </section></div>;
}
function formatDuration(start: string, end: string) { const minutes = Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000)); return `${minutes} min`; }
