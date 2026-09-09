import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { access, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { io as connect } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { createPlatform } from '../src/platform';
import type { ClientEvents, ServerEvents, History, Presence, RoomCall, Result, Message, Room, RoomRemoved, TypingUser } from '../../shared/protocol';

let folder: string;
let prisma: PrismaClient;
let platform: ReturnType<typeof createPlatform>;
let url: string;
let sockets: Socket<ServerEvents, ClientEvents>[] = [];
const verificationTokens = new Map<string, string>();

function event<T>(socket: Socket<ServerEvents, ClientEvents>, name: string, accept: (data: T) => boolean = () => true): Promise<T> {
  return new Promise((resolveEvent, reject) => {
    const emitter = socket as unknown as { on: (eventName: string, listener: (value: T) => void) => void; off: (eventName: string, listener: (value: T) => void) => void };
    const timer = setTimeout(() => { emitter.off(name, listener); reject(new Error(`Timeout: ${name}`)); }, 4000);
    const listener = (value: T) => { if (accept(value)) { clearTimeout(timer); emitter.off(name, listener); resolveEvent(value); } };
    emitter.on(name, listener);
  });
}
async function request(path: string, body?: unknown, cookie?: string, method = body === undefined ? 'GET' : 'POST') {
  return fetch(`${url}${path}`, { method, headers: {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function account(username: string) {
  const email = `${username.toLowerCase()}@example.com`;
  const password = 'Senha1234';
  const registration = await request('/auth/register', { username, email, password, birthDate: '1990-01-02' });
  assert.equal(registration.status, 201);
  const token = verificationTokens.get(email);
  assert.ok(token);
  const verified = await request('/auth/verify', { token });
  assert.equal(verified.status, 200);
  const cookie = verified.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return { username, email, password, cookie };
}
async function createRoom(cookie: string, name = 'Projeto Alpha') {
  const response = await request('/rooms', { name }, cookie);
  assert.equal(response.status, 201);
  return (await response.json() as { room: Room }).room;
}
async function client(cookie: string, sala: string) {
  const socket = connect(url, { autoConnect: false, forceNew: true, reconnection: false, extraHeaders: { Cookie: cookie } });
  sockets.push(socket);
  const connected = event(socket, 'connect'); socket.connect(); await connected;
  const requestId = randomUUID();
  const history = event<History>(socket, 'historico_mensagens', data => data.requestId === requestId);
  const result = await socket.timeout(4000).emitWithAck('entrar_sala', { sala, requestId });
  assert.equal(result.ok, true);
  await history;
  return socket;
}
async function call(socket: Socket<ServerEvents, ClientEvents>, sala: string) {
  const attemptId = randomUUID();
  const result: Result<RoomCall> = await socket.timeout(4000).emitWithAck('entrar_chamada', { sala, attemptId });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.error);
  return { attemptId, callId: result.data.callId!, data: result.data };
}

beforeEach(async () => {
  verificationTokens.clear();
  folder = await mkdtemp(join(tmpdir(), 'coworking-integration-'));
  const database = join(folder, 'test.db');
  await copyFile(resolve(__dirname, '../prisma/dev.db'), database);
  prisma = new PrismaClient({ datasources: { db: { url: `file:${database.replaceAll('\\', '/')}` } } });
  await prisma.emailVerificationToken.deleteMany(); await prisma.session.deleteMany();
  await prisma.mensagem.deleteMany({ where: { roomId: { not: null } } }); await prisma.roomMember.deleteMany(); await prisma.room.deleteMany(); await prisma.user.deleteMany();
  platform = createPlatform(prisma, { storageRoot: join(folder, 'storage'), callRecoveryGraceMs: 300, sendVerificationEmail: async message => { verificationTokens.set(message.email, message.token); return true; } });
  await new Promise<void>(resolveListen => platform.server.listen(0, '127.0.0.1', resolveListen));
  const address = platform.server.address(); assert.ok(address && typeof address !== 'string');
  url = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  sockets.forEach(socket => socket.disconnect()); sockets = [];
  await new Promise<void>(resolveClose => platform.io.close(() => resolveClose()));
  await platform.whenIdle();
  await prisma.$disconnect(); await rm(folder, { recursive: true, force: true });
});

test('cadastro valida unicidade, armazena hash, verifica e cria sessão HttpOnly', async () => {
  const first = await request('/auth/register', { username: 'Alice', email: 'alice@example.com', password: 'Senha1234', birthDate: '1990-01-02' });
  assert.equal(first.status, 201);
  const stored = await prisma.user.findUnique({ where: { usernameNormalized: 'alice' } });
  assert.ok(stored); assert.notEqual(stored.passwordHash, 'Senha1234'); assert.equal(await bcrypt.compare('Senha1234', stored.passwordHash), true);
  assert.equal(stored.emailVerifiedAt, null);
  const blocked = await request('/auth/login', { username: 'ALICE', password: 'Senha1234' });
  assert.equal(blocked.status, 403); assert.equal((await blocked.json() as { code: string }).code, 'EMAIL_UNVERIFIED');
  const duplicate = await request('/auth/register', { username: 'alice', email: 'other@example.com', password: 'Senha1234', birthDate: '1990-01-02' });
  assert.equal(duplicate.status, 409);
  const token = verificationTokens.get('alice@example.com'); assert.ok(token);
  const verified = await request('/auth/verify', { token });
  assert.equal(verified.status, 200); assert.match(verified.headers.get('set-cookie') ?? '', /HttpOnly/); assert.match(verified.headers.get('set-cookie') ?? '', /SameSite=Lax/);
  assert.ok((await prisma.user.findUnique({ where: { id: stored.id } }))?.emailVerifiedAt);
  assert.equal((await request('/auth/verify', { token })).status, 400);
});

test('salas são persistentes por usuário e acesso por ID é recusado para não membros', async () => {
  const alice = await account('Alice'); const bob = await account('Bruno'); const outsider = await account('Carla');
  const room = await createRoom(alice.cookie);
  assert.match(room.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const joined = await request('/rooms/join', { code: room.code.toLowerCase() }, bob.cookie);
  assert.equal(joined.status, 200);
  await request('/rooms/join', { code: room.code }, bob.cookie);
  assert.equal(await prisma.roomMember.count({ where: { roomId: room.id } }), 2);
  const list = await request('/rooms', undefined, bob.cookie);
  assert.deepEqual((await list.json() as { rooms: Room[] }).rooms.map(item => item.id), [room.id]);
  const unauthorized = connect(url, { autoConnect: false, forceNew: true, reconnection: false, extraHeaders: { Cookie: outsider.cookie } });
  sockets.push(unauthorized); const connected = event(unauthorized, 'connect'); unauthorized.connect(); await connected;
  const denied = await unauthorized.timeout(4000).emitWithAck('entrar_sala', { sala: room.id, requestId: randomUUID() });
  assert.equal(denied.ok, false); assert.equal(denied.ok ? '' : denied.code, 'ROOM_FORBIDDEN');
});

test('convidados saem da sala e proprietários excluem a sala para todos', async () => {
  const alice = await account('AliceRooms'); const bob = await account('BrunoRooms'); const outsider = await account('CarlaRooms');
  const room = await createRoom(alice.cookie, 'Sala removível');
  await request('/rooms/join', { code: room.code }, bob.cookie);
  const aliceSocket = await client(alice.cookie, room.id); const bobSocket = await client(bob.cookie, room.id);
  assert.equal((await request(`/rooms/${room.id}`, undefined, outsider.cookie, 'DELETE')).status, 403);
  const left = event<RoomRemoved>(bobSocket, 'sala_removida');
  assert.equal((await request(`/rooms/${room.id}`, undefined, bob.cookie, 'DELETE')).status, 204);
  assert.deepEqual(await left, { roomId: room.id, reason: 'left' });
  assert.equal(await prisma.roomMember.count({ where: { roomId: room.id } }), 1);
  assert.ok(await prisma.room.findUnique({ where: { id: room.id } }));
  await request('/rooms/join', { code: room.code }, bob.cookie);
  const deletedForGuest = event<RoomRemoved>(bobSocket, 'sala_removida');
  const deletedForOwner = event<RoomRemoved>(aliceSocket, 'sala_removida');
  assert.equal((await request(`/rooms/${room.id}`, undefined, alice.cookie, 'DELETE')).status, 204);
  assert.deepEqual(await deletedForGuest, { roomId: room.id, reason: 'deleted' });
  assert.deepEqual(await deletedForOwner, { roomId: room.id, reason: 'deleted' });
  assert.equal(await prisma.room.findUnique({ where: { id: room.id } }), null);
});

test('chat e presença usam identidade autenticada e preservam histórico', async () => {
  const alice = await account('Alice'); const bob = await account('Bruno'); const room = await createRoom(alice.cookie);
  await request('/rooms/join', { code: room.code }, bob.cookie);
  const a = await client(alice.cookie, room.id);
  const presence = event<Presence>(a, 'usuarios_online', data => data.users.length === 2);
  const b = await client(bob.cookie, room.id);
  assert.deepEqual((await presence).users.map(user => user.username).sort(), ['Alice', 'Bruno']);
  const received = event<Message>(b, 'nova_mensagem');
  const clientMessageId = randomUUID();
  const result = await a.timeout(4000).emitWithAck('mensagem_chat', { sala: room.id, texto: '  Olá equipe  ', clientMessageId, autor: 'Forjado' } as { sala: string; texto: string; clientMessageId: string });
  assert.equal(result.ok, true); const message = await received;
  assert.equal(message.autor, 'Alice'); assert.equal(message.texto, 'Olá equipe'); assert.ok(message.userId);
  const repeated: Result<Message> = await a.timeout(4000).emitWithAck('mensagem_chat', { sala: room.id, texto: 'Olá equipe', clientMessageId });
  assert.equal(repeated.ok, true); if (!repeated.ok) throw new Error(repeated.error);
  assert.equal(repeated.data.id, message.id);
  assert.equal(await prisma.mensagem.count({ where: { clientMessageId } }), 1);
  b.disconnect(); const reconnected = await client(bob.cookie, room.id);
  const requestId = randomUUID(); const history = event<History>(reconnected, 'historico_mensagens', data => data.requestId === requestId);
  reconnected.emit('entrar_sala', { sala: room.id, requestId }, () => undefined);
  assert.equal((await history).mensagens[0]?.id, message.id);
});

test('histórico entrega 50 mensagens e pagina as anteriores sem duplicar', async () => {
  const alice = await account('AliceHistory'); const room = await createRoom(alice.cookie);
  const owner = await prisma.user.findUniqueOrThrow({ where: { usernameNormalized: 'alicehistory' } });
  await prisma.mensagem.createMany({ data: Array.from({ length: 55 }, (_, index) => ({
    sala: room.id, roomId: room.id, userId: owner.id, autor: owner.username, texto: `Mensagem ${String(index + 1).padStart(2, '0')}`,
  })) });
  const latestResponse = await request(`/rooms/${room.id}/messages?limit=50`, undefined, alice.cookie);
  assert.equal(latestResponse.status, 200);
  const latest = await latestResponse.json() as { messages: Message[]; hasMore: boolean };
  assert.equal(latest.messages.length, 50); assert.equal(latest.hasMore, true);
  const earlierResponse = await request(`/rooms/${room.id}/messages?before=${latest.messages[0]!.id}&limit=50`, undefined, alice.cookie);
  const earlier = await earlierResponse.json() as { messages: Message[]; hasMore: boolean };
  assert.equal(earlier.messages.length, 5); assert.equal(earlier.hasMore, false);
  assert.equal(new Set([...earlier.messages, ...latest.messages].map(message => message.id)).size, 55);
});

test('chamada mesh aceita 15, recusa o 16º, roteia sinais e remove somente quem sai', async () => {
  const owner = await account('User00'); const room = await createRoom(owner.cookie);
  const accounts = [owner];
  for (let index = 1; index < 16; index += 1) {
    const item = await account(`User${String(index).padStart(2, '0')}`); accounts.push(item);
    await request('/rooms/join', { code: room.code }, item.cookie);
  }
  const clients: Socket<ServerEvents, ClientEvents>[] = [];
  for (const item of accounts) clients.push(await client(item.cookie, room.id));
  const calls = [];
  for (let index = 0; index < 15; index += 1) calls.push(await call(clients[index], room.id));
  assert.equal(calls[14].data.participants.length, 15);
  assert.equal(calls[0].data.participants[0]?.microphone, false);
  assert.equal(calls[0].data.participants[0]?.camera, false);
  const full = await clients[15].timeout(4000).emitWithAck('entrar_chamada', { sala: room.id, attemptId: randomUUID() });
  assert.equal(full.ok, false); assert.equal(full.ok ? '' : full.code, 'CALL_FULL');
  const offer = event<{ from: string }>(clients[1], 'webrtc_offer');
  clients[0].emit('webrtc_offer', { sala: room.id, callId: calls[0].callId, to: clients[1].id!, offer: { type: 'offer', sdp: 'offer' } });
  assert.equal((await offer).from, clients[0].id);
  const left = event<CallLeftLike>(clients[1], 'participante_saiu');
  const remaining = event<RoomCall>(clients[1], 'chamada_atualizada', value => value.participants.length === 14);
  clients[0].emit('sair_chamada', { sala: room.id, attemptId: calls[0].attemptId });
  const departure = await left; assert.equal(departure.socketId, clients[0].id); assert.equal(departure.reason, 'manual');
  assert.equal((await remaining).callId, calls[0].callId);
});

test('desconexão técnica aguarda recuperação e só depois confirma timeout', async () => {
  const alice = await account('AliceGrace'); const bob = await account('BrunoGrace'); const room = await createRoom(alice.cookie);
  await request('/rooms/join', { code: room.code }, bob.cookie);
  const a = await client(alice.cookie, room.id); const b = await client(bob.cookie, room.id);
  const aliceCall = await call(a, room.id); await call(b, room.id);
  const departures: CallLeftLike[] = []; b.on('participante_saiu', event => departures.push(event));
  const remaining = event<RoomCall>(b, 'chamada_atualizada', value => value.callId === aliceCall.callId && value.participants.length === 1);
  a.io.engine.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(departures.length, 0, 'não deve anunciar saída durante a janela de recuperação');
  await remaining;
  assert.equal(departures.length, 1); assert.equal(departures[0]?.reason, 'timeout');
  assert.equal((await prisma.callAttendance.findUniqueOrThrow({ where: { callId_userId: { callId: aliceCall.callId, userId: (await prisma.user.findUniqueOrThrow({ where: { usernameNormalized: 'alicegrace' } })).id } } })).leftAt instanceof Date, true);
});

test('preferências, perfil, favoritos e personalização respeitam persistência e autorização', async () => {
  const alice = await account('AlicePrefs'); const bob = await account('BrunoPrefs'); const room = await createRoom(alice.cookie);
  await request('/rooms/join', { code: room.code }, bob.cookie);
  const preferences = {
    theme: 'dark', fontScale: 110, density: 'compact', reduceMotion: true, accent: 'green', sounds: false,
    messageNotifications: false, mentionNotifications: true, callNotifications: false, doNotDisturb: true,
    status: 'dnd', cameraId: 'camera-1', microphoneId: 'microphone-1', speakerId: 'speaker-1',
  };
  const saved = await request('/preferences', preferences, alice.cookie, 'PUT');
  assert.equal(saved.status, 200); assert.deepEqual((await saved.json() as { preferences: typeof preferences }).preferences, preferences);
  const profile = await request('/account', { displayName: 'Alice Silva', birthDate: '1991-03-04' }, alice.cookie, 'PATCH');
  assert.equal(profile.status, 200); assert.equal((await profile.json() as { user: { displayName: string } }).user.displayName, 'Alice Silva');
  assert.equal((await request(`/rooms/${room.id}`, { name: 'Inválida', description: '' }, bob.cookie, 'PATCH')).status, 403);
  const updated = await request(`/rooms/${room.id}`, { name: 'Projeto Renovado', description: 'Descrição persistida' }, alice.cookie, 'PATCH');
  assert.equal(updated.status, 200);
  assert.equal((await request(`/rooms/${room.id}/favorite`, { favorite: true }, bob.cookie, 'PUT')).status, 200);
  const listed = await request('/rooms', undefined, bob.cookie);
  const rooms = (await listed.json() as { rooms: Room[] }).rooms;
  assert.equal(rooms[0]?.favorite, true); assert.equal(rooms[0]?.name, 'Projeto Renovado'); assert.equal(rooms[0]?.description, 'Descrição persistida');
  const emailChange = await request('/account/email', { email: 'alice.nova@example.com', password: alice.password }, alice.cookie);
  assert.equal(emailChange.status, 200); const emailToken = verificationTokens.get('alice.nova@example.com'); assert.ok(emailToken);
  const emailVerified = await request('/auth/verify', { token: emailToken }); assert.equal(emailVerified.status, 200);
  assert.equal((await emailVerified.json() as { user: { email: string } }).user.email, 'alice.nova@example.com');
  assert.equal((await request('/account/password', { currentPassword: alice.password, newPassword: 'NovaSenha5678' }, alice.cookie, 'PUT')).status, 200);
  assert.equal((await request('/auth/login', { username: alice.username, password: alice.password })).status, 401);
  assert.equal((await request('/auth/login', { username: alice.username, password: 'NovaSenha5678' })).status, 200);
});

test('menções, replies, edição, exclusão, mãos e reações funcionam em tempo real por sala', async () => {
  const alice = await account('AliceTeam'); const bob = await account('BrunoTeam'); const room = await createRoom(alice.cookie);
  await request('/rooms/join', { code: room.code }, bob.cookie);
  const a = await client(alice.cookie, room.id); const b = await client(bob.cookie, room.id);
  const typingStarted = event<{ sala: string; users: TypingUser[] }>(b, 'usuarios_digitando', value => value.users.some(user => user.displayName === 'AliceTeam'));
  a.emit('digitando', { sala: room.id, typing: true });
  assert.equal((await typingStarted).users[0]?.displayName, 'AliceTeam');
  const typingStopped = event<{ sala: string; users: TypingUser[] }>(b, 'usuarios_digitando', value => !value.users.length);
  a.emit('digitando', { sala: room.id, typing: false });
  assert.equal((await typingStopped).users.length, 0);
  const notification = event<{ roomId: string; mention: boolean }>(b, 'sala_notificada');
  const received = event<Message>(b, 'nova_mensagem');
  const firstResult: Result<Message> = await a.timeout(4000).emitWithAck('mensagem_chat', { sala: room.id, texto: 'Olá @BrunoTeam' });
  assert.equal(firstResult.ok, true); if (!firstResult.ok) throw new Error(firstResult.error);
  const first = await received; assert.equal(first.id, firstResult.data.id);
  assert.equal((await notification).mention, true);
  assert.equal(await prisma.messageMention.count({ where: { messageId: first.id } }), 1);
  const unread = await request('/rooms', undefined, bob.cookie);
  assert.equal((await unread.json() as { rooms: Room[] }).rooms[0]?.mentionCount, 1);
  const replyResult: Result<Message> = await b.timeout(4000).emitWithAck('mensagem_chat', { sala: room.id, texto: 'Recebido', replyToId: first.id });
  assert.equal(replyResult.ok, true); if (!replyResult.ok) throw new Error(replyResult.error);
  assert.equal(replyResult.data.replyTo?.id, first.id);
  const denied: Result<Message> = await b.timeout(4000).emitWithAck('editar_mensagem', { sala: room.id, messageId: first.id, texto: 'forjado' });
  assert.equal(denied.ok, false);
  const edited: Result<Message> = await a.timeout(4000).emitWithAck('editar_mensagem', { sala: room.id, messageId: first.id, texto: 'Olá novamente @BrunoTeam' });
  assert.equal(edited.ok, true); if (!edited.ok) throw new Error(edited.error); assert.ok(edited.data.editedAt);
  const removed: Result<Message> = await a.timeout(4000).emitWithAck('excluir_mensagem', { sala: room.id, messageId: first.id });
  assert.equal(removed.ok, true); if (!removed.ok) throw new Error(removed.error); assert.equal(removed.data.deleted, true);
  assert.equal((await prisma.mensagem.findUnique({ where: { id: replyResult.data.id } }))?.replyToId, first.id);

  const callNotice = event<{ roomId: string; startedBy: string }>(b, 'chamada_notificada');
  const aliceCall = await call(a, room.id); assert.equal((await callNotice).startedBy, 'AliceTeam');
  const bobCall = await call(b, room.id);
  const raised = event<RoomCall>(b, 'chamada_atualizada', value => Boolean(value.participants.find(person => person.socketId === a.id)?.handRaisedAt));
  a.emit('atualizar_mao', { sala: room.id, attemptId: aliceCall.attemptId, raised: true });
  assert.ok((await raised).participants.find(person => person.socketId === a.id)?.handRaisedAt);
  const reaction = event<{ emoji: string; displayName: string }>(b, 'reacao_chamada');
  a.emit('enviar_reacao', { sala: room.id, attemptId: aliceCall.attemptId, emoji: '🎉' });
  const reactionData = await reaction; assert.equal(reactionData.emoji, '🎉'); assert.equal(reactionData.displayName, 'AliceTeam');
  b.emit('sair_chamada', { sala: room.id, attemptId: bobCall.attemptId });
  a.emit('sair_chamada', { sala: room.id, attemptId: aliceCall.attemptId });
});

test('uploads validam conteúdo, exigem associação à sala e removem arquivos excluídos', async () => {
  const alice = await account('AliceFiles'); const outsider = await account('BrunoFiles'); const room = await createRoom(alice.cookie);
  const form = new FormData(); form.append('file', new Blob(['%PDF-1.4\nconteúdo de teste'], { type: 'application/pdf' }), 'relatorio.pdf'); form.append('text', 'Relatório mensal');
  const uploaded = await fetch(`${url}/rooms/${room.id}/attachments`, { method: 'POST', headers: { cookie: alice.cookie }, body: form });
  assert.equal(uploaded.status, 201);
  const message = (await uploaded.json() as { message: Message }).message; const attachment = message.attachments[0]; assert.ok(attachment);
  assert.equal((await request(attachment.downloadUrl, undefined, outsider.cookie)).status, 404);
  const downloaded = await request(attachment.downloadUrl, undefined, alice.cookie); assert.equal(downloaded.status, 200); assert.match(downloaded.headers.get('content-disposition') ?? '', /relatorio\.pdf/);
  const stored = await prisma.attachment.findUnique({ where: { id: attachment.id } }); assert.ok(stored);
  const socket = await client(alice.cookie, room.id);
  const removed: Result<Message> = await socket.timeout(4000).emitWithAck('excluir_mensagem', { sala: room.id, messageId: message.id });
  assert.equal(removed.ok, true); assert.equal(await prisma.attachment.count({ where: { id: attachment.id } }), 0);
  await assert.rejects(access(join(folder, 'storage', 'files', stored.storedName)));
  assert.equal((await request(attachment.downloadUrl, undefined, alice.cookie)).status, 404);
  const invalid = new FormData(); invalid.append('file', new Blob(['MZ executable'], { type: 'application/octet-stream' }), 'programa.exe');
  assert.equal((await fetch(`${url}/rooms/${room.id}/attachments`, { method: 'POST', headers: { cookie: alice.cookie }, body: invalid })).status, 400);
});

test('avatar persistente e versionado aparece em mensagens antigas para usuários offline e novos', async () => {
  const alice = await account('AliceAvatar'); const bob = await account('BrunoAvatar');
  const room = await createRoom(alice.cookie, 'Sala Avatar');
  assert.equal((await request('/rooms/join', { code: room.code }, bob.cookie)).status, 200);
  const aliceSocket = await client(alice.cookie, room.id);
  const sent: Result<Message> = await aliceSocket.timeout(4000).emitWithAck('mensagem_chat', { sala: room.id, texto: 'Mensagem anterior à foto', clientMessageId: randomUUID() });
  assert.equal(sent.ok, true); aliceSocket.disconnect();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const form = new FormData(); form.append('avatar', new Blob([png], { type: 'image/png' }), 'perfil.png');
  const uploaded = await fetch(`${url}/account/avatar`, { method: 'POST', headers: { cookie: alice.cookie }, body: form });
  assert.equal(uploaded.status, 200);
  const user = (await uploaded.json() as { user: { id: string; avatarUrl: string | null } }).user;
  assert.match(user.avatarUrl ?? '', new RegExp(`/users/${user.id}/avatar\\?v=\\d+`));
  const stored = await prisma.user.findUnique({ where: { username: 'AliceAvatar' }, select: { avatarPath: true } });
  assert.ok(stored?.avatarPath?.startsWith('data:image/png;base64,'));
  const image = await request(user.avatarUrl!, undefined, alice.cookie);
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const me = await request('/auth/me', undefined, alice.cookie);
  assert.equal((await me.json() as { user: { avatarUrl: string | null } }).user.avatarUrl, user.avatarUrl);
  const bobMessages = await request(`/rooms/${room.id}/messages`, undefined, bob.cookie);
  assert.equal(((await bobMessages.json() as { messages: Message[] }).messages[0]?.avatarUrl), user.avatarUrl);
  const carla = await account('CarlaAvatar');
  assert.equal((await request('/rooms/join', { code: room.code }, carla.cookie)).status, 200);
  const members = await request(`/rooms/${room.id}/members`, undefined, carla.cookie);
  const member = (await members.json() as { members: { id: string; avatarUrl: string | null }[] }).members.find(item => item.id === user.id);
  assert.equal(member?.avatarUrl, user.avatarUrl);
  const carlaMessages = await request(`/rooms/${room.id}/messages`, undefined, carla.cookie);
  assert.equal(((await carlaMessages.json() as { messages: Message[] }).messages[0]?.avatarUrl), user.avatarUrl);
});
interface CallLeftLike { socketId: string; reason: 'manual' | 'room-change' | 'timeout' }

test('uploads bloqueiam tamanho no servidor e validam assinatura de vídeos', async () => {
  const alice = await account('UploadLimit'); const room = await createRoom(alice.cookie);
  for (const [name, type, label] of [['large.png', 'image/png', 'A imagem'], ['large.pdf', 'application/pdf', 'O arquivo'], ['large.mp4', 'video/mp4', 'O vídeo']]) {
    const body = new FormData(); body.append('file', new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type }), name);
    const response = await fetch(`${url}/rooms/${room.id}/attachments`, { method: 'POST', headers: { cookie: alice.cookie }, body });
    assert.equal(response.status, 413);
    assert.match((await response.json() as { error: string }).error, new RegExp(`${label}.*4 MB`));
  }
  assert.equal(await prisma.attachment.count(), 0);
  const bad = new FormData(); bad.append('file', new Blob(['not a video'], { type: 'video/mp4' }), 'fake.mp4');
  assert.equal((await fetch(`${url}/rooms/${room.id}/attachments`, { method: 'POST', headers: { cookie: alice.cookie }, body: bad })).status, 400);
});

test('repetir entrada na sala e na chamada mantém participantes e histórico', async () => {
  const alice = await account('RepeatCall'); const room = await createRoom(alice.cookie); const socket = await client(alice.cookie, room.id);
  const attemptId = randomUUID();
  const first = await socket.timeout(4000).emitWithAck('entrar_chamada', { sala: room.id, attemptId });
  assert.ok(first.ok);
  await socket.timeout(4000).emitWithAck('entrar_sala', { sala: room.id, requestId: randomUUID() });
  const second = await socket.timeout(4000).emitWithAck('entrar_chamada', { sala: room.id, attemptId });
  assert.ok(second.ok); assert.equal(second.data.callId, first.data.callId); assert.equal(second.data.participants.length, 1);
  assert.equal(await prisma.callHistory.count(), 1);
});

test('chat e chamada usam salas independentes, detectam call tardia e bloqueiam segunda call', async () => {
  const alice = await account('AliceRooms'); const bob = await account('BrunoRooms');
  const firstRoom = await createRoom(alice.cookie, 'Sala Um'); const secondRoom = await createRoom(alice.cookie, 'Sala Dois');
  assert.equal((await request('/rooms/join', { code: firstRoom.code }, bob.cookie)).status, 200);
  const a = await client(alice.cookie, firstRoom.id); const aliceCall = await call(a, firstRoom.id);

  const b = connect(url, { autoConnect: false, forceNew: true, reconnection: false, extraHeaders: { Cookie: bob.cookie } });
  sockets.push(b); const connected = event(b, 'connect'); b.connect(); await connected;
  const requestId = randomUUID();
  const detected = event<RoomCall>(b, 'chamada_atualizada', value => value.sala === firstRoom.id && value.callId === aliceCall.callId && value.participants.some(item => item.userId === aliceCall.data.participants[0]?.userId));
  const history = event<History>(b, 'historico_mensagens', value => value.requestId === requestId);
  assert.equal((await b.timeout(4000).emitWithAck('entrar_sala', { sala: firstRoom.id, requestId })).ok, true);
  await Promise.all([detected, history]);

  const secondRequestId = randomUUID(); const secondHistory = event<History>(a, 'historico_mensagens', value => value.requestId === secondRequestId);
  assert.equal((await a.timeout(4000).emitWithAck('entrar_sala', { sala: secondRoom.id, requestId: secondRequestId })).ok, true);
  await secondHistory;
  const message: Result<Message> = await a.timeout(4000).emitWithAck('mensagem_chat', { sala: secondRoom.id, texto: 'Chat continua durante a call', clientMessageId: randomUUID() });
  assert.equal(message.ok, true);
  const synchronized: Result<RoomCall> = await a.timeout(4000).emitWithAck('sincronizar_chamada', { sala: firstRoom.id, attemptId: aliceCall.attemptId });
  assert.equal(synchronized.ok, true); if (synchronized.ok) assert.equal(synchronized.data.callId, aliceCall.callId);
  const blocked: Result<RoomCall> = await a.timeout(4000).emitWithAck('entrar_chamada', { sala: secondRoom.id, attemptId: randomUUID() });
  assert.equal(blocked.ok, false); if (!blocked.ok) { assert.equal(blocked.code, 'ALREADY_IN_CALL'); assert.match(blocked.error, /outra sala/); }
  const stillActive: Result<RoomCall> = await a.timeout(4000).emitWithAck('sincronizar_chamada', { sala: firstRoom.id, attemptId: aliceCall.attemptId });
  assert.equal(stillActive.ok, true); if (stillActive.ok) assert.equal(stillActive.data.callId, aliceCall.callId);
  const left = event<CallLeftLike>(b, 'participante_saiu', value => value.socketId === a.id);
  a.emit('sair_chamada', { sala: firstRoom.id, attemptId: aliceCall.attemptId });
  assert.equal((await left).reason, 'manual');
});
