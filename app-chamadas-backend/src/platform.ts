import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import QRCode from 'qrcode';
import { Prisma } from '@prisma/client';
import type { PrismaClient, User, UserPreference } from '@prisma/client';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io';
import type { Ack, CallLeft, CallParticipant, ClientEvents, Message, RoomCall, ServerEvents } from '../shared/protocol';
import { clearSessionCookie, createSession, opaqueToken, publicUser, readCookie, SESSION_COOKIE, sessionUser, tokenHash } from './security';
import { createVerificationSender } from './email';
import type { VerificationSender } from './email';

import type { PresenceStatus } from '../shared/protocol';

interface SocketData {
  sala?: string;
  sessionId: string;
  sessionCheckedAt: number;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  status: PresenceStatus;
  revision: number;
  joining: boolean;
}
type ClientSocket = Socket<ClientEvents, ServerEvents, Record<string, never>, SocketData>;
interface PlatformOptions { sendVerificationEmail?: VerificationSender; storageRoot?: string }
const MAX_CALL_PARTICIPANTS = 15;
const VERIFY_DURATION_MS = 60 * 60 * 1000;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100;
const channelKey = (roomId: string) => `channel:${roomId}`;
const userKey = (userId: string) => `user:${userId}`;
const normalize = (value: string) => value.normalize('NFC').toLocaleLowerCase('pt-BR');
const routeId = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const avatarUrl = (user: { id: string; avatarPath: string | null; updatedAt: Date }) => user.avatarPath ? `/users/${user.id}/avatar?v=${user.updatedAt.getTime()}` : null;
const messageInclude = {
  user: { select: { id: true, username: true, displayName: true, avatarPath: true, updatedAt: true } },
  replyTo: { select: { id: true, autor: true, texto: true, deletedAt: true } },
  mentions: { select: { userId: true } },
  attachments: { select: { id: true, name: true, mimeType: true, size: true } },
} satisfies Prisma.MensagemInclude;
type SelectedMessage = Prisma.MensagemGetPayload<{ include: typeof messageInclude }>;
const formatMessage = (message: SelectedMessage, viewerId?: string): Message => ({
  id: message.id,
  clientMessageId: message.clientMessageId,
  autor: message.autor,
  displayName: message.user?.displayName || message.autor,
  avatarUrl: message.user ? avatarUrl(message.user) : null,
  texto: message.deletedAt ? '' : message.texto,
  sala: message.sala,
  userId: message.userId,
  criadoEm: message.criadoEm.toISOString(),
  horario: message.criadoEm.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  editedAt: message.editedAt?.toISOString() ?? null,
  deleted: Boolean(message.deletedAt),
  mentioned: viewerId ? message.mentions.some(mention => mention.userId === viewerId) : false,
  replyTo: message.replyTo ? { id: message.replyTo.id, autor: message.replyTo.autor, texto: message.replyTo.deletedAt ? '' : message.replyTo.texto, deleted: Boolean(message.replyTo.deletedAt) } : null,
  attachments: message.deletedAt ? [] : message.attachments.map(attachment => ({ ...attachment, downloadUrl: `/attachments/${attachment.id}/download` })),
});
const roomSelect = {
  id: true, name: true, description: true, code: true, createdAt: true,
  createdBy: { select: { id: true, username: true, displayName: true, avatarPath: true, updatedAt: true } },
} satisfies Prisma.RoomSelect;
type SelectedRoom = Prisma.RoomGetPayload<{ select: typeof roomSelect }>;
const formatRoom = (room: SelectedRoom, membership?: { favorite: boolean; notificationsEnabled: boolean }, counters = { unreadCount: 0, mentionCount: 0 }) => ({
  id: room.id, name: room.name, code: room.code, description: room.description || `Criada por ${room.createdBy.displayName || room.createdBy.username}`,
  createdAt: room.createdAt.toISOString(),
  createdBy: { id: room.createdBy.id, username: room.createdBy.username, displayName: room.createdBy.displayName || room.createdBy.username, avatarUrl: avatarUrl(room.createdBy) },
  favorite: membership?.favorite ?? false, notificationsEnabled: membership?.notificationsEnabled ?? true, ...counters,
});
const formatPreferences = (preferences: UserPreference) => ({
  theme: preferences.theme, fontScale: preferences.fontScale, density: preferences.density, reduceMotion: preferences.reduceMotion,
  accent: preferences.accent, sounds: preferences.sounds, messageNotifications: preferences.messageNotifications,
  mentionNotifications: preferences.mentionNotifications, callNotifications: preferences.callNotifications,
  doNotDisturb: preferences.doNotDisturb, status: preferences.status, cameraId: preferences.cameraId ?? '',
  microphoneId: preferences.microphoneId ?? '', speakerId: preferences.speakerId ?? '',
});

function validationError(body: unknown) {
  if (!isRecord(body)) return 'Preencha todos os campos.';
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const birthDate = typeof body.birthDate === 'string' ? body.birthDate : '';
  if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) return 'Use um nome de 3 a 32 caracteres com letras, números, ponto, hífen ou sublinhado.';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Informe um e-mail válido.';
  if (password.length < 8 || password.length > 128 || !/[\p{L}]/u.test(password) || !/\p{N}/u.test(password)) return 'A senha deve ter entre 8 e 128 caracteres, com pelo menos uma letra e um número.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return 'Informe uma data de nascimento válida.';
  const date = new Date(`${birthDate}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== birthDate || birthDate > new Date().toISOString().slice(0, 10)) return 'A data de nascimento não pode estar no futuro.';
  return null;
}

function rateLimiter(limit: number, intervalMs: number) {
  const attempts = new Map<string, { count: number; reset: number }>();
  return (request: express.Request, response: express.Response, next: express.NextFunction) => {
    const now = Date.now();
    const key = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const current = attempts.get(key);
    if (!current || current.reset <= now) attempts.set(key, { count: 1, reset: now + intervalMs });
    else if (current.count >= limit) { response.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' }); return; }
    else current.count += 1;
    if (attempts.size > 2_000) for (const [entry, value] of attempts) if (value.reset <= now) attempts.delete(entry);
    next();
  };
}

function safeName(value: string) {
  return basename(value).replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 180) || 'arquivo';
}
function imageExtension(buffer: Buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return '.jpg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) return '.gif';
  return null;
}
function safeAttachment(file: Express.Multer.File) {
  const extension = extname(file.originalname).toLocaleLowerCase('en-US');
  const image = imageExtension(file.buffer);
  if (image && ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return { extension: image, mimeType: image === '.jpg' ? 'image/jpeg' : `image/${image.slice(1)}` };
  if (extension === '.pdf' && file.buffer.toString('ascii', 0, 5) === '%PDF-') return { extension, mimeType: 'application/pdf' };
  if (['.zip', '.docx', '.xlsx', '.pptx'].includes(extension) && file.buffer[0] === 0x50 && file.buffer[1] === 0x4b) return { extension, mimeType: file.mimetype };
  if (['.doc', '.xls', '.ppt'].includes(extension) && file.buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return { extension, mimeType: file.mimetype };
  if (['.txt', '.csv'].includes(extension) && !file.buffer.includes(0)) return { extension, mimeType: extension === '.csv' ? 'text/csv' : 'text/plain' };
  return null;
}

export function createPlatform(prisma: PrismaClient, options: PlatformOptions = {}) {
  const app = express();
  const storageRoot = resolve(options.storageRoot || process.env.UPLOAD_DIR || join(process.cwd(), 'storage'));
  const avatarDirectory = join(storageRoot, 'avatars');
  const fileDirectory = join(storageRoot, 'files');
  mkdirSync(avatarDirectory, { recursive: true });
  mkdirSync(fileDirectory, { recursive: true });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  const configuredOrigins = process.env.CORS_ORIGIN?.split(',').map(origin => origin.trim()).filter(Boolean);
  const allowedOrigins: string[] | true = configuredOrigins?.length ? configuredOrigins : true;
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(cors({ origin: allowedOrigins, credentials: true }));
  app.use(express.json({ limit: '16kb' }));
  app.use((request, response, next) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS' || allowedOrigins === true) { next(); return; }
    const origin = request.get('origin');
    if (!origin || allowedOrigins.includes(origin)) { next(); return; }
    response.status(403).json({ error: 'Origem não autorizada.' });
  });
  app.get('/health', async (_request, response) => {
    try { await prisma.$queryRaw`SELECT 1`; response.json({ status: 'ok' }); }
    catch { response.status(503).json({ status: 'database-unavailable' }); }
  });

  const sendVerification = options.sendVerificationEmail ?? createVerificationSender();
  async function issueVerification(user: User, target = user.email, purpose = 'registration') {
    const token = opaqueToken();
    await prisma.$transaction([
      prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } }),
      prisma.emailVerificationToken.create({ data: {
        tokenHash: tokenHash(token), userId: user.id, purpose,
        newEmail: purpose === 'email-change' ? target : null,
        newEmailNormalized: purpose === 'email-change' ? normalize(target) : null,
        expiresAt: new Date(Date.now() + VERIFY_DURATION_MS),
      } }),
    ]);
    try { return await sendVerification({ email: target, username: user.username, token }); }
    catch (error) { console.error('Falha ao enviar verificação de e-mail:', error instanceof Error ? error.message : 'erro desconhecido'); return false; }
  }
  const requireAuth = async (request: express.Request, response: express.Response, next: express.NextFunction) => {
    try {
      const auth = await sessionUser(prisma, request.headers.cookie);
      if (!auth) { response.status(401).json({ error: 'Sua sessão expirou. Entre novamente.' }); return; }
      (request as express.Request & { auth: typeof auth }).auth = auth;
      next();
    } catch { response.status(401).json({ error: 'Não foi possível validar sua sessão.' }); }
  };
  const getAuth = (request: express.Request) => (request as express.Request & { auth: NonNullable<Awaited<ReturnType<typeof sessionUser>>> }).auth;
  const memberFor = (request: express.Request, roomId: string) => prisma.roomMember.findUnique({ where: { userId_roomId: { userId: getAuth(request).user.id, roomId } } });

  app.post('/auth/register', rateLimiter(30, 15 * 60_000), async (request, response) => {
    const invalid = validationError(request.body);
    if (invalid) { response.status(400).json({ error: invalid }); return; }
    const username = String(request.body.username).trim().normalize('NFC');
    const email = String(request.body.email).trim().normalize('NFC');
    const usernameNormalized = normalize(username);
    const emailNormalized = normalize(email);
    try {
      if (await prisma.user.findUnique({ where: { usernameNormalized } })) {
        response.status(409).json({ error: 'Nome de usuário já utilizado.', code: 'USERNAME_TAKEN' }); return;
      }
      if (await prisma.user.findUnique({ where: { emailNormalized } })) {
        response.status(409).json({ error: 'Não foi possível criar uma conta com os dados informados.' }); return;
      }
      const passwordHash = await bcrypt.hash(String(request.body.password), 12);
      const user = await prisma.user.create({ data: {
        username, usernameNormalized, email, emailNormalized, passwordHash,
        birthDate: new Date(`${String(request.body.birthDate)}T12:00:00.000Z`),
      } });
      const emailSent = await issueVerification(user);
      response.status(201).json({ emailSent, message: emailSent
        ? 'Conta criada. Enviamos um link de verificação para seu e-mail.'
        : 'Conta criada, mas o e-mail não pôde ser enviado. Configure o SMTP ou tente reenviar.' });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        response.status(409).json({ error: 'Não foi possível criar uma conta com os dados informados.' }); return;
      }
      console.error('Falha no cadastro:', error instanceof Error ? error.message : 'erro desconhecido');
      response.status(500).json({ error: 'Não foi possível criar a conta agora.' });
    }
  });

  app.post('/auth/login', rateLimiter(12, 15 * 60_000), async (request, response) => {
    const username = isRecord(request.body) && typeof request.body.username === 'string' ? request.body.username.trim() : '';
    const password = isRecord(request.body) && typeof request.body.password === 'string' ? request.body.password : '';
    if (!username || !password) { response.status(400).json({ error: 'Informe nome de usuário e senha.' }); return; }
    try {
      const user = await prisma.user.findUnique({ where: { usernameNormalized: normalize(username) } });
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        response.status(401).json({ error: 'Nome de usuário ou senha incorretos.' }); return;
      }
      if (!user.emailVerifiedAt) {
        response.status(403).json({ error: 'Verifique seu e-mail antes de entrar.', code: 'EMAIL_UNVERIFIED' }); return;
      }
      await createSession(prisma, user, response, request);
      response.json({ user: publicUser(user) });
    } catch (error) {
      console.error('Falha no login:', error instanceof Error ? error.message : 'erro desconhecido');
      response.status(500).json({ error: 'Não foi possível entrar agora.' });
    }
  });

  app.post('/auth/verify', rateLimiter(20, 15 * 60_000), async (request, response) => {
    const token = isRecord(request.body) && typeof request.body.token === 'string' ? request.body.token : '';
    if (token.length < 32 || token.length > 200) { response.status(400).json({ error: 'Link de verificação inválido ou expirado.' }); return; }
    try {
      const record = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: tokenHash(token) }, include: { user: true } });
      if (!record || record.expiresAt <= new Date()) {
        if (record) await prisma.emailVerificationToken.delete({ where: { id: record.id } });
        response.status(400).json({ error: 'Link de verificação inválido ou expirado.' }); return;
      }
      const user = await prisma.$transaction(async transaction => {
        const verified = await transaction.user.update({ where: { id: record.userId }, data: record.purpose === 'email-change' && record.newEmail && record.newEmailNormalized
          ? { email: record.newEmail, emailNormalized: record.newEmailNormalized }
          : { emailVerifiedAt: record.user.emailVerifiedAt ?? new Date() } });
        await transaction.emailVerificationToken.deleteMany({ where: { userId: record.userId } });
        return verified;
      });
      if (record.purpose !== 'email-change') await createSession(prisma, user, response, request);
      response.json({ user: publicUser(user) });
    } catch { response.status(400).json({ error: 'Link de verificação inválido ou expirado.' }); }
  });

  app.post('/auth/resend-verification', rateLimiter(5, 15 * 60_000), async (request, response) => {
    const username = isRecord(request.body) && typeof request.body.username === 'string' ? request.body.username.trim() : '';
    const password = isRecord(request.body) && typeof request.body.password === 'string' ? request.body.password : '';
    try {
      const user = username ? await prisma.user.findUnique({ where: { usernameNormalized: normalize(username) } }) : null;
      if (!user || !password || !(await bcrypt.compare(password, user.passwordHash))) {
        response.status(401).json({ error: 'Não foi possível reenviar com os dados informados.' }); return;
      }
      if (user.emailVerifiedAt) { response.json({ message: 'Este e-mail já foi verificado.' }); return; }
      const emailSent = await issueVerification(user);
      if (!emailSent) { response.status(503).json({ error: 'Não foi possível enviar o e-mail de verificação. Confira a configuração SMTP.' }); return; }
      response.json({ message: 'Enviamos um novo link de verificação.' });
    } catch { response.status(500).json({ error: 'Não foi possível reenviar o e-mail agora.' }); }
  });

  app.get('/auth/me', requireAuth, (request, response) => response.json({ user: publicUser(getAuth(request).user) }));
  app.post('/auth/logout', async (request, response) => {
    const raw = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (raw) await prisma.session.deleteMany({ where: { id: tokenHash(raw) } }).catch(() => undefined);
    clearSessionCookie(response);
    response.status(204).end();
  });

  app.get('/rooms', requireAuth, async (request, response) => {
    const userId = getAuth(request).user.id;
    const memberships = await prisma.roomMember.findMany({
      where: { userId }, include: { room: { select: roomSelect } },
      orderBy: [{ favorite: 'desc' }, { joinedAt: 'asc' }],
    });
    const rooms = await Promise.all(memberships.map(async membership => {
      const [unreadCount, mentionCount] = await Promise.all([
        prisma.mensagem.count({ where: { roomId: membership.roomId, criadoEm: { gt: membership.lastReadAt }, userId: { not: userId }, deletedAt: null } }),
        prisma.messageMention.count({ where: { userId, message: { roomId: membership.roomId, criadoEm: { gt: membership.lastReadAt }, deletedAt: null } } }),
      ]);
      return formatRoom(membership.room, membership, { unreadCount, mentionCount });
    }));
    response.json({ rooms });
  });
  app.post('/rooms', requireAuth, async (request, response) => {
    const name = isRecord(request.body) && typeof request.body.name === 'string' ? request.body.name.trim() : '';
    if (name.length < 2 || name.length > 60 || /[\u0000-\u001f\u007f]/u.test(name)) {
      response.status(400).json({ error: 'Use um nome de sala de 2 a 60 caracteres.' }); return;
    }
    try {
      let room: SelectedRoom | undefined;
      for (let attempt = 0; attempt < 5 && !room; attempt += 1) {
        const compact = opaqueToken(6).toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(8, 'X').slice(0, 8);
        const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
        try {
          room = await prisma.room.create({ data: {
            name, code, createdById: getAuth(request).user.id,
            members: { create: { userId: getAuth(request).user.id } },
          }, select: roomSelect });
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
        }
      }
      if (!room) throw new Error('room-code-collision');
      response.status(201).json({ room: formatRoom(room, { favorite: false, notificationsEnabled: true }) });
    } catch (error) {
      console.error('Falha ao criar sala:', error instanceof Error ? error.message : 'erro desconhecido');
      response.status(500).json({ error: 'Não foi possível criar a sala.' });
    }
  });
  app.post('/rooms/join', rateLimiter(60, 15 * 60_000), requireAuth, async (request, response) => {
    const rawCode = isRecord(request.body) && typeof request.body.code === 'string' ? request.body.code : '';
    const normalized = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const code = normalized.length === 8 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : '';
    if (!code) { response.status(400).json({ error: 'Informe um código de sala válido.' }); return; }
    const room = await prisma.room.findUnique({ where: { code }, select: roomSelect });
    if (!room) { response.status(404).json({ error: 'Código da sala inválido.' }); return; }
    await prisma.roomMember.upsert({
      where: { userId_roomId: { userId: getAuth(request).user.id, roomId: room.id } },
      create: { userId: getAuth(request).user.id, roomId: room.id }, update: {},
    });
    const membership = await memberFor(request, room.id);
    response.json({ room: formatRoom(room, membership ?? undefined) });
  });

  app.get('/preferences', requireAuth, async (request, response) => {
    const userId = getAuth(request).user.id;
    const preferences = await prisma.userPreference.upsert({ where: { userId }, create: { userId }, update: {} });
    response.json({ preferences: formatPreferences(preferences) });
  });
  app.put('/preferences', requireAuth, async (request, response) => {
    if (!isRecord(request.body)) { response.status(400).json({ error: 'Preferências inválidas.' }); return; }
    const input = request.body;
    const theme = ['dark', 'light', 'system'].includes(String(input.theme)) ? String(input.theme) : null;
    const density = ['comfortable', 'compact'].includes(String(input.density)) ? String(input.density) : null;
    const accent = ['violet', 'blue', 'green'].includes(String(input.accent)) ? String(input.accent) : null;
    const status = ['online', 'busy', 'dnd', 'away'].includes(String(input.status)) ? String(input.status) : null;
    const fontScale = Number(input.fontScale);
    if (!theme || !density || !accent || !status || !Number.isInteger(fontScale) || fontScale < 85 || fontScale > 125) {
      response.status(400).json({ error: 'Preferências inválidas.' }); return;
    }
    const booleanFields = ['reduceMotion', 'sounds', 'messageNotifications', 'mentionNotifications', 'callNotifications', 'doNotDisturb'] as const;
    if (booleanFields.some(field => typeof input[field] !== 'boolean')) { response.status(400).json({ error: 'Preferências inválidas.' }); return; }
    const reduceMotion = input.reduceMotion as boolean;
    const sounds = input.sounds as boolean;
    const messageNotifications = input.messageNotifications as boolean;
    const mentionNotifications = input.mentionNotifications as boolean;
    const callNotifications = input.callNotifications as boolean;
    const doNotDisturb = input.doNotDisturb as boolean;
    const device = (value: unknown) => typeof value === 'string' && value.length <= 500 ? value : '';
    const preferences = await prisma.userPreference.upsert({ where: { userId: getAuth(request).user.id }, create: {
      userId: getAuth(request).user.id, theme, density, accent, status, fontScale,
      reduceMotion, sounds, messageNotifications, mentionNotifications, callNotifications,
      doNotDisturb, cameraId: device(input.cameraId) || null,
      microphoneId: device(input.microphoneId) || null, speakerId: device(input.speakerId) || null,
    }, update: {
      theme, density, accent, status, fontScale, reduceMotion, sounds,
      messageNotifications, mentionNotifications, callNotifications, doNotDisturb,
      cameraId: device(input.cameraId) || null, microphoneId: device(input.microphoneId) || null, speakerId: device(input.speakerId) || null,
    } });
    response.json({ preferences: formatPreferences(preferences) });
  });

  app.patch('/account', requireAuth, async (request, response) => {
    const displayName = isRecord(request.body) && typeof request.body.displayName === 'string' ? request.body.displayName.trim() : '';
    const birthDate = isRecord(request.body) && typeof request.body.birthDate === 'string' ? request.body.birthDate : '';
    if (displayName.length < 2 || displayName.length > 50 || /[\u0000-\u001f\u007f]/u.test(displayName)) { response.status(400).json({ error: 'Use um nome de exibição de 2 a 50 caracteres.' }); return; }
    const date = new Date(`${birthDate}T12:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== birthDate || birthDate > new Date().toISOString().slice(0, 10)) {
      response.status(400).json({ error: 'Informe uma data de nascimento válida.' }); return;
    }
    const user = await prisma.user.update({ where: { id: getAuth(request).user.id }, data: { displayName, birthDate: date } });
    response.json({ user: publicUser(user) });
  });
  app.post('/account/email', rateLimiter(5, 15 * 60_000), requireAuth, async (request, response) => {
    const email = isRecord(request.body) && typeof request.body.email === 'string' ? request.body.email.trim().normalize('NFC') : '';
    const password = isRecord(request.body) && typeof request.body.password === 'string' ? request.body.password : '';
    const user = getAuth(request).user;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) { response.status(400).json({ error: 'Informe um e-mail válido.' }); return; }
    if (!await bcrypt.compare(password, user.passwordHash)) { response.status(401).json({ error: 'Senha atual incorreta.' }); return; }
    if (await prisma.user.findUnique({ where: { emailNormalized: normalize(email) } })) { response.status(409).json({ error: 'Não foi possível utilizar esse e-mail.' }); return; }
    const sent = await issueVerification(user, email, 'email-change');
    if (!sent) { response.status(503).json({ error: 'Não foi possível enviar a confirmação para o novo e-mail.' }); return; }
    response.json({ message: 'Enviamos uma confirmação para o novo e-mail. A alteração só ocorrerá após a verificação.' });
  });
  app.put('/account/password', rateLimiter(8, 15 * 60_000), requireAuth, async (request, response) => {
    const currentPassword = isRecord(request.body) && typeof request.body.currentPassword === 'string' ? request.body.currentPassword : '';
    const newPassword = isRecord(request.body) && typeof request.body.newPassword === 'string' ? request.body.newPassword : '';
    if (newPassword.length < 8 || newPassword.length > 128 || !/[\p{L}]/u.test(newPassword) || !/\p{N}/u.test(newPassword)) { response.status(400).json({ error: 'A nova senha precisa ter ao menos 8 caracteres, uma letra e um número.' }); return; }
    if (!await bcrypt.compare(currentPassword, getAuth(request).user.passwordHash)) { response.status(401).json({ error: 'Senha atual incorreta.' }); return; }
    await prisma.user.update({ where: { id: getAuth(request).user.id }, data: { passwordHash: await bcrypt.hash(newPassword, 12) } });
    await prisma.session.deleteMany({ where: { userId: getAuth(request).user.id, id: { not: getAuth(request).sessionId } } });
    response.json({ message: 'Senha alterada. As outras sessões foram encerradas.' });
  });
  app.get('/account/sessions', requireAuth, async (request, response) => {
    const sessions = await prisma.session.findMany({ where: { userId: getAuth(request).user.id, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: 'desc' } });
    response.json({ sessions: sessions.map(session => ({ id: session.id, current: session.id === getAuth(request).sessionId, createdAt: session.createdAt.toISOString(), lastSeenAt: session.lastSeenAt.toISOString(), userAgent: session.userAgent || 'Dispositivo não identificado', ipAddress: session.ipAddress || 'IP não identificado' })) });
  });
  app.delete('/account/sessions/others', requireAuth, async (request, response) => {
    const result = await prisma.session.deleteMany({ where: { userId: getAuth(request).user.id, id: { not: getAuth(request).sessionId } } });
    response.json({ message: `${result.count} sessão(ões) encerrada(s).` });
  });
  app.delete('/account', requireAuth, async (request, response) => {
    const password = isRecord(request.body) && typeof request.body.password === 'string' ? request.body.password : '';
    const confirmation = isRecord(request.body) && typeof request.body.confirmation === 'string' ? request.body.confirmation : '';
    const user = getAuth(request).user;
    if (confirmation !== user.username || !await bcrypt.compare(password, user.passwordHash)) { response.status(400).json({ error: 'Confirmação ou senha incorreta.' }); return; }
    const owned = await prisma.room.findMany({ where: { createdById: user.id }, select: { id: true } });
    const ownedFiles = owned.length ? await prisma.attachment.findMany({ where: { message: { roomId: { in: owned.map(room => room.id) } } }, select: { storedName: true } }) : [];
    await prisma.$transaction(async transaction => {
      if (owned.length) await transaction.room.deleteMany({ where: { id: { in: owned.map(room => room.id) } } });
      await transaction.user.delete({ where: { id: user.id } });
    });
    await Promise.all(ownedFiles.map(file => unlink(join(fileDirectory, basename(file.storedName))).catch(() => undefined)));
    if (user.avatarPath) await unlink(join(avatarDirectory, basename(user.avatarPath))).catch(() => undefined);
    clearSessionCookie(response); response.status(204).end();
  });

  app.post('/account/avatar', requireAuth, upload.single('avatar'), async (request, response) => {
    const file = request.file;
    const extension = file ? imageExtension(file.buffer) : null;
    if (!file || !extension || file.size > 2 * 1024 * 1024) { response.status(400).json({ error: 'Envie uma imagem PNG, JPEG, WebP ou GIF de até 2 MB.' }); return; }
    const storedName = `${randomUUID()}${extension}`;
    await writeFile(join(avatarDirectory, storedName), file.buffer, { flag: 'wx' });
    const previous = getAuth(request).user.avatarPath;
    const user = await prisma.user.update({ where: { id: getAuth(request).user.id }, data: { avatarPath: storedName } });
    if (previous) await unlink(join(avatarDirectory, basename(previous))).catch(() => undefined);
    response.json({ user: publicUser(user) });
  });
  app.delete('/account/avatar', requireAuth, async (request, response) => {
    const previous = getAuth(request).user.avatarPath;
    const user = await prisma.user.update({ where: { id: getAuth(request).user.id }, data: { avatarPath: null } });
    if (previous) await unlink(join(avatarDirectory, basename(previous))).catch(() => undefined);
    response.json({ user: publicUser(user) });
  });
  app.get('/users/:id/avatar', requireAuth, async (request, response) => {
    const user = await prisma.user.findUnique({ where: { id: routeId(request.params.id) }, select: { avatarPath: true } });
    if (!user?.avatarPath) { response.status(404).end(); return; }
    const file = join(avatarDirectory, basename(user.avatarPath));
    try { response.type(extname(file)).setHeader('Cache-Control', 'private, max-age=86400'); response.send(await readFile(file)); }
    catch { response.status(404).end(); }
  });

  app.patch('/rooms/:id', requireAuth, async (request, response) => {
    const room = await prisma.room.findUnique({ where: { id: routeId(request.params.id) }, select: roomSelect });
    if (!room || room.createdBy.id !== getAuth(request).user.id) { response.status(403).json({ error: 'Somente o proprietário pode editar esta sala.' }); return; }
    const name = isRecord(request.body) && typeof request.body.name === 'string' ? request.body.name.trim() : '';
    const description = isRecord(request.body) && typeof request.body.description === 'string' ? request.body.description.trim() : '';
    if (name.length < 2 || name.length > 60 || description.length > 280) { response.status(400).json({ error: 'Use nome de 2 a 60 caracteres e descrição de até 280.' }); return; }
    const updated = await prisma.room.update({ where: { id: room.id }, data: { name, description }, select: roomSelect });
    const membership = await memberFor(request, room.id); response.json({ room: formatRoom(updated, membership ?? undefined) });
  });
  app.put('/rooms/:id/favorite', requireAuth, async (request, response) => {
    const favorite = isRecord(request.body) && typeof request.body.favorite === 'boolean' ? request.body.favorite : null;
    const member = await memberFor(request, routeId(request.params.id));
    if (!member || favorite === null) { response.status(400).json({ error: 'Sala ou preferência inválida.' }); return; }
    await prisma.roomMember.update({ where: { userId_roomId: { userId: member.userId, roomId: member.roomId } }, data: { favorite } }); response.json({ favorite });
  });
  app.put('/rooms/:id/notifications', requireAuth, async (request, response) => {
    const enabled = isRecord(request.body) && typeof request.body.enabled === 'boolean' ? request.body.enabled : null;
    const member = await memberFor(request, routeId(request.params.id));
    if (!member || enabled === null) { response.status(400).json({ error: 'Sala ou preferência inválida.' }); return; }
    await prisma.roomMember.update({ where: { userId_roomId: { userId: member.userId, roomId: member.roomId } }, data: { notificationsEnabled: enabled } }); response.json({ enabled });
  });
  app.post('/rooms/:id/read', requireAuth, async (request, response) => {
    const member = await memberFor(request, routeId(request.params.id));
    if (!member) { response.status(403).json({ error: 'Você não tem acesso a esta sala.' }); return; }
    await prisma.roomMember.update({ where: { userId_roomId: { userId: member.userId, roomId: member.roomId } }, data: { lastReadAt: new Date() } }); response.status(204).end();
  });
  app.get('/rooms/:id/members', requireAuth, async (request, response) => {
    const roomId = routeId(request.params.id);
    if (!await memberFor(request, roomId)) { response.status(403).json({ error: 'Você não tem acesso a esta sala.' }); return; }
    const [room, members] = await Promise.all([
      prisma.room.findUnique({ where: { id: roomId }, select: { createdById: true } }),
      prisma.roomMember.findMany({ where: { roomId }, include: { user: true }, orderBy: { joinedAt: 'asc' } }),
    ]);
    response.json({ members: members.map(item => ({ ...publicUser(item.user), owner: item.userId === room?.createdById })) });
  });
  app.get('/rooms/:id/messages/search', requireAuth, async (request, response) => {
    const roomId = routeId(request.params.id);
    if (!await memberFor(request, roomId)) { response.status(403).json({ error: 'Você não tem acesso a esta sala.' }); return; }
    const query = typeof request.query.q === 'string' ? request.query.q.trim() : '';
    if (query.length < 2 || query.length > 100) { response.status(400).json({ error: 'Digite entre 2 e 100 caracteres.' }); return; }
    const messages = await prisma.mensagem.findMany({ where: { roomId, deletedAt: null, OR: [{ texto: { contains: query } }, { autor: { contains: query } }] }, include: messageInclude, orderBy: { criadoEm: 'desc' }, take: 100 });
    response.json({ messages: messages.map(message => formatMessage(message, getAuth(request).user.id)).reverse() });
  });
  app.get('/rooms/:id/messages', requireAuth, async (request, response) => {
    const roomId = routeId(request.params.id);
    if (!await memberFor(request, roomId)) { response.status(403).json({ error: 'Você não tem acesso a esta sala.' }); return; }
    const before = typeof request.query.before === 'string' ? Number(request.query.before) : 0;
    const limit = Math.min(100, Math.max(10, Number(request.query.limit) || 50));
    const messages = await prisma.mensagem.findMany({
      where: { roomId, ...(Number.isInteger(before) && before > 0 ? { id: { lt: before } } : {}) },
      include: messageInclude,
      orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = messages.length > limit;
    response.json({ messages: messages.slice(0, limit).reverse().map(message => formatMessage(message, getAuth(request).user.id)), hasMore });
  });
  app.get('/rooms/:id/qr', requireAuth, async (request, response) => {
    const roomId = routeId(request.params.id);
    const member = await memberFor(request, roomId);
    if (!member) { response.status(403).json({ error: 'Você não tem acesso a esta sala.' }); return; }
    const room = await prisma.room.findUnique({ where: { id: roomId }, select: { code: true } });
    if (!room) { response.status(404).end(); return; }
    const frontend = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    response.type('png').setHeader('Cache-Control', 'no-store'); response.send(await QRCode.toBuffer(`${frontend}/join/${room.code}`, { width: 360, margin: 2, color: { dark: '#17111f', light: '#ffffff' } }));
  });
  app.get('/rooms/:id/calls', requireAuth, async (request, response) => {
    const roomId = routeId(request.params.id);
    if (!await memberFor(request, roomId)) { response.status(403).json({ error: 'Você não tem acesso a esta sala.' }); return; }
    const calls = await prisma.callHistory.findMany({ where: { roomId }, include: { participants: { include: { user: true } } }, orderBy: { startedAt: 'desc' }, take: 30 });
    response.json({ calls: calls.map(call => ({ id: call.id, startedAt: call.startedAt.toISOString(), endedAt: call.endedAt?.toISOString() ?? null, participants: call.participants.map(item => item.user.displayName || item.user.username) })) });
  });

  const meetingAccess = async (request: express.Request, response: express.Response) => {
    const roomId = routeId(request.params.id);
    const membership = await memberFor(request, roomId);
    if (!membership) { response.status(403).json({ error: 'Você não tem acesso a esta sala.' }); return null; }
    return roomId;
  };
  app.get('/rooms/:id/meeting', requireAuth, async (request, response) => {
    const roomId = await meetingAccess(request, response); if (!roomId) return;
    const [agenda, decisions, actions] = await Promise.all([
      prisma.agendaItem.findMany({ where: { roomId }, include: { createdBy: true }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
      prisma.decision.findMany({ where: { roomId }, include: { author: true }, orderBy: { createdAt: 'desc' } }),
      prisma.actionItem.findMany({ where: { roomId }, include: { assignee: true, createdBy: true }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] }),
    ]);
    response.json({
      agenda: agenda.map(item => ({ id: item.id, text: item.text, completed: item.completed, position: item.position, resolvedAsyncAt: item.resolvedAsyncAt?.toISOString() ?? null, createdBy: item.createdBy.displayName || item.createdBy.username })),
      decisions: decisions.map(item => ({ id: item.id, text: item.text, createdAt: item.createdAt.toISOString(), author: item.author.displayName || item.author.username, authorId: item.authorId })),
      actions: actions.map(item => ({ id: item.id, description: item.description, status: item.status, deadline: item.deadline?.toISOString() ?? null, assignee: item.assignee ? publicUser(item.assignee) : null, createdBy: item.createdBy.displayName || item.createdBy.username, createdById: item.createdById })),
    });
  });
  app.post('/rooms/:id/agenda', requireAuth, async (request, response) => {
    const roomId = await meetingAccess(request, response); if (!roomId) return;
    const text = isRecord(request.body) && typeof request.body.text === 'string' ? request.body.text.trim() : '';
    if (!text || text.length > 240) { response.status(400).json({ error: 'O item da agenda deve ter até 240 caracteres.' }); return; }
    const position = await prisma.agendaItem.count({ where: { roomId } });
    const item = await prisma.agendaItem.create({ data: { roomId, text, position, createdById: getAuth(request).user.id } });
    response.status(201).json({ item: { ...item, createdAt: item.createdAt.toISOString(), resolvedAsyncAt: null } });
  });
  app.patch('/rooms/:id/agenda/:itemId', requireAuth, async (request, response) => {
    const roomId = await meetingAccess(request, response); if (!roomId) return;
    const existing = await prisma.agendaItem.findFirst({ where: { id: routeId(request.params.itemId), roomId } });
    if (!existing || !isRecord(request.body)) { response.status(404).json({ error: 'Item não encontrado.' }); return; }
    const data: Prisma.AgendaItemUpdateInput = {};
    if (typeof request.body.text === 'string') { const text = request.body.text.trim(); if (!text || text.length > 240) { response.status(400).json({ error: 'Texto inválido.' }); return; } data.text = text; }
    if (typeof request.body.completed === 'boolean') data.completed = request.body.completed;
    if (typeof request.body.position === 'number' && Number.isInteger(request.body.position)) data.position = request.body.position;
    if (typeof request.body.resolvedAsync === 'boolean') data.resolvedAsyncAt = request.body.resolvedAsync ? new Date() : null;
    const item = await prisma.agendaItem.update({ where: { id: existing.id }, data }); response.json({ item });
  });
  app.delete('/rooms/:id/agenda/:itemId', requireAuth, async (request, response) => {
    const roomId = await meetingAccess(request, response); if (!roomId) return;
    const result = await prisma.agendaItem.deleteMany({ where: { id: routeId(request.params.itemId), roomId } });
    if (!result.count) { response.status(404).json({ error: 'Item não encontrado.' }); return; } response.status(204).end();
  });
  app.post('/rooms/:id/decisions', requireAuth, async (request, response) => {
    const roomId = await meetingAccess(request, response); if (!roomId) return;
    const text = isRecord(request.body) && typeof request.body.text === 'string' ? request.body.text.trim() : '';
    if (!text || text.length > 500) { response.status(400).json({ error: 'A decisão deve ter até 500 caracteres.' }); return; }
    const decision = await prisma.decision.create({ data: { roomId, text, authorId: getAuth(request).user.id }, include: { author: true } });
    response.status(201).json({ decision: { id: decision.id, text, author: decision.author.displayName || decision.author.username, authorId: decision.authorId, createdAt: decision.createdAt.toISOString() } });
  });
  app.delete('/rooms/:id/decisions/:itemId', requireAuth, async (request, response) => {
    const roomId = await meetingAccess(request, response); if (!roomId) return;
    const room = await prisma.room.findUnique({ where: { id: roomId }, select: { createdById: true } });
    const result = await prisma.decision.deleteMany({ where: { id: routeId(request.params.itemId), roomId, ...(room?.createdById === getAuth(request).user.id ? {} : { authorId: getAuth(request).user.id }) } });
    if (!result.count) { response.status(403).json({ error: 'Você não pode excluir esta decisão.' }); return; } response.status(204).end();
  });
  app.post('/rooms/:id/actions', requireAuth, async (request, response) => {
    const roomId = await meetingAccess(request, response); if (!roomId) return;
    const description = isRecord(request.body) && typeof request.body.description === 'string' ? request.body.description.trim() : '';
    const assigneeId = isRecord(request.body) && typeof request.body.assigneeId === 'string' && request.body.assigneeId ? request.body.assigneeId : null;
    const deadlineRaw = isRecord(request.body) && typeof request.body.deadline === 'string' ? request.body.deadline : '';
    const deadline = deadlineRaw ? new Date(`${deadlineRaw}T23:59:59.000Z`) : null;
    if (!description || description.length > 500 || (deadline && Number.isNaN(deadline.getTime()))) { response.status(400).json({ error: 'Tarefa inválida.' }); return; }
    if (assigneeId && !await prisma.roomMember.findUnique({ where: { userId_roomId: { userId: assigneeId, roomId } } })) { response.status(400).json({ error: 'O responsável precisa participar da sala.' }); return; }
    const action = await prisma.actionItem.create({ data: { roomId, description, assigneeId, deadline, createdById: getAuth(request).user.id }, include: { assignee: true } });
    response.status(201).json({ action: { ...action, deadline: action.deadline?.toISOString() ?? null, assignee: action.assignee ? publicUser(action.assignee) : null } });
  });
  app.patch('/rooms/:id/actions/:itemId', requireAuth, async (request, response) => {
    const roomId = await meetingAccess(request, response); if (!roomId) return;
    const existing = await prisma.actionItem.findFirst({ where: { id: routeId(request.params.itemId), roomId } });
    if (!existing || !isRecord(request.body)) { response.status(404).json({ error: 'Tarefa não encontrada.' }); return; }
    const data: Prisma.ActionItemUpdateInput = {};
    if (typeof request.body.description === 'string') { const description = request.body.description.trim(); if (!description || description.length > 500) { response.status(400).json({ error: 'Descrição inválida.' }); return; } data.description = description; }
    if (typeof request.body.status === 'string' && ['pending', 'doing', 'done'].includes(request.body.status)) data.status = request.body.status;
    if (request.body.assigneeId === null) data.assignee = { disconnect: true };
    else if (typeof request.body.assigneeId === 'string') {
      if (!await prisma.roomMember.findUnique({ where: { userId_roomId: { userId: request.body.assigneeId, roomId } } })) { response.status(400).json({ error: 'Responsável inválido.' }); return; }
      data.assignee = { connect: { id: request.body.assigneeId } };
    }
    const action = await prisma.actionItem.update({ where: { id: existing.id }, data, include: { assignee: true } }); response.json({ action });
  });
  app.delete('/rooms/:id/actions/:itemId', requireAuth, async (request, response) => {
    const roomId = await meetingAccess(request, response); if (!roomId) return;
    const result = await prisma.actionItem.deleteMany({ where: { id: routeId(request.params.itemId), roomId } });
    if (!result.count) { response.status(404).json({ error: 'Tarefa não encontrada.' }); return; } response.status(204).end();
  });

  const server = http.createServer(app);
  const io = new Server<ClientEvents, ServerEvents, Record<string, never>, SocketData>(server, {
    cors: { origin: allowedOrigins, credentials: true }, maxHttpBufferSize: 256_000,
    pingInterval: 10_000, pingTimeout: 10_000,
  });
  const calls = new Map<string, { id: string; startedAt: Date; ready: Promise<unknown>; participants: Map<string, CallParticipant> }>();
  const typing = new Map<string, Set<string>>();
  io.use(async (socket, next) => {
    try {
      const auth = await sessionUser(prisma, socket.handshake.headers.cookie);
      if (!auth) { next(new Error('unauthorized')); return; }
      socket.data.userId = auth.user.id;
      socket.data.username = auth.user.username;
      socket.data.displayName = auth.user.displayName || auth.user.username;
      socket.data.avatarUrl = avatarUrl(auth.user);
      const preferences = await prisma.userPreference.findUnique({ where: { userId: auth.user.id }, select: { status: true } });
      socket.data.status = (preferences?.status ?? 'online') as PresenceStatus;
      socket.data.sessionId = auth.sessionId;
      socket.data.sessionCheckedAt = Date.now();
      next();
    } catch { next(new Error('unauthorized')); }
  });

  function snapshot(sala: string): RoomCall {
    const call = calls.get(sala);
    return { sala, callId: call?.id ?? null, startedAt: call?.startedAt.toISOString() ?? null, participants: [...(call?.participants.values() ?? [])] };
  }
  function presence(sala: string) {
    const ids = io.sockets.adapter.rooms.get(channelKey(sala)) ?? [];
    const unique = new Map<string, { userId: string; socketId: string; username: string; displayName: string; avatarUrl: string | null; status: PresenceStatus; inCall: boolean }>();
    for (const id of ids) {
      const client = io.sockets.sockets.get(id);
      if (!client?.data.userId) continue;
      const previous = unique.get(client.data.userId);
      const inCall = calls.get(sala)?.participants.has(id) ?? false;
      if (!previous || inCall) unique.set(client.data.userId, {
        userId: client.data.userId, socketId: id, username: client.data.username, displayName: client.data.displayName,
        avatarUrl: client.data.avatarUrl, status: client.data.status, inCall: inCall || previous?.inCall || false,
      });
    }
    io.to(channelKey(sala)).emit('usuarios_online', { sala, users: [...unique.values()] });
  }
  function broadcastCall(sala: string) {
    io.to(channelKey(sala)).emit('chamada_atualizada', snapshot(sala));
    presence(sala);
  }
  function broadcastTyping(sala: string) {
    const users = new Map<string, { userId: string; displayName: string }>();
    for (const socketId of typing.get(sala) ?? []) {
      const client = io.sockets.sockets.get(socketId);
      if (client?.data.userId && client.data.sala === sala) users.set(client.data.userId, { userId: client.data.userId, displayName: client.data.displayName });
    }
    io.to(channelKey(sala)).emit('usuarios_digitando', { sala, users: [...users.values()] });
  }
  function stopTyping(socket: ClientSocket, sala = socket.data.sala) {
    if (!sala) return;
    const active = typing.get(sala); if (!active?.delete(socket.id)) return;
    if (!active.size) typing.delete(sala); broadcastTyping(sala);
  }
  function leaveCall(socket: ClientSocket, reason: CallLeft['reason']) {
    const sala = socket.data.sala;
    const call = sala ? calls.get(sala) : undefined;
    const participant = call?.participants.get(socket.id);
    if (!sala || !call || !participant) return;
    call.participants.delete(socket.id);
    void prisma.callAttendance.updateMany({ where: { callId: call.id, userId: participant.userId, leftAt: null }, data: { leftAt: new Date() } });
    if (call.participants.size === 0) { calls.delete(sala); void prisma.callHistory.update({ where: { id: call.id }, data: { endedAt: new Date() } }).catch(() => undefined); }
    socket.to(channelKey(sala)).emit('participante_saiu', {
      sala, callId: call.id, socketId: socket.id, username: participant.username, reason,
    });
    broadcastCall(sala);
  }
  function reject(socket: ClientSocket, ack: unknown, error: string, code?: string) {
    if (typeof ack === 'function') (ack as Ack)({ ok: false, error, code });
    else socket.emit('erro_operacao', error);
  }
  function signalTarget(socket: ClientSocket, data: unknown) {
    if (!isRecord(data) || !validId(data.to) || !validId(data.callId) || data.sala !== socket.data.sala) return null;
    const call = calls.get(socket.data.sala ?? '');
    if (socket.data.joining || !call || call.id !== data.callId || data.to === socket.id || !call.participants.has(socket.id) || !call.participants.has(data.to)) return null;
    return { to: data.to, sala: socket.data.sala!, callId: call.id, from: socket.id };
  }
  async function mentionIds(roomId: string, text: string) {
    const names = [...text.matchAll(/@([\p{L}\p{N}_.-]{3,32})/gu)].map(match => normalize(match[1]!));
    if (!names.length) return [];
    const members = await prisma.roomMember.findMany({ where: { roomId, user: { usernameNormalized: { in: [...new Set(names)] } } }, select: { userId: true } });
    return members.map(member => member.userId);
  }
  async function notifyMessage(message: SelectedMessage, authorId: string) {
    const mentions = new Set(message.mentions.map(item => item.userId));
    const members = await prisma.roomMember.findMany({ where: { roomId: message.roomId!, userId: { not: authorId } }, select: {
      userId: true, notificationsEnabled: true,
      user: { select: { preferences: { select: { doNotDisturb: true, messageNotifications: true, mentionNotifications: true } } } },
    } });
    for (const member of members) {
      const mentioned = mentions.has(member.userId);
      const preference = member.user.preferences;
      if (preference?.doNotDisturb || (mentioned ? preference?.mentionNotifications === false : preference?.messageNotifications === false)) continue;
      if (!member.notificationsEnabled && !mentioned) continue;
      io.to(userKey(member.userId)).emit('sala_notificada', {
        roomId: message.roomId!, messageId: message.id, mention: mentioned, author: message.user?.displayName || message.autor, preview: message.texto.slice(0, 120),
      });
    }
  }
  async function notifyCall(roomId: string, callId: string, authorId: string, startedBy: string) {
    const members = await prisma.roomMember.findMany({ where: { roomId, userId: { not: authorId }, notificationsEnabled: true }, select: {
      userId: true, user: { select: { preferences: { select: { doNotDisturb: true, callNotifications: true } } } },
    } });
    for (const member of members) if (!member.user.preferences?.doNotDisturb && member.user.preferences?.callNotifications !== false) {
      io.to(userKey(member.userId)).emit('chamada_notificada', { roomId, callId, startedBy });
    }
  }
  async function loadMessage(messageId: number) {
    return prisma.mensagem.findUniqueOrThrow({ where: { id: messageId }, include: messageInclude });
  }

  app.post('/rooms/:id/attachments', requireAuth, upload.single('file'), async (request, response) => {
    const roomId = routeId(request.params.id);
    const member = await memberFor(request, roomId);
    const file = request.file;
    const accepted = file ? safeAttachment(file) : null;
    const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
    const replyToId = Number.isInteger(Number(request.body?.replyToId)) && Number(request.body.replyToId) > 0 ? Number(request.body.replyToId) : null;
    if (!member) { response.status(403).json({ error: 'Você não tem acesso a esta sala.' }); return; }
    if (!file || !accepted) { response.status(400).json({ error: 'Tipo de arquivo não permitido. Use imagem, PDF, documento, planilha, apresentação, ZIP, TXT ou CSV.' }); return; }
    if (text.length > 4000) { response.status(400).json({ error: 'A legenda deve ter até 4.000 caracteres.' }); return; }
    if (replyToId && !await prisma.mensagem.findFirst({ where: { id: replyToId, roomId } })) { response.status(400).json({ error: 'A mensagem respondida não existe nesta sala.' }); return; }
    const storedName = `${randomUUID()}${accepted.extension}`;
    await writeFile(join(fileDirectory, storedName), file.buffer, { flag: 'wx' });
    try {
      const mentions = await mentionIds(roomId, text);
      const created = await prisma.mensagem.create({ data: {
        sala: roomId, roomId, userId: getAuth(request).user.id, autor: getAuth(request).user.username,
        texto: text, replyToId,
        mentions: mentions.length ? { create: mentions.map(userId => ({ userId })) } : undefined,
        attachments: { create: { name: safeName(file.originalname), mimeType: accepted.mimeType, size: file.size, storedName } },
      }, include: messageInclude });
      io.to(channelKey(roomId)).emit('nova_mensagem', formatMessage(created));
      await notifyMessage(created, getAuth(request).user.id);
      response.status(201).json({ message: formatMessage(created, getAuth(request).user.id) });
    } catch (error) {
      await unlink(join(fileDirectory, storedName)).catch(() => undefined);
      console.error('Falha ao salvar anexo:', error instanceof Error ? error.message : 'erro desconhecido');
      response.status(500).json({ error: 'Não foi possível enviar o arquivo.' });
    }
  });
  app.get('/attachments/:id/download', requireAuth, async (request, response) => {
    const attachment = await prisma.attachment.findUnique({
      where: { id: routeId(request.params.id) }, include: { message: { select: { roomId: true, deletedAt: true } } },
    });
    if (!attachment?.message.roomId || attachment.message.deletedAt || !await memberFor(request, attachment.message.roomId)) { response.status(404).end(); return; }
    try {
      const contents = await readFile(join(fileDirectory, basename(attachment.storedName)));
      response.type(attachment.mimeType);
      response.setHeader('Content-Length', String(attachment.size));
      response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
      response.send(contents);
    } catch { response.status(404).end(); }
  });

  io.on('connection', socket => {
    socket.data.revision = 0;
    socket.data.joining = false;
    void socket.join(userKey(socket.data.userId));
    socket.use(async (_event, next) => {
      try {
        if (Date.now() - socket.data.sessionCheckedAt < 30_000) { next(); return; }
        const session = await prisma.session.findUnique({ where: { id: socket.data.sessionId }, select: { expiresAt: true } });
        if (!session || session.expiresAt <= new Date()) {
          socket.emit('erro_operacao', 'Sua sessão expirou. Entre novamente.'); socket.disconnect(true); return;
        }
        socket.data.sessionCheckedAt = Date.now();
        next();
      } catch { socket.emit('erro_operacao', 'Não foi possível validar sua sessão.'); socket.disconnect(true); }
    });
    socket.on('entrar_sala', async (request: unknown, ack) => {
      if (!isRecord(request) || !validId(request.sala) || !validId(request.requestId)) {
        reject(socket, ack, 'Informe uma sala válida.'); return;
      }
      const sala = request.sala;
      const member = await prisma.roomMember.findUnique({ where: { userId_roomId: { userId: socket.data.userId, roomId: sala } } });
      if (!member) { reject(socket, ack, 'Você não tem acesso a esta sala.', 'ROOM_FORBIDDEN'); return; }
      const previousRoom = socket.data.sala;
      const revision = ++socket.data.revision;
      socket.data.joining = true;
      leaveCall(socket, 'room-change'); stopTyping(socket, previousRoom);
      if (previousRoom) await socket.leave(channelKey(previousRoom));
      socket.data.sala = sala;
      await socket.join(channelKey(sala));
      if (previousRoom) presence(previousRoom);
      presence(sala);
      socket.emit('chamada_atualizada', snapshot(sala));
      try {
        const recent = await prisma.mensagem.findMany({ where: { roomId: sala }, include: messageInclude, orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }], take: 51 });
        const hasMore = recent.length > 50;
        const messages = recent.slice(0, 50).reverse();
        if (!socket.connected || revision !== socket.data.revision) return;
        socket.data.joining = false;
        socket.emit('historico_mensagens', { sala, requestId: request.requestId, mensagens: messages.map(message => formatMessage(message, socket.data.userId)), hasMore });
        await prisma.roomMember.update({ where: { userId_roomId: { userId: socket.data.userId, roomId: sala } }, data: { lastReadAt: new Date() } });
        if (typeof ack === 'function') ack({ ok: true, data: undefined });
      } catch (error) {
        console.error('Falha ao carregar histórico:', error instanceof Error ? error.message : 'erro desconhecido');
        if (socket.connected && revision === socket.data.revision) reject(socket, ack, 'Não foi possível carregar a sala. Tente reconectar.');
      }
    });

    socket.on('mensagem_chat', async (data: unknown, ack) => {
      if (!isRecord(data) || !socket.data.sala || socket.data.joining || data.sala !== socket.data.sala || typeof data.texto !== 'string' || !data.texto.trim() || data.texto.length > 4000
        || (data.clientMessageId !== undefined && (!validId(data.clientMessageId) || data.clientMessageId.length > 100))) {
        reject(socket, ack, 'Envie uma mensagem de até 4.000 caracteres na sala atual.'); return;
      }
      const sala = socket.data.sala;
      const member = await prisma.roomMember.findUnique({ where: { userId_roomId: { userId: socket.data.userId, roomId: sala } } });
      if (!member) { reject(socket, ack, 'Você não tem acesso a esta sala.'); return; }
      try {
        const clientMessageId = typeof data.clientMessageId === 'string' ? data.clientMessageId : null;
        if (clientMessageId) {
          const existing = await prisma.mensagem.findUnique({ where: { clientMessageId }, include: messageInclude });
          if (existing) {
            if (existing.roomId !== sala || existing.userId !== socket.data.userId) { reject(socket, ack, 'Identificador de mensagem inválido.'); return; }
            if (typeof ack === 'function') ack({ ok: true, data: formatMessage(existing, socket.data.userId) });
            return;
          }
        }
        const replyToId = Number.isInteger(data.replyToId) && Number(data.replyToId) > 0 ? Number(data.replyToId) : null;
        if (replyToId && !await prisma.mensagem.findFirst({ where: { id: replyToId, roomId: sala } })) { reject(socket, ack, 'A mensagem respondida não existe nesta sala.'); return; }
        const text = data.texto.trim();
        const mentions = await mentionIds(sala, text);
        const created = await prisma.mensagem.create({ data: {
          sala, roomId: sala, userId: socket.data.userId, autor: socket.data.username, texto: text, replyToId, clientMessageId,
          mentions: mentions.length ? { create: mentions.map(userId => ({ userId })) } : undefined,
        }, include: messageInclude });
        const message = formatMessage(created);
        io.to(channelKey(sala)).emit('nova_mensagem', message);
        if (typeof ack === 'function') ack({ ok: true, data: formatMessage(created, socket.data.userId) });
        void notifyMessage(created, socket.data.userId).catch(error => console.error('Falha ao notificar mensagem:', error instanceof Error ? error.message : 'erro desconhecido'));
      } catch (error) {
        const clientMessageId = typeof data.clientMessageId === 'string' ? data.clientMessageId : null;
        if (clientMessageId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const existing = await prisma.mensagem.findUnique({ where: { clientMessageId }, include: messageInclude });
          if (existing?.roomId === sala && existing.userId === socket.data.userId) {
            if (typeof ack === 'function') ack({ ok: true, data: formatMessage(existing, socket.data.userId) });
            return;
          }
        }
        reject(socket, ack, 'A mensagem não foi salva. Tente enviar novamente.');
      }
    });

    socket.on('editar_mensagem', async (data: unknown, ack) => {
      if (!isRecord(data) || data.sala !== socket.data.sala || !Number.isInteger(data.messageId) || typeof data.texto !== 'string' || !data.texto.trim() || data.texto.length > 4000) { reject(socket, ack, 'Edição inválida.'); return; }
      const existing = await prisma.mensagem.findFirst({ where: { id: Number(data.messageId), roomId: socket.data.sala, userId: socket.data.userId, deletedAt: null } });
      if (!existing) { reject(socket, ack, 'Você só pode editar suas próprias mensagens.'); return; }
      const text = data.texto.trim(); const mentions = await mentionIds(socket.data.sala!, text);
      await prisma.$transaction(async transaction => {
        await transaction.messageMention.deleteMany({ where: { messageId: existing.id } });
        await transaction.mensagem.update({ where: { id: existing.id }, data: { texto: text, editedAt: new Date(), mentions: mentions.length ? { create: mentions.map(userId => ({ userId })) } : undefined } });
      });
      const updated = await loadMessage(existing.id); const message = formatMessage(updated);
      io.to(channelKey(socket.data.sala!)).emit('mensagem_atualizada', message);
      if (typeof ack === 'function') ack({ ok: true, data: formatMessage(updated, socket.data.userId) });
    });
    socket.on('excluir_mensagem', async (data: unknown, ack) => {
      if (!isRecord(data) || data.sala !== socket.data.sala || !Number.isInteger(data.messageId)) { reject(socket, ack, 'Exclusão inválida.'); return; }
      const existing = await prisma.mensagem.findFirst({ where: { id: Number(data.messageId), roomId: socket.data.sala, userId: socket.data.userId, deletedAt: null }, include: { attachments: { select: { storedName: true } } } });
      if (!existing) { reject(socket, ack, 'Você só pode excluir suas próprias mensagens.'); return; }
      await prisma.mensagem.update({ where: { id: existing.id }, data: { texto: '', deletedAt: new Date(), mentions: { deleteMany: {} }, attachments: { deleteMany: {} } } });
      await Promise.all(existing.attachments.map(file => unlink(join(fileDirectory, basename(file.storedName))).catch(() => undefined)));
      const updated = await loadMessage(existing.id); const message = formatMessage(updated);
      io.to(channelKey(socket.data.sala!)).emit('mensagem_atualizada', message);
      if (typeof ack === 'function') ack({ ok: true, data: formatMessage(updated, socket.data.userId) });
    });
    socket.on('marcar_sala_lida', async data => {
      if (!isRecord(data) || data.sala !== socket.data.sala) return;
      await prisma.roomMember.updateMany({ where: { roomId: data.sala as string, userId: socket.data.userId }, data: { lastReadAt: new Date() } });
    });
    socket.on('digitando', data => {
      if (!isRecord(data) || data.sala !== socket.data.sala || typeof data.typing !== 'boolean' || socket.data.joining) return;
      const sala = socket.data.sala; if (!sala) return;
      const active = typing.get(sala) ?? new Set<string>();
      if (data.typing) { active.add(socket.id); typing.set(sala, active); } else { active.delete(socket.id); if (!active.size) typing.delete(sala); }
      broadcastTyping(sala);
    });

    socket.on('entrar_chamada', async (data: unknown, ack) => {
      if (!isRecord(data) || !socket.data.sala || socket.data.joining || data.sala !== socket.data.sala || !validId(data.attemptId)) {
        reject(socket, ack, 'Entre na sala antes de iniciar a chamada.'); return;
      }
      const sala = socket.data.sala;
      const member = await prisma.roomMember.findUnique({ where: { userId_roomId: { userId: socket.data.userId, roomId: sala } } });
      if (!member) { reject(socket, ack, 'Você não tem acesso a esta sala.'); return; }
      let call = calls.get(sala);
      if (call?.participants.has(socket.id) || [...(call?.participants.values() ?? [])].some(participant => participant.userId === socket.data.userId)) {
        reject(socket, ack, 'Você já está nesta chamada.'); return;
      }
      if (call && call.participants.size >= MAX_CALL_PARTICIPANTS) {
        reject(socket, ack, 'A chamada atingiu o limite de 15 participantes.', 'CALL_FULL'); return;
      }
      const isNewCall = !call;
      if (!call) {
        const id = randomUUID();
        const startedAt = new Date();
        call = { id, startedAt, ready: prisma.callHistory.create({ data: { id, roomId: sala, startedAt } }), participants: new Map() };
        calls.set(sala, call);
      }
      try {
        await call.ready;
        await prisma.callAttendance.upsert({
          where: { callId_userId: { callId: call.id, userId: socket.data.userId } },
          create: { callId: call.id, userId: socket.data.userId },
          update: { joinedAt: new Date(), leftAt: null },
        });
      } catch {
        if (call.participants.size === 0) calls.delete(sala);
        reject(socket, ack, 'Não foi possível registrar a chamada. Tente novamente.'); return;
      }
      call.participants.set(socket.id, {
        socketId: socket.id, userId: socket.data.userId, username: socket.data.username,
        displayName: socket.data.displayName, avatarUrl: socket.data.avatarUrl, status: socket.data.status, inCall: true,
        microphone: true, camera: true, screen: false, attemptId: data.attemptId,
        handRaisedAt: null,
      });
      if (typeof ack === 'function') ack({ ok: true, data: snapshot(sala) });
      broadcastCall(sala);
      if (isNewCall) void notifyCall(sala, call.id, socket.data.userId, socket.data.displayName);
    });
    socket.on('sair_chamada', (data: unknown) => {
      if (!isRecord(data) || data.sala !== socket.data.sala) return;
      const participant = calls.get(socket.data.sala ?? '')?.participants.get(socket.id);
      if (participant?.attemptId === data.attemptId) leaveCall(socket, 'left');
    });
    socket.on('atualizar_midia', (data: unknown) => {
      if (!isRecord(data) || data.sala !== socket.data.sala || typeof data.microphone !== 'boolean' || typeof data.camera !== 'boolean' || typeof data.screen !== 'boolean') return;
      const participant = calls.get(socket.data.sala ?? '')?.participants.get(socket.id);
      if (!participant || participant.attemptId !== data.attemptId) return;
      Object.assign(participant, { microphone: data.microphone, camera: data.camera, screen: data.screen });
      broadcastCall(socket.data.sala!);
    });
    socket.on('atualizar_mao', (data: unknown) => {
      if (!isRecord(data) || data.sala !== socket.data.sala || typeof data.raised !== 'boolean') return;
      const participant = calls.get(socket.data.sala ?? '')?.participants.get(socket.id);
      if (!participant || participant.attemptId !== data.attemptId) return;
      participant.handRaisedAt = data.raised ? new Date().toISOString() : null;
      broadcastCall(socket.data.sala!);
    });
    socket.on('enviar_reacao', (data: unknown) => {
      const allowed = new Set(['👍', '👏', '❤️', '😂', '🎉', '🤔']);
      if (!isRecord(data) || data.sala !== socket.data.sala || typeof data.emoji !== 'string' || !allowed.has(data.emoji)) return;
      const call = calls.get(socket.data.sala ?? '');
      const participant = call?.participants.get(socket.id);
      if (!call || !participant || participant.attemptId !== data.attemptId) return;
      io.to(channelKey(socket.data.sala!)).emit('reacao_chamada', {
        id: randomUUID(), sala: socket.data.sala!, callId: call.id, userId: socket.data.userId,
        username: socket.data.username, displayName: socket.data.displayName, emoji: data.emoji, createdAt: new Date().toISOString(),
      });
    });
    socket.on('atualizar_status', async data => {
      if (!isRecord(data) || !['online', 'busy', 'dnd', 'away'].includes(String(data.status))) return;
      socket.data.status = data.status as PresenceStatus;
      await prisma.userPreference.upsert({ where: { userId: socket.data.userId }, create: { userId: socket.data.userId, status: socket.data.status }, update: { status: socket.data.status } });
      for (const client of io.sockets.sockets.values()) if (client.data.userId === socket.data.userId) client.data.status = socket.data.status;
      if (socket.data.sala) presence(socket.data.sala);
    });
    socket.on('atualizar_perfil', async () => {
      const user = await prisma.user.findUnique({ where: { id: socket.data.userId } });
      if (!user) return;
      const displayName = user.displayName || user.username; const picture = avatarUrl(user);
      const affectedRooms = new Set<string>();
      for (const client of io.sockets.sockets.values()) {
        if (client.data.userId !== user.id) continue;
        client.data.displayName = displayName; client.data.avatarUrl = picture;
        if (client.data.sala) affectedRooms.add(client.data.sala);
      }
      for (const [roomId, call] of calls) {
        let changed = false;
        for (const participant of call.participants.values()) if (participant.userId === user.id) {
          participant.displayName = displayName; participant.avatarUrl = picture; changed = true;
        }
        if (changed) affectedRooms.add(roomId);
      }
      for (const roomId of affectedRooms) broadcastCall(roomId);
    });
    socket.on('webrtc_offer', (data: unknown) => {
      const target = signalTarget(socket, data);
      if (!target || !isRecord(data) || !isRecord(data.offer) || data.offer.type !== 'offer' || typeof data.offer.sdp !== 'string' || data.offer.sdp.length > 128_000) return;
      io.to(target.to).emit('webrtc_offer', { ...target, offer: { type: 'offer', sdp: data.offer.sdp } });
    });
    socket.on('webrtc_answer', (data: unknown) => {
      const target = signalTarget(socket, data);
      if (!target || !isRecord(data) || !isRecord(data.answer) || data.answer.type !== 'answer' || typeof data.answer.sdp !== 'string' || data.answer.sdp.length > 128_000) return;
      io.to(target.to).emit('webrtc_answer', { ...target, answer: { type: 'answer', sdp: data.answer.sdp } });
    });
    socket.on('webrtc_ice_candidate', (data: unknown) => {
      const target = signalTarget(socket, data);
      if (!target || !isRecord(data) || !isRecord(data.candidate)) return;
      const candidate = data.candidate;
      if (typeof candidate.candidate !== 'string' || candidate.candidate.length > 8192 ||
        (candidate.sdpMid != null && (typeof candidate.sdpMid !== 'string' || candidate.sdpMid.length > 256)) ||
        (candidate.sdpMLineIndex != null && (!Number.isInteger(candidate.sdpMLineIndex) || Number(candidate.sdpMLineIndex) < 0 || Number(candidate.sdpMLineIndex) > 64)) ||
        (candidate.usernameFragment != null && (typeof candidate.usernameFragment !== 'string' || candidate.usernameFragment.length > 256))) return;
      io.to(target.to).emit('webrtc_ice_candidate', { ...target, candidate: {
        candidate: candidate.candidate, sdpMid: candidate.sdpMid as string | null ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex as number | null ?? null,
        usernameFragment: candidate.usernameFragment as string | null ?? null,
      } });
    });
    socket.on('disconnecting', () => { leaveCall(socket, 'disconnected'); stopTyping(socket); });
    socket.on('disconnect', () => { if (socket.data.sala) presence(socket.data.sala); });
  });
  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (error instanceof multer.MulterError) { response.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'O arquivo deve ter no máximo 10 MB.' : 'Não foi possível processar o arquivo.' }); return; }
    next(error);
  });
  return { app, io, server };
}
