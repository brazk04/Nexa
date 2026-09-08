import type { AppSocket } from './socket';
import { api } from './api';
import type { CallLeft, CallParticipant, CallReaction, Description, IceCandidate, MediaState, Result, RoomCall, SignalSource } from '../../../shared/protocol';

export type CallPhase = 'idle' | 'media' | 'waiting' | 'connecting' | 'connected' | 'reconnecting';
export interface CallState extends MediaState {
  phase: CallPhase;
  localStream: MediaStream | null;
  remoteStreams: Record<string, MediaStream>;
  participants: CallParticipant[];
  startedAt: string | null;
  reactions: CallReaction[];
  ecoMode: boolean;
  quality: 'high' | 'medium' | 'low';
  microphoneBusy: boolean;
  cameraBusy: boolean;
  sharingBusy: boolean;
  notice: string;
  error: string;
}
interface PeerContext {
  connection: RTCPeerConnection;
  candidates: IceCandidate[];
  chain: Promise<void>;
  audioSender: RTCRtpSender;
  videoSender: RTCRtpSender | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
}
const idleState = (): CallState => ({
  phase: 'idle', localStream: null, remoteStreams: {}, participants: [], startedAt: null,
  reactions: [], ecoMode: false, quality: 'high',
  microphone: false, camera: false, screen: false,
  microphoneBusy: false, cameraBusy: false, sharingBusy: false, notice: '', error: '',
});
type UserMediaKind = 'camera' | 'microphone';
function userMediaError(error: unknown, kind: UserMediaKind) {
  const label = kind === 'camera' ? 'câmera' : 'microfone';
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return `O acesso ao ${label} foi bloqueado. Permita-o nas configurações do navegador e tente novamente.`;
  if (name === 'NotFoundError') return `${kind === 'camera' ? 'Câmera não encontrada' : 'Microfone não encontrado'}. Conecte o dispositivo e tente novamente.`;
  if (name === 'NotReadableError') return `Não foi possível usar o ${label}. Feche outros aplicativos que possam estar usando o dispositivo.`;
  return `Não foi possível ativar o ${label}. Confira o dispositivo e tente novamente.`;
}
function mediaError(error: unknown, display = false) {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return display
    ? 'Compartilhamento cancelado ou não permitido. Você pode tentar novamente.'
    : 'Câmera ou microfone bloqueados. Permita o acesso nas configurações do navegador e tente novamente.';
  if (name === 'NotFoundError') return 'Câmera ou microfone não encontrados. Conecte os dispositivos e tente novamente.';
  if (name === 'NotReadableError') return 'Não foi possível usar o dispositivo. Feche outros aplicativos que estejam usando a câmera ou o microfone.';
  return display ? 'Não foi possível compartilhar a tela. Escolha outra janela e tente novamente.'
    : 'Não foi possível iniciar áudio e vídeo. Confira seus dispositivos e tente novamente.';
}

/** Owns every call resource. The generation counter invalidates late asynchronous work after teardown. */
export class CallController {
  private socket: AppSocket;
  private state = idleState();
  private listeners = new Set<() => void>();
  private generation = 0;
  private room = '';
  private attemptId = '';
  private callId = '';
  private peers = new Map<string, PeerContext>();
  private cameraStream: MediaStream | null = null;
  private displayStream: MediaStream | null = null;
  private screenOperation = false;
  private devices = { cameraId: '', microphoneId: '' };
  private deviceChanges: Promise<void> = Promise.resolve();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private reactionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private iceServers: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

  constructor(socket: AppSocket) { this.socket = socket; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<CallState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  private current(generation: number) { return generation === this.generation && this.state.phase !== 'idle'; }
  private target(peerId: string) { return { sala: this.room, callId: this.callId, to: peerId }; }
  private participant(peerId: string) { return this.state.participants.find(item => item.socketId === peerId); }
  private publishMedia() {
    if (this.socket.connected && this.callId) this.socket.emit('atualizar_midia', {
      sala: this.room, attemptId: this.attemptId,
      microphone: this.state.microphone, camera: this.state.camera, screen: this.state.screen,
    });
  }
  dismissNotice = () => this.update({ error: '', notice: '' });
  configureDevices = (devices: { cameraId?: string; microphoneId?: string }) => {
    const previous = this.devices;
    this.devices = { cameraId: devices.cameraId ?? '', microphoneId: devices.microphoneId ?? '' };
    const next = this.devices;
    const generation = this.generation;
    this.deviceChanges = this.deviceChanges.then(async () => {
      if (!this.current(generation)) return;
      if (previous.microphoneId !== next.microphoneId) await this.switchDevice('microphone', next.microphoneId, generation);
      if (previous.cameraId !== next.cameraId) await this.switchDevice('camera', next.cameraId, generation);
    }).catch(() => { if (this.current(generation)) this.update({ error: 'Não foi possível trocar o dispositivo. Tente novamente.' }); });
  };

  private refreshLocalStream() {
    this.update({ localStream: new MediaStream([
      ...(this.cameraStream?.getAudioTracks() ?? []),
      ...((this.displayStream ?? this.cameraStream)?.getVideoTracks() ?? []),
    ]) });
  }
  private async switchDevice(kind: UserMediaKind, deviceId: string, generation: number) {
    const oldTrack = kind === 'microphone' ? this.cameraStream?.getAudioTracks()[0] : this.cameraStream?.getVideoTracks()[0];
    // Selecting a device must never acquire media before explicit activation.
    if (!oldTrack || !this.current(generation)) return;
    if (kind === 'camera' && this.screenOperation) { this.update({ notice: 'Aguarde o compartilhamento terminar de mudar e selecione a câmera novamente.' }); return; }
    this.update(kind === 'microphone' ? { microphoneBusy: true } : { cameraBusy: true });
    let replacement: MediaStreamTrack | undefined;
    const senders = () => [...this.peers.values()].map(peer => kind === 'microphone' ? peer.audioSender : this.displayStream ? null : peer.videoSender).filter((sender): sender is RTCRtpSender => Boolean(sender));
    try {
      const constraint = deviceId ? { deviceId: { exact: deviceId } } : true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: kind === 'microphone' ? constraint : false, video: kind === 'camera' ? constraint : false });
      replacement = kind === 'microphone' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
      stream.getTracks().filter(track => track !== replacement).forEach(track => track.stop());
      if (!replacement) throw new Error('MissingTrack');
      if (!this.current(generation)) { replacement.stop(); oldTrack.onended = null; oldTrack.stop(); return; }
      replacement.enabled = oldTrack.enabled;
      this.cameraStream?.removeTrack(oldTrack); this.cameraStream?.addTrack(replacement);
      await Promise.all(senders().map(sender => sender.replaceTrack(replacement!)));
      if (!this.current(generation)) { replacement.stop(); oldTrack.onended = null; oldTrack.stop(); return; }
      const track = replacement;
      track.onended = () => this.onDeviceEnded(kind, track, generation);
      oldTrack.onended = null; oldTrack.stop();
      this.refreshLocalStream(); this.publishMedia();
    } catch (error) {
      if (this.current(generation)) {
        if (replacement) this.cameraStream?.removeTrack(replacement);
        this.cameraStream?.addTrack(oldTrack);
        await Promise.all(senders().map(sender => sender.replaceTrack(oldTrack).catch(() => undefined)));
        this.update({ error: userMediaError(error, kind) });
      }
      replacement?.stop();
      if (!this.current(generation)) { oldTrack.onended = null; oldTrack.stop(); }
    } finally { if (this.current(generation)) this.update(kind === 'microphone' ? { microphoneBusy: false } : { cameraBusy: false }); }
  }

  private clearPeerTimers(context: PeerContext) {
    if (context.disconnectTimer) clearTimeout(context.disconnectTimer);
    if (context.handshakeTimer) clearTimeout(context.handshakeTimer);
    context.disconnectTimer = null; context.handshakeTimer = null;
  }
  private closePeer(peerId: string) {
    const context = this.peers.get(peerId);
    if (!context) return;
    this.clearPeerTimers(context);
    context.connection.onicecandidate = null;
    context.connection.ontrack = null;
    context.connection.onconnectionstatechange = null;
    context.connection.oniceconnectionstatechange = null;
    context.connection.close();
    this.peers.delete(peerId);
    const stream = this.state.remoteStreams[peerId];
    stream?.getTracks().forEach(track => track.stop());
    const remoteStreams = { ...this.state.remoteStreams };
    delete remoteStreams[peerId];
    this.update({ remoteStreams });
  }
  leave = (notice = 'Chamada encerrada.', notify = true) => {
    ++this.generation;
    if (notify && this.socket.connected && this.attemptId) this.socket.emit('sair_chamada', { sala: this.room, attemptId: this.attemptId });
    for (const peerId of [...this.peers.keys()]) this.closePeer(peerId);
    for (const stream of [this.cameraStream, this.displayStream]) stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.peers.clear(); this.cameraStream = null; this.displayStream = null;
    if (this.statsTimer) clearInterval(this.statsTimer); this.statsTimer = null;
    for (const timer of this.reactionTimers.values()) clearTimeout(timer); this.reactionTimers.clear();
    this.attemptId = ''; this.callId = ''; this.room = ''; this.screenOperation = false;
    this.update({ ...idleState(), notice });
  };
  private fail(message: string) { this.leave('', true); this.update({ error: message }); }

  private updatePhase() {
    if (this.state.phase === 'idle' || this.state.phase === 'media') return;
    if (this.peers.size === 0) { this.update({ phase: 'waiting' }); return; }
    const values = [...this.peers.values()];
    if (values.some(context => context.connection.connectionState === 'connected')) this.update({ phase: 'connected', quality: 'high' });
    else if (values.some(context => context.connection.connectionState === 'disconnected')) this.update({ phase: 'reconnecting', quality: 'low' });
    else this.update({ phase: 'connecting', quality: 'medium' });
  }
  private makePeer(peerId: string, generation: number) {
    const existing = this.peers.get(peerId);
    if (existing) return existing;
    const connection = new RTCPeerConnection({ iceServers: this.iceServers });
    const audioTrack = this.cameraStream?.getAudioTracks()[0];
    const videoTrack = this.displayStream?.getVideoTracks()[0] ?? this.cameraStream?.getVideoTracks()[0];
    const audioSender = connection.addTransceiver(audioTrack ?? 'audio', {
      direction: 'sendrecv', streams: this.cameraStream ? [this.cameraStream] : [],
    }).sender;
    const videoSender = connection.addTransceiver(videoTrack ?? 'video', {
      direction: 'sendrecv', streams: (this.displayStream ?? this.cameraStream) ? [this.displayStream ?? this.cameraStream!] : [],
    }).sender;
    const context: PeerContext = { connection, candidates: [], chain: Promise.resolve(), audioSender, videoSender, disconnectTimer: null, handshakeTimer: null };
    this.peers.set(peerId, context);
    if (context.videoSender && this.state.ecoMode) void this.setSenderQuality(context.videoSender, 350_000, 2);
    connection.onicecandidate = event => {
      if (this.current(generation) && event.candidate) this.socket.emit('webrtc_ice_candidate', { ...this.target(peerId), candidate: event.candidate.toJSON() as IceCandidate });
    };
    connection.ontrack = event => {
      if (!this.current(generation) || this.peers.get(peerId) !== context) return;
      const current = this.state.remoteStreams[peerId];
      // Audio and screen video can have different SDP stream IDs. Own one
      // aggregate per peer instead of replacing audio with the last event stream.
      const tracks = (current?.getTracks() ?? []).filter(track => track.kind !== event.track.kind && track.readyState !== 'ended');
      const stream = new MediaStream([...tracks, event.track]);
      this.update({ remoteStreams: { ...this.state.remoteStreams, [peerId]: stream } });
    };
    const onState = () => {
      if (!this.current(generation) || !this.peers.has(peerId)) return;
      const failed = connection.connectionState === 'failed' || connection.iceConnectionState === 'failed';
      if (failed || connection.connectionState === 'closed') {
        const name = this.participant(peerId)?.username ?? 'Um participante';
        this.closePeer(peerId); this.update({ notice: `${name} perdeu a conexão com a chamada.` }); this.updatePhase(); return;
      }
      if (connection.connectionState === 'disconnected' || connection.iceConnectionState === 'disconnected') {
        this.updatePhase();
        if (!context.disconnectTimer) context.disconnectTimer = setTimeout(() => {
          if (!this.current(generation) || !this.peers.has(peerId)) return;
          const name = this.participant(peerId)?.username ?? 'Um participante';
          this.closePeer(peerId); this.update({ notice: `${name} saiu após perder a conexão.` }); this.updatePhase();
        }, 10_000);
      } else if (connection.connectionState === 'connected') { this.clearPeerTimers(context); this.updatePhase(); }
    };
    connection.onconnectionstatechange = onState;
    connection.oniceconnectionstatechange = onState;
    return context;
  }
  private armHandshake(peerId: string, generation: number) {
    const context = this.peers.get(peerId);
    if (!context || context.handshakeTimer) return;
    context.handshakeTimer = setTimeout(() => {
      if (!this.current(generation) || !this.peers.has(peerId)) return;
      const name = this.participant(peerId)?.username ?? 'um participante';
      this.closePeer(peerId); this.update({ notice: `Não foi possível conectar com ${name}.` }); this.updatePhase();
    }, 30_000);
  }
  private queuePeer(peerId: string, task: (context: PeerContext, generation: number) => Promise<void>) {
    const generation = this.generation;
    const context = this.makePeer(peerId, generation);
    context.chain = context.chain.then(async () => { if (this.current(generation) && this.peers.get(peerId) === context) await task(context, generation); }).catch(error => {
      console.error('Falha na sinalização:', error instanceof Error ? error.name : 'UnknownError');
      if (this.current(generation) && this.peers.get(peerId) === context) { this.closePeer(peerId); this.update({ notice: 'Não foi possível negociar com um participante.' }); this.updatePhase(); }
    });
  }
  private flushCandidates = async (context: PeerContext, generation: number) => {
    const pending = context.candidates.splice(0);
    for (const candidate of pending) { if (!this.current(generation)) return; await context.connection.addIceCandidate(candidate); }
  };
  private offerTo(peerId: string) {
    this.queuePeer(peerId, async (context, generation) => {
      this.armHandshake(peerId, generation);
      const offer = await context.connection.createOffer();
      if (!this.current(generation)) return;
      await context.connection.setLocalDescription(offer);
      if (this.current(generation)) this.socket.emit('webrtc_offer', { ...this.target(peerId), offer: { type: 'offer', sdp: offer.sdp! } });
    });
  }

  join = async (sala: string) => {
    if (this.state.phase !== 'idle' || !this.socket.connected) return;
    const generation = ++this.generation;
    this.room = sala; this.attemptId = crypto.randomUUID();
    this.update({ ...idleState(), phase: 'media' });
    try {
      const configuration = await api<{ iceServers: RTCIceServer[] }>('/rtc/ice-servers').catch(() => null);
      if (configuration?.iceServers.length) this.iceServers = configuration.iceServers;
      if (!this.current(generation)) return;
      const stream = new MediaStream();
      this.cameraStream = stream; this.update({ localStream: stream });
      const result: Result<RoomCall> = await this.socket.timeout(10_000).emitWithAck('entrar_chamada', { sala, attemptId: this.attemptId });
      if (!this.current(generation)) return;
      if (!result.ok) { this.fail(result.error); return; }
      this.callId = result.data.callId!;
      this.update({ participants: result.data.participants, startedAt: result.data.startedAt, phase: result.data.participants.length > 1 ? 'connecting' : 'waiting' });
      this.statsTimer = setInterval(() => void this.monitorQuality(), 8000);
      const remotes = result.data.participants.filter(user => user.socketId !== this.socket.id);
      remotes.forEach(remote => this.offerTo(remote.socketId));
    } catch (error) {
      console.error('Falha ao iniciar chamada:', error);
      if (this.current(generation)) this.fail('Não foi possível conectar a chamada. Verifique a conexão e tente novamente.');
    }
  };
  private onDeviceEnded(kind: UserMediaKind, track: MediaStreamTrack, generation: number) {
    if (!this.current(generation) || track.readyState !== 'ended') return;
    this.cameraStream?.removeTrack(track);
    if (kind === 'microphone') {
      void Promise.all([...this.peers.values()].map(context => context.audioSender.replaceTrack(null))).catch(() => undefined);
      this.update({ microphone: false, notice: 'O microfone foi desconectado.' });
    } else {
      if (!this.displayStream) void Promise.all([...this.peers.values()].map(context => context.videoSender?.replaceTrack(null))).catch(() => undefined);
      this.update({ camera: false, notice: 'A câmera foi desconectada.' });
    }
    this.publishMedia();
  }
  toggleMicrophone = async () => {
    if (this.state.phase === 'idle' || this.state.microphoneBusy) return;
    const currentTrack = this.cameraStream?.getAudioTracks()[0];
    if (currentTrack) {
      const microphone = !this.state.microphone;
      currentTrack.enabled = microphone; this.update({ microphone }); this.publishMedia(); return;
    }
    if (!navigator.mediaDevices?.getUserMedia) { this.update({ error: 'Use HTTPS ou localhost para permitir acesso ao microfone.' }); return; }
    const generation = this.generation;
    this.update({ microphoneBusy: true, error: '' });
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: this.devices.microphoneId ? { deviceId: { exact: this.devices.microphoneId } } : true,
        video: false,
      });
      if (!this.current(generation)) { stream.getTracks().forEach(track => track.stop()); return; }
      const track = stream.getAudioTracks()[0];
      if (!track) throw new DOMException('Microfone não encontrado.', 'NotFoundError');
      for (const extra of stream.getTracks()) if (extra !== track) extra.stop();
      this.cameraStream?.addTrack(track); track.onended = () => this.onDeviceEnded('microphone', track, generation);
      await Promise.all([...this.peers.values()].map(context => context.audioSender.replaceTrack(track)));
      if (!this.current(generation)) { track.onended = null; track.stop(); return; }
      this.refreshLocalStream(); this.update({ microphone: true }); this.publishMedia();
    } catch (error) {
      stream?.getTracks().forEach(track => { this.cameraStream?.removeTrack(track); track.onended = null; track.stop(); });
      if (this.current(generation)) await Promise.all([...this.peers.values()].map(context => context.audioSender.replaceTrack(null).catch(() => undefined)));
      if (this.current(generation)) this.update({ error: userMediaError(error, 'microphone') });
    } finally { if (this.current(generation)) this.update({ microphoneBusy: false }); }
  };
  toggleCamera = async () => {
    if (this.state.phase === 'idle' || this.state.cameraBusy || this.screenOperation) return;
    const currentTrack = this.cameraStream?.getVideoTracks()[0];
    if (currentTrack) {
      const camera = !this.state.camera;
      currentTrack.enabled = camera; this.update({ camera }); this.publishMedia(); return;
    }
    if (!navigator.mediaDevices?.getUserMedia) { this.update({ error: 'Use HTTPS ou localhost para permitir acesso à câmera.' }); return; }
    const generation = this.generation;
    this.update({ cameraBusy: true, error: '' });
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...(this.devices.cameraId ? { deviceId: { exact: this.devices.cameraId } } : {}) },
      });
      if (!this.current(generation)) { stream.getTracks().forEach(track => track.stop()); return; }
      const track = stream.getVideoTracks()[0];
      if (!track) throw new DOMException('Câmera não encontrada.', 'NotFoundError');
      for (const extra of stream.getTracks()) if (extra !== track) extra.stop();
      this.cameraStream?.addTrack(track); track.onended = () => this.onDeviceEnded('camera', track, generation);
      if (!this.displayStream) await Promise.all([...this.peers.values()].map(context => context.videoSender?.replaceTrack(track)));
      if (!this.current(generation)) { track.onended = null; track.stop(); return; }
      this.refreshLocalStream(); this.update({ camera: true }); this.publishMedia();
    } catch (error) {
      stream?.getTracks().forEach(track => { this.cameraStream?.removeTrack(track); track.onended = null; track.stop(); });
      if (this.current(generation) && !this.displayStream) await Promise.all([...this.peers.values()].map(context => context.videoSender?.replaceTrack(null).catch(() => undefined)));
      if (this.current(generation)) this.update({ error: userMediaError(error, 'camera') });
    } finally { if (this.current(generation)) this.update({ cameraBusy: false }); }
  };
  toggleHand = () => {
    const self = this.state.participants.find(item => item.socketId === this.socket.id);
    if (!self || !this.attemptId) return;
    this.socket.emit('atualizar_mao', { sala: this.room, attemptId: this.attemptId, raised: !self.handRaisedAt });
  };
  sendReaction = (emoji: string) => {
    if (this.attemptId) this.socket.emit('enviar_reacao', { sala: this.room, attemptId: this.attemptId, emoji });
  };
  private setSenderQuality = async (sender: RTCRtpSender, maxBitrate: number, scaleResolutionDownBy: number) => {
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) parameters.encodings = [{}];
    parameters.encodings[0] = { ...parameters.encodings[0], maxBitrate, scaleResolutionDownBy };
    try { await sender.setParameters(parameters); } catch { /* Unsupported by some browsers. */ }
  };
  private adjustVideo = async (maxBitrate: number, scaleResolutionDownBy: number) => {
    await Promise.all([...this.peers.values()].map(context => context.videoSender ? this.setSenderQuality(context.videoSender, maxBitrate, scaleResolutionDownBy) : Promise.resolve()));
  };
  setEcoMode = async (ecoMode: boolean) => {
    this.update({ ecoMode, quality: ecoMode ? 'low' : this.state.quality });
    await this.adjustVideo(ecoMode ? 350_000 : 1_500_000, ecoMode ? 2 : 1);
  };
  private monitorQuality = async () => {
    if (!this.peers.size || this.state.ecoMode) return;
    let unstable = false;
    for (const context of this.peers.values()) {
      try {
        const reports = await context.connection.getStats();
        reports.forEach(report => {
          if (report.type !== 'remote-inbound-rtp' || report.kind !== 'video') return;
          const fractionLost = typeof report.fractionLost === 'number' ? report.fractionLost : 0;
          const roundTripTime = typeof report.roundTripTime === 'number' ? report.roundTripTime : 0;
          if (fractionLost > 0.08 || roundTripTime > 0.6) unstable = true;
        });
      } catch { /* A closed peer will be removed by its connection listener. */ }
    }
    const quality = unstable ? 'low' : 'high';
    if (quality === this.state.quality) return;
    this.update({ quality, notice: unstable ? 'Conexão instável — qualidade de vídeo reduzida.' : 'A conexão estabilizou — qualidade de vídeo restaurada.' });
    await this.adjustVideo(unstable ? 550_000 : 1_500_000, unstable ? 1.5 : 1);
  };
  private restoreCamera = async (generation: number) => {
    const display = this.displayStream;
    if (!display || !this.current(generation)) return;
    this.screenOperation = true; this.update({ sharingBusy: true });
    try {
      display.getTracks().forEach(track => { track.onended = null; });
      const cameraTrack = this.cameraStream?.getVideoTracks()[0] ?? null;
      await Promise.all([...this.peers.values()].map(context => context.videoSender?.replaceTrack(cameraTrack)));
      if (!this.current(generation)) return;
      this.displayStream = null; this.update({ localStream: this.cameraStream, screen: false }); this.publishMedia();
    } catch (error) {
      console.error('Falha ao restaurar câmera:', error);
      if (this.current(generation)) this.fail('Não foi possível restaurar a câmera. Entre novamente na chamada.');
    } finally {
      display.getTracks().forEach(track => track.stop());
      if (this.current(generation)) { this.screenOperation = false; this.update({ sharingBusy: false }); }
    }
  };
  toggleScreen = async () => {
    if (this.state.phase === 'idle' || this.screenOperation || this.state.cameraBusy) return;
    const generation = this.generation;
    if (this.displayStream) { await this.restoreCamera(generation); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { this.update({ error: 'Este navegador não oferece compartilhamento de tela.' }); return; }
    this.screenOperation = true; this.update({ sharingBusy: true, error: '' });
    let display: MediaStream | null = null;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
      if (!this.current(generation)) { display.getTracks().forEach(track => track.stop()); return; }
      const track = display.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') throw new Error('A captura terminou.');
      this.displayStream = display; track.onended = () => { void this.restoreCamera(generation); };
      await Promise.all([...this.peers.values()].map(context => context.videoSender?.replaceTrack(track)));
      if (!this.current(generation)) return;
      if (display.getVideoTracks().some(item => item.readyState === 'ended')) { await this.restoreCamera(generation); return; }
      this.refreshLocalStream(); this.update({ screen: true }); this.publishMedia();
    } catch (error) {
      console.error('Falha no compartilhamento:', error);
      display?.getTracks().forEach(track => { track.onended = null; track.stop(); });
      if (this.current(generation)) { this.displayStream = null; this.update({ error: mediaError(error, true) }); }
    } finally { if (this.current(generation)) { this.screenOperation = false; this.update({ sharingBusy: false }); } }
  };

  private validSignal(data: SignalSource) {
    return Boolean(this.callId && data.sala === this.room && data.callId === this.callId && data.from !== this.socket.id);
  }
  private onOffer = (data: SignalSource & { offer: Description }) => {
    if (!this.validSignal(data)) return;
    this.queuePeer(data.from, async (context, generation) => {
      if (context.connection.signalingState !== 'stable') return;
      this.armHandshake(data.from, generation); this.updatePhase();
      await context.connection.setRemoteDescription(data.offer);
      if (!this.current(generation)) return;
      // A transceiver created without a track may not be reused for the remote
      // m-line. Bind the senders to the negotiated transceivers, not orphans.
      for (const transceiver of context.connection.getTransceivers()) {
        if (transceiver.mid === null) continue;
        transceiver.direction = 'sendrecv';
        if (transceiver.receiver.track.kind === 'audio') {
          context.audioSender = transceiver.sender;
          await transceiver.sender.replaceTrack(this.cameraStream?.getAudioTracks()[0] ?? null);
        } else if (transceiver.receiver.track.kind === 'video') {
          context.videoSender = transceiver.sender;
          await transceiver.sender.replaceTrack((this.displayStream ?? this.cameraStream)?.getVideoTracks()[0] ?? null);
        }
      }
      await this.flushCandidates(context, generation);
      const answer = await context.connection.createAnswer();
      if (!this.current(generation)) return;
      await context.connection.setLocalDescription(answer);
      if (this.current(generation)) this.socket.emit('webrtc_answer', { ...this.target(data.from), answer: { type: 'answer', sdp: answer.sdp! } });
    });
  };
  private onAnswer = (data: SignalSource & { answer: Description }) => {
    if (!this.validSignal(data)) return;
    this.queuePeer(data.from, async (context, generation) => {
      if (context.connection.signalingState !== 'have-local-offer') return;
      await context.connection.setRemoteDescription(data.answer);
      if (this.current(generation)) await this.flushCandidates(context, generation);
    });
  };
  private onCandidate = (data: SignalSource & { candidate: IceCandidate }) => {
    if (!this.validSignal(data)) return;
    this.queuePeer(data.from, async (context, generation) => {
      if (!context.connection.remoteDescription) { if (context.candidates.length < 256) context.candidates.push(data.candidate); }
      else if (this.current(generation)) await context.connection.addIceCandidate(data.candidate);
    });
  };
  private onCall = (call: RoomCall) => {
    if (!this.callId || call.callId !== this.callId || call.sala !== this.room) return;
    const remoteIds = new Set(call.participants.filter(user => user.socketId !== this.socket.id).map(user => user.socketId));
    for (const peerId of this.peers.keys()) if (!remoteIds.has(peerId)) this.closePeer(peerId);
    this.update({ participants: call.participants, startedAt: call.startedAt }); this.updatePhase();
  };
  private onLeft = (event: CallLeft) => {
    if (event.sala !== this.room || event.callId !== this.callId) return;
    this.closePeer(event.socketId);
    this.update({ participants: this.state.participants.filter(user => user.socketId !== event.socketId), notice: `${event.username} saiu da chamada.` });
    this.updatePhase();
  };
  private onDisconnect = () => { if (this.state.phase !== 'idle') this.leave('A conexão caiu. Entre novamente na chamada após reconectar.', false); };
  private onReaction = (reaction: CallReaction) => {
    if (reaction.sala !== this.room || reaction.callId !== this.callId) return;
    this.update({ reactions: [...this.state.reactions, reaction].slice(-12) });
    const generation = this.generation;
    const timer = window.setTimeout(() => {
      this.reactionTimers.delete(reaction.id);
      if (this.current(generation)) this.update({ reactions: this.state.reactions.filter(item => item.id !== reaction.id) });
    }, 3500);
    this.reactionTimers.set(reaction.id, timer);
  };
  private onPageHide = () => { this.leave('', true); this.socket.disconnect(); };
  private onPageShow = (event: PageTransitionEvent) => { if (event.persisted) this.socket.connect(); };
  attach = () => {
    this.socket.on('webrtc_offer', this.onOffer); this.socket.on('webrtc_answer', this.onAnswer);
    this.socket.on('webrtc_ice_candidate', this.onCandidate); this.socket.on('chamada_atualizada', this.onCall);
    this.socket.on('participante_saiu', this.onLeft); this.socket.on('disconnect', this.onDisconnect);
    this.socket.on('reacao_chamada', this.onReaction);
    window.addEventListener('pagehide', this.onPageHide); window.addEventListener('pageshow', this.onPageShow);
    return () => {
      this.socket.off('webrtc_offer', this.onOffer); this.socket.off('webrtc_answer', this.onAnswer);
      this.socket.off('webrtc_ice_candidate', this.onCandidate); this.socket.off('chamada_atualizada', this.onCall);
      this.socket.off('participante_saiu', this.onLeft); this.socket.off('disconnect', this.onDisconnect);
      this.socket.off('reacao_chamada', this.onReaction);
      window.removeEventListener('pagehide', this.onPageHide); window.removeEventListener('pageshow', this.onPageShow);
      this.leave('', true);
    };
  };
}
