import { useEffect, useRef, useState } from 'react';
import type { AuthUser, UserPreferences } from '../../../shared/protocol';
import { api } from '../lib/api';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

type Tab = 'account' | 'appearance' | 'devices' | 'notifications' | 'security';
interface SessionInfo { id: string; current: boolean; createdAt: string; lastSeenAt: string; userAgent: string; ipAddress: string }
interface Props {
  user: AuthUser; preferences: UserPreferences; onSavePreferences: (value: UserPreferences) => Promise<UserPreferences>;
  onUser: (user: AuthUser | null) => void; onClose: () => void; loading?: boolean;
}
const tabs: { id: Tab; label: string }[] = [
  { id: 'account', label: 'Conta e perfil' }, { id: 'appearance', label: 'Aparência' },
  { id: 'devices', label: 'Áudio e vídeo' }, { id: 'notifications', label: 'Notificações' }, { id: 'security', label: 'Privacidade e segurança' },
];

function useMicrophoneLevel(stream: MediaStream | null) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!stream?.getAudioTracks().length) return;
    const context = new AudioContext(); const source = context.createMediaStreamSource(stream); const analyser = context.createAnalyser();
    analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.75; source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize); let frame = 0; let lastUpdate = 0;
    const watch = (time: number) => {
      analyser.getByteTimeDomainData(samples);
      if (time - lastUpdate > 80) {
        const peak = samples.reduce((highest, value) => Math.max(highest, Math.abs(value - 128)), 0);
        setLevel(Math.min(100, Math.round(peak / 0.45))); lastUpdate = time;
      }
      frame = requestAnimationFrame(watch);
    };
    frame = requestAnimationFrame(watch);
    return () => { cancelAnimationFrame(frame); source.disconnect(); void context.close(); };
  }, [stream]);
  return stream ? level : 0;
}

export function SettingsDialog({ user, preferences, onSavePreferences, onUser, onClose, loading = false }: Props) {
  const [tab, setTab] = useState<Tab>('account');
  const [draft, setDraft] = useState(preferences);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [birthDate, setBirthDate] = useState(user.birthDate);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const microphoneLevel = useMicrophoneLevel(preview);
  useEffect(() => { if (video.current) video.current.srcObject = preview; }, [preview]);
  useEffect(() => () => preview?.getTracks().forEach(track => track.stop()), [preview]);
  useEffect(() => { if (tab === 'security') void api<{ sessions: SessionInfo[] }>('/account/sessions').then(result => setSessions(result.sessions)); }, [tab]);
  useEffect(() => {
    if (tab !== 'devices' || !navigator.mediaDevices?.enumerateDevices) return;
    let active = true;
    const refresh = () => void navigator.mediaDevices.enumerateDevices().then(items => { if (active) setDevices(items); }).catch(() => undefined);
    refresh(); navigator.mediaDevices.addEventListener?.('devicechange', refresh);
    return () => { active = false; navigator.mediaDevices.removeEventListener?.('devicechange', refresh); };
  }, [tab]);
  const run = async (operation: () => Promise<void>, success: string) => {
    setBusy(true); setMessage(''); try { await operation(); setMessage(success); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível salvar.'); }
    finally { setBusy(false); }
  };
  const savePreferences = () => run(async () => { const saved = await onSavePreferences(draft); setDraft(saved); }, 'Preferências salvas.');
  const startPreview = async () => {
    preview?.getTracks().forEach(track => track.stop());
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: draft.cameraId ? { deviceId: { exact: draft.cameraId } } : true,
        audio: draft.microphoneId ? { deviceId: { exact: draft.microphoneId } } : true,
      });
      setPreview(stream); setDevices(await navigator.mediaDevices.enumerateDevices()); setMessage('Prévia ativa. Fale para testar o microfone.');
    } catch { setMessage('Não foi possível acessar câmera e microfone. Confira a permissão do navegador.'); }
  };
  const uploadAvatar = (file?: File) => {
    if (!file) return; const form = new FormData(); form.append('avatar', file);
    void run(async () => { const result = await api<{ user: AuthUser }>('/account/avatar', { method: 'POST', body: form }); onUser(result.user); }, 'Foto atualizada.');
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-dialog" role="dialog" aria-modal="true" aria-label="Configurações">
      <aside className="settings-nav"><h2>Configurações</h2>{tabs.map(item => <button key={item.id} className={tab === item.id ? 'is-active' : ''} onClick={() => { setTab(item.id); setMessage(''); }}>{item.label}</button>)}</aside>
      <div className="settings-content">
        <header><div><h2>{tabs.find(item => item.id === tab)?.label}</h2><p>As alterações ficam vinculadas à sua conta.</p></div><button className="icon-button" onClick={onClose} aria-label="Fechar"><Icon name="close" /></button></header>
        {message && <p className="settings-feedback" role="status">{message}</p>}
        {loading && <div className="settings-skeleton" aria-label="Carregando configurações"><i /><i /><i /><i /></div>}
        {!loading && tab === 'account' && <div className="settings-form">
          <div className="avatar-editor"><label className="avatar-preview" aria-label="Alterar foto de perfil"><Avatar name={user.displayName} url={user.avatarUrl} /><span className="avatar-edit-overlay"><Icon name="edit" size={16} /></span><input hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => uploadAvatar(event.target.files?.[0])} /></label><div><strong>Foto de perfil</strong><label className="secondary-button">Escolher imagem<input hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => uploadAvatar(event.target.files?.[0])} /></label>
            {user.avatarUrl && <button className="text-button" onClick={() => void run(async () => { const result = await api<{ user: AuthUser }>('/account/avatar', { method: 'DELETE' }); onUser(result.user); }, 'Foto removida.')}>Remover</button>}</div></div>
          <label>Nome de exibição<input value={displayName} maxLength={50} onChange={event => setDisplayName(event.target.value)} /></label>
          <label>Usuário<input value={`@${user.username}`} disabled /></label><label>Data de nascimento<input type="date" value={birthDate} onChange={event => setBirthDate(event.target.value)} /></label>
          <button className="primary-button" disabled={busy} onClick={() => void run(async () => { const result = await api<{ user: AuthUser }>('/account', { method: 'PATCH', body: JSON.stringify({ displayName, birthDate }) }); onUser(result.user); }, 'Perfil salvo.')}>Salvar perfil</button>
          <hr /><EmailChange /><hr /><PasswordChange />
        </div>}
        {!loading && tab === 'appearance' && <div className="settings-form">
          <label>Tema<select value={draft.theme} onChange={event => setDraft({ ...draft, theme: event.target.value as UserPreferences['theme'] })}><option value="system">Usar sistema</option><option value="dark">Escuro</option><option value="light">Claro</option></select></label>
          <label>Tamanho da fonte: {draft.fontScale}%<input type="range" min="85" max="125" step="5" value={draft.fontScale} onChange={event => setDraft({ ...draft, fontScale: Number(event.target.value) })} /></label>
          <label>Densidade<select value={draft.density} onChange={event => setDraft({ ...draft, density: event.target.value as UserPreferences['density'] })}><option value="comfortable">Confortável</option><option value="compact">Compacta</option></select></label>
          <label>Cor de destaque<select value={draft.accent} onChange={event => setDraft({ ...draft, accent: event.target.value as UserPreferences['accent'] })}><option value="violet">Violeta</option><option value="blue">Azul</option><option value="green">Verde</option></select></label>
          <Toggle label="Reduzir animações" checked={draft.reduceMotion} onChange={value => setDraft({ ...draft, reduceMotion: value })} /><button className="primary-button" onClick={() => void savePreferences()}>Salvar aparência</button>
        </div>}
        {!loading && tab === 'devices' && <div className="settings-form">
          <div className="device-preview">{preview ? <video ref={video} autoPlay muted playsInline /> : <span>Prévia da câmera</span>}</div>
          <div className="preview-controls"><button className="secondary-button" onClick={() => void startPreview()}>Testar câmera e microfone</button>{preview && <button className="text-button" onClick={() => setPreview(null)}>Encerrar teste</button>}</div>
          <div className="microphone-meter" aria-label={`Nível do microfone: ${microphoneLevel}%`}><span>Microfone</span><meter min="0" max="100" value={microphoneLevel} /><small>{microphoneLevel ? 'Sinal detectado' : 'Fale para testar'}</small></div>
          <label>Câmera<select value={draft.cameraId} onChange={event => setDraft({ ...draft, cameraId: event.target.value })}><option value="">Padrão do sistema</option>{devices.filter(item => item.kind === 'videoinput').map(item => <option key={item.deviceId} value={item.deviceId}>{item.label || 'Câmera'}</option>)}</select></label>
          <label>Microfone<select value={draft.microphoneId} onChange={event => setDraft({ ...draft, microphoneId: event.target.value })}><option value="">Padrão do sistema</option>{devices.filter(item => item.kind === 'audioinput').map(item => <option key={item.deviceId} value={item.deviceId}>{item.label || 'Microfone'}</option>)}</select></label>
          <label>Saída de áudio<select value={draft.speakerId} onChange={event => setDraft({ ...draft, speakerId: event.target.value })}><option value="">Padrão do sistema</option>{devices.filter(item => item.kind === 'audiooutput').map(item => <option key={item.deviceId} value={item.deviceId}>{item.label || 'Alto-falante'}</option>)}</select></label>
          <button className="primary-button" onClick={() => void savePreferences()}>Salvar dispositivos</button>
          <div className="shortcut-list"><h3>Atalhos durante chamadas</h3><span><kbd>M</kbd> Ativar ou silenciar microfone</span><span><kbd>V</kbd> Ligar ou desligar câmera</span><span><kbd>H</kbd> Levantar ou abaixar a mão</span><span><kbd>C</kbd> Abrir e focar o chat</span><span><kbd>Shift</kbd> + <kbd>F</kbd> Maximizar ou restaurar</span><span><kbd>Esc</kbd> Restaurar chamada maximizada</span></div>
        </div>}
        {!loading && tab === 'notifications' && <div className="settings-form">
          <Toggle label="Som do aplicativo" checked={draft.sounds} onChange={value => setDraft({ ...draft, sounds: value })} />
          <Toggle label="Novas mensagens" checked={draft.messageNotifications} onChange={value => setDraft({ ...draft, messageNotifications: value })} />
          <Toggle label="Menções" checked={draft.mentionNotifications} onChange={value => setDraft({ ...draft, mentionNotifications: value })} />
          <Toggle label="Chamadas" checked={draft.callNotifications} onChange={value => setDraft({ ...draft, callNotifications: value })} />
          <Toggle label="Não perturbe" checked={draft.doNotDisturb} onChange={value => setDraft({ ...draft, doNotDisturb: value, status: value ? 'dnd' : 'online' })} />
          <button className="primary-button" onClick={() => void savePreferences()}>Salvar notificações</button>
        </div>}
        {!loading && tab === 'security' && <div className="settings-form"><h3>Sessões ativas</h3>{sessions.map(session => <div className="session-row" key={session.id}><div><strong>{session.current ? 'Este dispositivo' : session.userAgent}</strong><small>{session.ipAddress} · visto em {new Date(session.lastSeenAt).toLocaleString('pt-BR')}</small></div></div>)}
          <button className="secondary-button" onClick={() => void run(async () => { await api('/account/sessions/others', { method: 'DELETE' }); const result = await api<{ sessions: SessionInfo[] }>('/account/sessions'); setSessions(result.sessions); }, 'Outras sessões encerradas.')}>Encerrar outras sessões</button>
          <hr /><DeleteAccount user={user} onDeleted={() => onUser(null)} />
        </div>}
      </div>
    </section>
  </div>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="toggle-row"><span>{label}</span><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /></label>;
}
function EmailChange() {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [feedback, setFeedback] = useState('');
  return <div><h3>Alterar e-mail</h3><label>Novo e-mail<input type="email" value={email} onChange={event => setEmail(event.target.value)} /></label><label>Senha atual<input type="password" value={password} onChange={event => setPassword(event.target.value)} /></label><button className="secondary-button" onClick={() => void api<{ message: string }>('/account/email', { method: 'POST', body: JSON.stringify({ email, password }) }).then(result => setFeedback(result.message)).catch(error => setFeedback(error.message))}>Enviar confirmação</button>{feedback && <small>{feedback}</small>}</div>;
}
function PasswordChange() {
  const [currentPassword, setCurrent] = useState(''); const [newPassword, setNext] = useState(''); const [feedback, setFeedback] = useState('');
  return <div><h3>Alterar senha</h3><label>Senha atual<input type="password" value={currentPassword} onChange={event => setCurrent(event.target.value)} /></label><label>Nova senha<input type="password" minLength={8} value={newPassword} onChange={event => setNext(event.target.value)} /></label><button className="secondary-button" onClick={() => void api<{ message: string }>('/account/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }).then(result => setFeedback(result.message)).catch(error => setFeedback(error.message))}>Alterar senha</button>{feedback && <small>{feedback}</small>}</div>;
}
function DeleteAccount({ user, onDeleted }: { user: AuthUser; onDeleted: () => void }) {
  const [confirmation, setConfirmation] = useState(''); const [password, setPassword] = useState(''); const [feedback, setFeedback] = useState('');
  return <div className="danger-zone"><h3>Excluir conta</h3><p>Esta ação remove permanentemente sua conta e as salas que você criou.</p><label>Digite {user.username}<input value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label><label>Senha<input type="password" value={password} onChange={event => setPassword(event.target.value)} /></label><button disabled={confirmation !== user.username || !password} onClick={() => void api('/account', { method: 'DELETE', body: JSON.stringify({ confirmation, password }) }).then(onDeleted).catch(error => setFeedback(error.message))}>Excluir permanentemente</button>{feedback && <small>{feedback}</small>}</div>;
}
