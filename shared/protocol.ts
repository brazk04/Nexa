export type PresenceStatus = 'online' | 'busy' | 'dnd' | 'away';
export type ThemePreference = 'dark' | 'light' | 'system';
export interface AuthUser {
  id: string; username: string; displayName: string; email: string; birthDate: string;
  avatarUrl: string | null; emailVerified: boolean;
}
export interface UserPreferences {
  theme: ThemePreference; fontScale: number; density: 'comfortable' | 'compact'; reduceMotion: boolean;
  accent: 'violet' | 'blue' | 'green'; sounds: boolean; messageNotifications: boolean;
  mentionNotifications: boolean; callNotifications: boolean; doNotDisturb: boolean;
  status: PresenceStatus; cameraId: string; microphoneId: string; speakerId: string;
}
export interface Room {
  id: string; name: string; code: string; description: string; createdAt: string;
  createdBy: { id: string; username: string; displayName: string; avatarUrl: string | null };
  favorite: boolean; unreadCount: number; mentionCount: number; notificationsEnabled: boolean;
}
export interface MediaState { microphone: boolean; camera: boolean; screen: boolean }
export interface OnlineUser {
  userId: string; username: string; displayName: string; avatarUrl: string | null;
  socketId: string; inCall: boolean; status: PresenceStatus;
}
export interface CallParticipant extends OnlineUser, MediaState { attemptId: string; handRaisedAt: string | null }
export interface AttachmentInfo { id: string; name: string; mimeType: string; size: number; downloadUrl: string }
export interface MessageReply { id: number; autor: string; texto: string; deleted: boolean }
export interface Message {
  id: number; autor: string; displayName: string; avatarUrl: string | null; texto: string; sala: string;
  criadoEm: string; horario: string; userId?: string | null; editedAt: string | null; deleted: boolean;
  mentioned: boolean; replyTo: MessageReply | null; attachments: AttachmentInfo[];
  clientMessageId: string | null; deliveryStatus?: 'sending' | 'sent' | 'failed';
}
export interface RoomRequest { sala: string; requestId: string }
export interface CallRequest { sala: string; attemptId: string }
export interface RoomCall { sala: string; callId: string | null; startedAt: string | null; participants: CallParticipant[] }
export interface History { sala: string; requestId: string; mensagens: Message[]; hasMore: boolean }
export interface Presence { sala: string; users: OnlineUser[] }
export interface CallReaction { id: string; sala: string; callId: string; userId: string; username: string; displayName: string; emoji: string; createdAt: string }
export interface RoomNotification { roomId: string; messageId: number; mention: boolean; author: string; preview: string }
export interface CallNotification { roomId: string; callId: string; startedBy: string }
export interface RoomRemoved { roomId: string; reason: 'deleted' | 'left' }
export interface TypingUser { userId: string; displayName: string }
export type Result<T = undefined> = { ok: true; data: T } | { ok: false; error: string; code?: string };
export type Ack<T = undefined> = (result: Result<T>) => void;
export interface Description { type: 'offer' | 'answer'; sdp: string }
export interface IceCandidate { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null }
export interface SignalTarget { sala: string; callId: string; to: string }
export interface SignalSource { sala: string; callId: string; from: string }
export interface CallLeft { sala: string; callId: string; socketId: string; username: string; reason: 'manual' | 'room-change' | 'timeout' }
export interface CallConnectivity { sala: string; callId: string; socketId: string; userId: string; username: string; status: 'reconnecting' | 'connected' }
export interface ClientEvents {
  entrar_sala: (request: RoomRequest, ack: Ack) => void;
  mensagem_chat: (message: { sala: string; texto: string; replyToId?: number | null; clientMessageId?: string }, ack: Ack<Message>) => void;
  editar_mensagem: (request: { sala: string; messageId: number; texto: string }, ack: Ack<Message>) => void;
  excluir_mensagem: (request: { sala: string; messageId: number }, ack: Ack<Message>) => void;
  marcar_sala_lida: (request: { sala: string }) => void;
  entrar_chamada: (request: CallRequest, ack: Ack<RoomCall>) => void;
  sincronizar_chamada: (request: CallRequest, ack: Ack<RoomCall>) => void;
  sair_chamada: (request: CallRequest) => void;
  atualizar_midia: (request: CallRequest & MediaState) => void;
  atualizar_mao: (request: CallRequest & { raised: boolean }) => void;
  enviar_reacao: (request: CallRequest & { emoji: string }) => void;
  atualizar_status: (request: { status: PresenceStatus }) => void;
  atualizar_perfil: () => void;
  digitando: (request: { sala: string; typing: boolean }) => void;
  webrtc_offer: (data: SignalTarget & { offer: Description }) => void;
  webrtc_answer: (data: SignalTarget & { answer: Description }) => void;
  webrtc_ice_candidate: (data: SignalTarget & { candidate: IceCandidate }) => void;
}
export interface ServerEvents {
  historico_mensagens: (history: History) => void;
  nova_mensagem: (message: Message) => void;
  mensagem_atualizada: (message: Message) => void;
  usuarios_online: (presence: Presence) => void;
  sala_notificada: (notification: RoomNotification) => void;
  chamada_notificada: (notification: CallNotification) => void;
  sala_removida: (event: RoomRemoved) => void;
  usuarios_digitando: (event: { sala: string; users: TypingUser[] }) => void;
  chamada_atualizada: (call: RoomCall) => void;
  reacao_chamada: (reaction: CallReaction) => void;
  participante_saiu: (event: CallLeft) => void;
  conexao_participante: (event: CallConnectivity) => void;
  webrtc_offer: (data: SignalSource & { offer: Description }) => void;
  webrtc_answer: (data: SignalSource & { answer: Description }) => void;
  webrtc_ice_candidate: (data: SignalSource & { candidate: IceCandidate }) => void;
  erro_operacao: (message: string) => void;
}
