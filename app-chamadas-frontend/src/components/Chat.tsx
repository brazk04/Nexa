import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AttachmentInfo, Message, Room, TypingUser } from '../../../shared/protocol';
import { api, API_URL } from '../lib/api';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

interface Props {
  room: Room;
  messages: Message[];
  ready: boolean;
  userId: string;
  typingUsers: TypingUser[];
  hasMore: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => Promise<void>;
  onTyping: (typing: boolean) => void;
  send: (text: string, replyToId?: number | null) => Promise<void>;
  retry: (clientMessageId: string) => Promise<void>;
  edit: (id: number, text: string) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

const GROUP_WINDOW = 5 * 60 * 1000;
type MessageItem = { message: Message; dateDivider: boolean; grouped: boolean };

const MessageRows = memo(function MessageRows({ items, userId, onReply, onEdit, onDelete, onPreview, onRetry }: {
  items: MessageItem[]; userId: string; onReply: (message: Message) => void; onEdit: (message: Message) => void;
  onDelete: (message: Message) => void; onPreview: (attachment: AttachmentInfo) => void; onRetry: (clientMessageId: string) => void;
}) {
  return <>{items.map(({ message, dateDivider, grouped }) => <div className="message-cluster" key={message.clientMessageId || message.id}>
    {dateDivider && <div className="date-divider"><span>{formatDateDivider(message.criadoEm)}</span></div>}
    <article className={`message ${grouped ? 'is-grouped' : ''} ${message.userId === userId ? 'is-own' : ''} ${message.mentioned ? 'is-mentioned' : ''} delivery-${message.deliveryStatus || 'sent'}`}>
      <div className="message-avatar">{grouped ? <time className="grouped-time" dateTime={message.criadoEm}>{formatTime(message.criadoEm)}</time> : <Avatar name={message.displayName} url={message.avatarUrl} />}</div>
      <div className="message-body">
        {!grouped && <div className="message-meta"><strong>{message.displayName}</strong><small>@{message.autor}</small><time dateTime={message.criadoEm}>{formatTime(message.criadoEm)}</time>{message.editedAt && <small>(editada)</small>}</div>}
        {message.replyTo && <blockquote><strong>@{message.replyTo.autor}</strong><span>{message.replyTo.deleted ? 'Mensagem excluída' : message.replyTo.texto}</span></blockquote>}
        <p>{message.deleted ? <em>Mensagem excluída</em> : highlightMentions(message.texto)}</p>
        {!!message.attachments.length && <div className="attachment-list">{message.attachments.map(attachment => <Attachment key={attachment.id} attachment={attachment} onPreview={onPreview} />)}</div>}
        {message.deliveryStatus === 'sending' && <small className="delivery-state" role="status">Enviando…</small>}
        {message.deliveryStatus === 'failed' && <small className="delivery-state is-failed" role="alert">Falha no envio. <button type="button" onClick={() => message.clientMessageId && onRetry(message.clientMessageId)}>Tentar novamente</button></small>}
      </div>
      {!message.deleted && message.deliveryStatus !== 'sending' && message.deliveryStatus !== 'failed' && <div className="message-actions">
        <button type="button" onClick={() => onReply(message)} aria-label="Responder mensagem" data-tooltip="Responder"><span aria-hidden="true">↩</span></button>
        {message.userId === userId && <><button type="button" onClick={() => onEdit(message)} aria-label="Editar mensagem" data-tooltip="Editar"><Icon name="edit" size={15} /></button><button type="button" onClick={() => onDelete(message)} aria-label="Excluir mensagem" data-tooltip="Excluir"><Icon name="close" size={15} /></button></>}
      </div>}
    </article>
  </div>)}</>;
});

export function Chat({ room, messages, ready, userId, typingUsers, hasMore, loadingEarlier, onLoadEarlier, onTyping, send, retry, edit, remove }: Props) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Message[] | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [reply, setReply] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [lightbox, setLightbox] = useState<AttachmentInfo | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Message | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [newMessages, setNewMessages] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const previousCount = useRef(messages.length);
  const typing = useRef(false);
  const typingTimer = useRef<number | undefined>(undefined);
  const loadingHistory = useRef(false);

  const scrollToBottom = useCallback((smooth = true) => {
    viewport.current?.scrollTo({
      top: viewport.current.scrollHeight,
      behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto',
    });
    nearBottom.current = true;
    setNewMessages(0);
  }, []);

  useEffect(() => {
    const difference = messages.length - previousCount.current;
    previousCount.current = messages.length;
    if (query || difference <= 0) return;
    if (nearBottom.current) window.requestAnimationFrame(() => scrollToBottom());
    else setNewMessages(count => count + difference);
  }, [messages.length, query, scrollToBottom]);

  useEffect(() => {
    const area = input.current;
    if (!area) return;
    area.style.height = '0px';
    area.style.height = `${Math.min(area.scrollHeight, 144)}px`;
  }, [draft]);

  useEffect(() => {
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    if (!ready || editing || !draft.trim()) {
      if (typing.current) onTyping(false);
      typing.current = false;
      return;
    }
    if (!typing.current) onTyping(true);
    typing.current = true;
    typingTimer.current = window.setTimeout(() => {
      onTyping(false);
      typing.current = false;
    }, 1400);
    return () => { if (typingTimer.current) window.clearTimeout(typingTimer.current); };
  }, [draft, editing, onTyping, ready]);

  useEffect(() => () => {
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    if (typing.current) onTyping(false);
  }, [onTyping]);

  useEffect(() => {
    if (query.trim().length < 2) return;
    let active = true;
    const timer = window.setTimeout(() => void api<{ messages: Message[] }>(`/rooms/${room.id}/messages/search?q=${encodeURIComponent(query.trim())}`)
      .then(value => { if (active) setResults(value.messages); })
      .catch(failure => { if (active) setError(failure.message); }), 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, room.id]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if ((!draft.trim() && !file) || !ready || sending) return;
    setError('');
    if (typing.current) onTyping(false);
    typing.current = false;
    if (!editing && !file) {
      const text = draft; const replyToId = reply?.id;
      setDraft(''); setReply(null);
      window.requestAnimationFrame(() => input.current?.focus());
      void send(text, replyToId).catch(failure => setError(failure instanceof Error ? failure.message : 'Não foi possível enviar.'));
      return;
    }
    setSending(true);
    try {
      if (editing) await edit(editing.id, draft);
      else if (file) {
        const form = new FormData();
        form.append('file', file); form.append('text', draft);
        if (reply) form.append('replyToId', String(reply.id));
        await api(`/rooms/${room.id}/attachments`, { method: 'POST', body: form });
      } else await send(draft, reply?.id);
      setDraft(''); setReply(null); setEditing(null); setFile(null);
      window.requestAnimationFrame(() => {
        input.current?.focus();
        const position = input.current?.value.length ?? 0;
        input.current?.setSelectionRange(position, position);
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível enviar.');
    } finally { setSending(false); }
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault(); void submit();
    }
  };
  const shown = useMemo(() => query ? results ?? [] : messages, [messages, query, results]);
  const activeTypers = typingUsers.filter(user => user.userId !== userId);
  const typingLabel = formatTyping(activeTypers);
  const items = useMemo(() => shown.map((message, index) => {
    const previous = shown[index - 1];
    return {
      message,
      dateDivider: !previous || !sameDay(previous.criadoEm, message.criadoEm),
      grouped: Boolean(previous && previous.userId === message.userId && sameDay(previous.criadoEm, message.criadoEm)
        && new Date(message.criadoEm).getTime() - new Date(previous.criadoEm).getTime() <= GROUP_WINDOW),
    };
  }), [shown]);
  const chooseReply = useCallback((message: Message) => { setReply(message); setEditing(null); input.current?.focus(); }, []);
  const chooseEdit = useCallback((message: Message) => { setEditing(message); setReply(null); setDraft(message.texto); input.current?.focus(); }, []);
  const chooseDelete = useCallback((message: Message) => setPendingDelete(message), []);
  const retryFailed = useCallback((clientMessageId: string) => {
    void retry(clientMessageId).catch(failure => setError(failure instanceof Error ? failure.message : 'Não foi possível reenviar.'));
  }, [retry]);

  return <section className="chat" aria-label={`Conversa em ${room.name}`}>
    <div className="chat-toolbar">
      <span>Conversa</span>
      <label className="search-field"><Icon name="search" size={16} /><span className="sr-only">Buscar mensagens</span><input value={query} onChange={event => { setQuery(event.target.value); setResults(null); }} placeholder="Buscar no histórico" /></label>
    </div>
    <div className="message-feed" ref={viewport} role="log" aria-live="polite" onScroll={event => {
      const target = event.currentTarget;
      nearBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
      if (nearBottom.current && newMessages) setNewMessages(0);
      if (target.scrollTop < 80 && hasMore && !loadingEarlier && !loadingHistory.current) {
        const previousHeight = target.scrollHeight; loadingHistory.current = true;
        void onLoadEarlier().then(() => window.requestAnimationFrame(() => {
          if (viewport.current) viewport.current.scrollTop += viewport.current.scrollHeight - previousHeight;
          loadingHistory.current = false;
        })).catch(failure => { loadingHistory.current = false; setError(failure instanceof Error ? failure.message : 'Não foi possível carregar mensagens anteriores.'); });
      }
    }}>
      {!query && (hasMore || loadingEarlier) && <button className="history-loader" type="button" disabled={loadingEarlier} onClick={() => void onLoadEarlier()}>{loadingEarlier ? 'Carregando mensagens anteriores…' : 'Carregar mensagens anteriores'}</button>}
      {!query && <div className="channel-intro"><span className="intro-symbol">#</span><h2>{room.name}</h2><p>{room.description}</p>{ready && !messages.length && <p className="empty-prompt">O canal está pronto. Envie a primeira mensagem.</p>}</div>}
      {query && <p className="search-summary">{results ? `${results.length} resultado(s) no histórico` : query.length < 2 ? 'Digite ao menos 2 caracteres' : 'Buscando…'}</p>}
      <MessageRows items={items} userId={userId} onReply={chooseReply} onEdit={chooseEdit} onDelete={chooseDelete} onPreview={setLightbox} onRetry={retryFailed} />
      {query && results?.length === 0 && <div className="feed-empty"><Icon name="search" size={24} /><strong>Nenhuma mensagem encontrada</strong><span>Tente buscar por outro termo.</span></div>}
      {!ready && !messages.length && <div className="message-skeleton" aria-label="Carregando mensagens"><i /><span><b /><b /></span><i /><span><b /><b /></span></div>}
      {!ready && messages.length > 0 && <p className="feed-status">Reconectando ao canal…</p>}
    </div>
    {newMessages > 0 && <button className="new-messages-button" type="button" onClick={() => scrollToBottom()}><span aria-hidden="true">↓</span> {newMessages} {newMessages === 1 ? 'nova mensagem' : 'novas mensagens'}</button>}
    <form className="composer-wrap" onSubmit={submit}>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {(reply || editing || file) && <div className="composer-context"><div><small>{editing ? 'Editando mensagem' : reply ? `Respondendo a @${reply.autor}` : 'Arquivo selecionado'}</small><span>{reply ? reply.texto : editing ? editing.texto : file?.name}</span></div><button type="button" aria-label="Cancelar contexto" onClick={() => { setReply(null); setEditing(null); setFile(null); if (editing) setDraft(''); }}><Icon name="close" size={16} /></button></div>}
      <div className="composer">
        <label className="attach-button" data-tooltip="Anexar arquivo" aria-label="Anexar arquivo"><Icon name="paperclip" size={20} /><input hidden type="file" onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
        <textarea aria-label={`Mensagem para ${room.name}`} ref={input} rows={1} maxLength={4000} value={draft} disabled={!ready || sending} onChange={event => setDraft(event.target.value)} onKeyDown={keyDown} placeholder={ready ? `Escreva em #${room.name}. Use @usuario para mencionar.` : 'Aguardando conexão…'} />
        <button aria-label="Enviar mensagem" className="send-button" type="submit" disabled={!ready || sending || (!draft.trim() && !file)}><Icon name="send" size={20} /></button>
      </div>
      <div className="composer-footer"><span className="typing-status" aria-live="polite">{typingLabel || (sending ? 'Enviando…' : 'Enter envia · Shift + Enter quebra a linha')}</span><span>{draft.length}/4000</span></div>
    </form>
    {lightbox && <ImageLightbox attachment={lightbox} onClose={() => setLightbox(null)} />}
    {pendingDelete && <div className="inline-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !deleting) setPendingDelete(null); }}><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-message-title"><span className="confirm-icon"><Icon name="warning" size={20} /></span><h2 id="delete-message-title">Excluir mensagem?</h2><p>Esta ação remove o conteúdo da conversa para todos os participantes.</p><div className="confirm-actions"><button type="button" className="secondary-button" disabled={deleting} onClick={() => setPendingDelete(null)}>Cancelar</button><button type="button" className="danger-button" disabled={deleting} onClick={() => { setDeleting(true); void remove(pendingDelete.id).then(() => setPendingDelete(null)).catch(failure => setError(failure instanceof Error ? failure.message : 'Não foi possível excluir.')).finally(() => setDeleting(false)); }}>{deleting ? 'Excluindo…' : 'Excluir mensagem'}</button></div></section></div>}
  </section>;
}

function Attachment({ attachment, onPreview }: { attachment: AttachmentInfo; onPreview: (attachment: AttachmentInfo) => void }) {
  const isImage = attachment.mimeType.startsWith('image/');
  const icon = isImage ? 'image' : attachment.mimeType.includes('zip') || attachment.mimeType.includes('compressed') ? 'archive' : 'file';
  const href = `${API_URL}${attachment.downloadUrl}`;
  if (isImage) return <button type="button" className="message-attachment is-image image-attachment-button" onClick={() => onPreview(attachment)} aria-label={'Visualizar imagem ' + attachment.name}>
    <img src={href} alt="" loading="lazy" decoding="async" /><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size)} · Abrir imagem</small></span>
  </button>;
  return <a className={`message-attachment ${isImage ? 'is-image' : ''}`} href={href} target="_blank" rel="noreferrer">
    {isImage && <img src={href} alt="" loading="lazy" />}
    <span className="attachment-icon"><Icon name={icon} size={19} /></span>
    <span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size)}</small></span>
  </a>;
}

function ImageLightbox({ attachment, onClose }: { attachment: AttachmentInfo; onClose: () => void }) {
  const href = API_URL + attachment.downloadUrl;
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  return <div className="image-lightbox" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="image-lightbox-dialog" role="dialog" aria-modal="true" aria-label={'Visualização de ' + attachment.name}>
      <header><strong>{attachment.name}</strong><button type="button" aria-label="Fechar visualização" onClick={onClose}><Icon name="close" size={18} /></button></header>
      <div className="image-lightbox-stage"><img src={href} alt={attachment.name} decoding="async" /></div>
      <footer><span>{formatBytes(attachment.size)}</span><a className="primary-button" href={href} download={attachment.name} target="_blank" rel="noreferrer"><Icon name="file" size={16} />Baixar imagem</a></footer>
    </section>
  </div>;
}

function sameDay(first: string, second: string) { return new Date(first).toDateString() === new Date(second).toDateString(); }
function formatTime(value: string) { return new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
function formatDateDivider(value: string) {
  const date = new Date(value); const today = new Date(); const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Hoje';
  if (date.toDateString() === yesterday.toDateString()) return 'Ontem';
  return date.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
function formatTyping(users: TypingUser[]) {
  if (!users.length) return '';
  if (users.length === 1) return `${users[0].displayName} está digitando…`;
  if (users.length === 2) return `${users[0].displayName} e ${users[1].displayName} estão digitando…`;
  return `${users[0].displayName} e mais ${users.length - 1} pessoas estão digitando…`;
}
function formatBytes(size: number) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`; }
function highlightMentions(text: string) {
  return text.split(/(@[\p{L}\p{N}_.-]{3,32})/gu).map((part, index) => /^@[\p{L}\p{N}_.-]{3,32}$/u.test(part) ? <mark key={index}>{part}</mark> : part);
}
