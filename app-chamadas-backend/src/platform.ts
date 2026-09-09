import express from 'express';
import http from 'node:http';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import QRCode from 'qrcode';
import { del as deleteBlob, get as getBlob, put as putBlob } from '@vercel/blob';
import { Prisma } from '@prisma/client';
import type { PrismaClient, User, UserPreference } from '@prisma/client';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io';
import type { Ack, CallLeft, CallParticipant, ClientEvents, Message, RoomCall, ServerEvents } from '../shared/protocol';
import { clearSessionCookie, createSession, opaqueToken, publicUser, readCookie, SESSION_COOKIE, sessionUser, tokenHash } from './security';
import { createVerificationSender } from './email';
import type { VerificationSender } from './email';

import type { PresenceStatus } from '../shared/protocol';
import { MAX_UPLOAD_BYTES, uploadSizeError, validateUpload } from '../shared/uploads';

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
  typing?: boolean;
  call?: {
    id: string;
    roomId: string;
    startedAt: string;
    attemptId: string;
    microphone: boolean;
    camera: boolean;
    screen: boolean;
    handRaisedAt: string | null;
  };
}
type ClientSocket = Socket<ClientEvents, ServerEvents, Record<string, never>, SocketData>;
interface RealtimeInfrastructure {
  initialize: (io: Server) => Promise<void>;
  withLock: <T>(key: string, task: () => Promise<T>) => Promise<T>;
}
interface PlatformOptions { sendVerificationEmail?: VerificationSender; storageRoot?: string; realtime?: RealtimeInfrastructure; callRecoveryGraceMs?: number; verificationCooldownMs?: number }
const MAX_CALL_PARTICIPANTS = 15;
const VERIFY_DURATION_MS = 60 * 60 * 1000;
const VERIFICATION_COOLDOWN_MS = 60_000;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100;
const channelKey = (roomId: string) => `channel:${roomId}`;
const callKey = (roomId: string) => `call:${roomId}`;
const presenceKey = (roomId: string) => `presence:${roomId}`;
const userKey = (userId: string) => `user:${userId}`;
const normalize = (value: string) => value.normalize('NFC').toLocaleLowerCase('pt-BR');
const routeId = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const avatarUrl = (user: { id: string; avatarPath: string | null; updatedAt: Date }) => user.avatarPath ? `/users/${user.id}/avatar?v=${user.updatedAt.getTime()}` : null;
const inlineAvatar = (value: string | null) => Boolean(value?.startsWith('data:image/'));
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
  if (extension === '.mp4' && file.buffer.length >= 12 && file.buffer.toString('ascii', 4, 8) === 'ftyp') return { extension, mimeType: 'video/mp4' };
  if (extension === '.webm' && file.buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && file.buffer.subarray(0, 512).includes(Buffer.from('webm'))) return { extension, mimeType: 'video/webm' };
  if (image && ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return { extension: image, mimeType: image === '.jpg' ? 'image/jpeg' : `image/${image.slice(1)}` };
  if (extension === '.pdf' && file.buffer.toString('ascii', 0, 5) === '%PDF-') return { extension, mimeType: 'application/pdf' };
  if (['.zip', '.docx', '.xlsx', '.pptx'].includes(extension) && file.buffer[0] === 0x50 && file.buffer[1] === 0x4b) return { extension, mimeType: file.mimetype };
  if (['.doc', '.xls', '.ppt'].includes(extension) && file.buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return { extension, mimeType: file.mimetype };
  if (['.txt', '.csv'].includes(extension) && !file.buffer.includes(0)) return { extension, mimeType: extension === '.csv' ? 'text/csv' : 'text/plain' };
  return null;
}

export function createPlatform(prisma: PrismaClient, options: PlatformOptions = {}) {
  const app = express();
  const backgroundTasks = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>) => {
    backgroundTasks.add(task);
    void task.then(() => backgroundTasks.delete(task), () => backgroundTasks.delete(task));
    return task;
  };
  const whenIdle = async () => {
    while (backgroundTasks.size) await Promise.allSettled([...backgroundTasks]);
  };
  const localLockTails = new Map<string, Promise<void>>();
  const localLock = async <T>(key: string, task: () => Promise<T>) => {
    const previous = localLockTails.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>(resolveLock => { release = resolveLock; });
    const tail = previous.catch(() => undefined).then(() => current);
    localLockTails.set(key, tail);
    await previous.catch(() => undefined);
    try { return await task(); }
    finally { release(); if (localLockTails.get(key) === tail) localLockTails.delete(key); }
  };
  const withRealtimeLock = options.realtime?.withLock ?? localLock;
  const callRecoveryGraceMs = options.callRecoveryGraceMs ?? 30_000;
  const callTrace = (event: string, fields: Record<string, unknown>) => {
    if (process.env.NODE_ENV !== 'production') console.info(JSON.stringify({ scope: 'nexa-call', event, ...fields }));
  };
  const storageRoot = resolve(options.storageRoot || process.env.UPLOAD_DIR || join(process.cwd(), 'storage'));
  const avatarDirectory = join(storageRoot, 'avatars');
  const fileDirectory = join(storageRoot, 'files');
  mkdirSync(avatarDirectory, { recursive: true });
  mkdirSync(fileDirectory, { recursive: true });
  const blobStoreId = process.env.BLOB_STORE_ID
    || Object.entries(process.env).find(([name, value]) => Boolean(value) && /blob.*_STORE_ID$/iu.test(name))?.[1];
  const blobEnabled = Boolean(process.env.BLOB_READ_WRITE_TOKEN || (process.env.VERCEL_OIDC_TOKEN && blobStoreId));
  const blobAuth = blobStoreId ? { storeId: blobStoreId } : {};
  const isBlobReference = (value: string) => /^https:\/\/[^/]+\.blob\.vercel-storage\.com\//u.test(value);
  const storeAttachment = async (storedName: string, contents: Buffer, mimeType: string) => {
    if (!blobEnabled) {
      if (process.env.VERCEL) throw new Error('Blob não configurado para produção');
      await writeFile(join(fileDirectory, storedName), contents, { flag: 'wx' });
      return storedName;
    }
    const blob = await putBlob(`nexa/files/${storedName}`, contents, {
      ...blobAuth, access: 'private', addRandomSuffix: false, contentType: mimeType, cacheControlMaxAge: 60 * 60 * 24 * 30,
    });
    return blob.url;
  };
  const removeAttachment = async (storedName: string) => {
    if (isBlobReference(storedName)) await deleteBlob(storedName, blobAuth);
    else await unlink(join(fileDirectory, basename(storedName)));
  };
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  const attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 3, fieldSize: 16_384 },
    fileFilter: (request, file, done) => {
      (request as express.Request & { uploadFile?: { name: string; type: string } }).uploadFile = { name: file.originalname, type: file.mimetype };
      done(null, true);
    },
  });
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
  const verificationCooldownMs = options.verificationCooldownMs ?? VERIFICATION_COOLDOWN_MS;
  const recentVerification = (user: User, target: string, purpose: string) => prisma.emailVerificationToken.findFirst({ where: {
    userId: user.id,
    purpose,
    newEmailNormalized: purpose === 'email-change' ? normalize(target) : null,
    createdAt: { gte: new Date(Date.now() - verificationCooldownMs) },
  } });
  async function issueVerification(user: User, target = user.email, purpose = 'registration') {
    // This durable check is shared by all Vercel instances. The Redis/local
    // lock closes the small race between checking and creating the token.
    if (await recentVerification(user, target, purpose)) return true;
    try {
      return await withRealtimeLock(`verification:${user.id}`, async () => {
        if (await recentVerification(user, target, purpose)) return true;
        const token = opaqueToken();
        const hashedToken = tokenHash(token);
        await prisma.$transaction([
          prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } }),
          prisma.emailVerificationToken.create({ data: {
            tokenHash: hashedToken, userId: user.id, purpose,
            newEmail: purpose === 'email-change' ? target : null,
            newEmailNormalized: purpose === 'email-change' ? normalize(target) : null,
            expiresAt: new Date(Date.now() + VERIFY_DURATION_MS),
          } }),
        ]);
        try {
          const sent = await sendVerification({ email: target, username: user.username, token });
          if (!sent) await prisma.emailVerificationToken.deleteMany({ where: { tokenHash: hashedToken } });
          return sent;
        } catch (error) {
          await prisma.emailVerificationToken.deleteMany({ where: { tokenHash: hashedToken } }).catch(() => undefined);
          console.error('Falha ao enviar verificação de e-mail:', error instanceof Error ? error.message : 'erro desconhecido');
          return false;
        }
      });
    } catch (error) {
      // Another instance can still own the lock after persisting the token.
      if (await recentVerification(user, target, purpose)) return true;
      throw error;
    }
  }
  const requireAuth = async (request: express.Request, response: express.Response, next: express.NextFunction) => {
    try {
      const auth = await sessionUser(prisma, request.headers.cookie, request.headers.authorization);
      if (!auth) { response.status(401).json({ error: 'Sua sessão expirou. Entre novamente.' }); return; }
      (request as express.Request & { auth: typeof auth }).auth = auth;
      next();
    } catch { response.status(401).json({ error: 'Não foi possível validar sua sessão.' }); }
  };
  const getAuth = (request: express.Request) => (request as express.Request & { auth: NonNullable<Awaited<ReturnType<typeof sessionUser>>> }).auth;
  const memberFor = (request: express.Request, roomId: string) => prisma.roomMember.findUnique({ where: { userId_roomId: { userId: getAuth(request).user.id, roomId } } });
  const fallbackIceServers = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  let turnCache: { expiresAt: number; iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> } | null = null;

  app.get('/rtc/ice-servers', requireAuth, async (_request, response) => {
    const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
    const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
    if (!keyId || !apiToken) { response.json({ iceServers: fallbackIceServers }); return; }
    if (turnCache && turnCache.expiresAt > Date.now()) { response.json({ iceServers: turnCache.iceServers }); return; }
    try {
      const cloudflare = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86_400 }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!cloudflare.ok) throw new Error(`turn-${cloudflare.status}`);
      const payload = await cloudflare.json() as { iceServers?: Array<{ urls?: unknown; username?: unknown; credential?: unknown }> };
      const managed = payload.iceServers?.filter(server => (typeof server.urls === 'string' || (Array.isArray(server.urls) && server.urls.every(url => typeof url === 'string')))
        && (server.username === undefined || typeof server.username === 'string') && (server.credential === undefined || typeof server.credential === 'string'))
        .map(server => ({ urls: server.urls as string | string[], ...(typeof server.username === 'string' ? { username: server.username } : {}), ...(typeof server.credential === 'string' ? { credential: server.credential } : {}) })) ?? [];
      if (!managed.length) throw new Error('turn-empty');
      turnCache = { expiresAt: Date.now() + 12 * 60 * 60_000, iceServers: managed };
      response.json({ iceServers: managed });
    } catch (error) {
      console.error('Falha ao obter credenciais TURN:', error instanceof Error ? error.message : 'erro desconhecido');
      response.json({ iceServers: fallbackIceServers });
    }
  });

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
      const sessionToken = await createSession(prisma, user, response, request);
      response.json({ user: publicUser(user), sessionToken });
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
      const sessionToken = record.purpose !== 'email-change' ? await createSession(prisma, user, response, request) : undefined;
      response.json({ user: publicUser(user), ...(sessionToken ? { sessionToken } : {}) });
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
    const raw = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] || readCookie(request.headers.cookie, SESSION_COOKIE);
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
    const unreadWhere = { deletedAt: null, OR: memberships.map(member => ({ roomId: member.roomId, criadoEm: { gt: member.lastReadAt } })) };
    const [unread, mentions] = memberships.length ? await Promise.all([
      prisma.mensagem.groupBy({ by: ['roomId'], where: { ...unreadWhere, userId: { not: userId } }, _count: true }),
      prisma.mensagem.groupBy({ by: ['roomId'], where: { ...unreadWhere, mentions: { some: { userId } } }, _count: true }),
    ]) : [[], []];
    const unreadCounts = new Map(unread.map(item => [item.roomId, item._count]));
    const mentionCounts = new Map(mentions.map(item => [item.roomId, item._count]));
    const rooms = memberships.map(membership => formatRoom(membership.room, membership, {
      unreadCount: unreadCounts.get(membership.roomId) ?? 0, mentionCount: mentionCounts.get(membership.roomId) ?? 0,
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
    await Promise.all(ownedFiles.map(file => removeAttachment(file.storedName).catch(() => undefined)));
    if (user.avatarPath && !inlineAvatar(user.avatarPath)) await unlink(join(avatarDirectory, basename(user.avatarPath))).catch(() => undefined);
    clearSessionCookie(response); response.status(204).end();
  });

  app.post('/account/avatar', requireAuth, upload.single('avatar'), async (request, response) => {
    const file = request.file;
    const extension = file ? imageExtension(file.buffer) : null;
    if (!file || !extension || file.size > 2 * 1024 * 1024) { response.status(400).json({ error: 'Envie uma imagem PNG, JPEG, WebP ou GIF de até 2 MB.' }); return; }
    const mimeType = extension === '.jpg' ? 'image/jpeg' : `image/${extension.slice(1)}`;
    // Keep avatars in the database so Vercel's ephemeral filesystem cannot
    // make a profile image disappear after a new function instance starts.
    const storedName = `data:${mimeType};base64,${file.buffer.toString('base64')}`;
    const previous = getAuth(request).user.avatarPath;
    const user = await prisma.user.update({ where: { id: getAuth(request).user.id }, data: { avatarPath: storedName } });
    if (previous && !inlineAvatar(previous)) await unlink(join(avatarDirectory, basename(previous))).catch(() => undefined);
    response.json({ user: publicUser(user) });
  });
  app.delete('/account/avatar', requireAuth, async (request, response) => {
    const previous = getAuth(request).user.avatarPath;
    const user = await prisma.user.update({ where: { id: getAuth(request).user.id }, data: { avatarPath: null } });
    if (previous && !inlineAvatar(previous)) await unlink(join(avatarDirectory, basename(previous))).catch(() => undefined);
    response.json({ user: publicUser(user) });
  });
  app.get('/users/:id/avatar', requireAuth, async (request, response) => {
    const user = await prisma.user.findUnique({ where: { id: routeId(request.params.id) }, select: { avatarPath: true } });
    if (!user?.avatarPath) { response.status(404).end(); return; }
    try {
      if (inlineAvatar(user.avatarPath)) {
        const match = user.avatarPath.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i);
        if (!match) { response.status(404).end(); return; }
        response.type(match[1]!).setHeader('Cache-Control', 'private, max-age=86400, immutable').send(Buffer.from(match[2]!, 'base64')); return;
      }
      const file = join(avatarDirectory, basename(user.avatarPath));
      response.type(extname(file)).setHeader('Cache-Control', 'private, max-age=86400').send(await readFile(file));
    }
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
    connectionStateRecovery: { maxDisconnectionDuration: callRecoveryGraceMs, skipMiddlewares: false },
  });
  const realtimeReady = options.realtime?.initialize(io as Server) ?? Promise.resolve();
  const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const recoveryKey = (sala: string, callId: string, userId: string, attemptId: string) => `${sala}:${callId}:${userId}:${attemptId}`;
  server.once('close', () => { for (const timer of recoveryTimers.values()) clearTimeout(timer); recoveryTimers.clear(); });
  io.use(async (socket, next) => {
    try {
      await realtimeReady;
      const auth = await sessionUser(prisma, socket.handshake.headers.cookie, typeof socket.handshake.auth?.token === 'string' ? `Bearer ${socket.handshake.auth.token}` : undefined);
      if (!auth) { next(new Error('unauthorized')); return; }
      socket.data.userId = auth.user.id;
      socket.data.username = auth.user.username;
      socket.data.displayName = auth.user.displayName || auth.user.username;
      socket.data.avatarUrl = avatarUrl(auth.user);
      const preferences = await prisma.userPreference.findUnique({ where: { userId: auth.user.id }, select: { status: true } });
      socket.data.status = (preferences?.status ?? 'online') as PresenceStatus;
      socket.data.sessionId = auth.sessionId;
      socket.data.sessionCheckedAt = Date.now();
      // Keep a lightweight presence membership for every room the user can
      // access. This makes "Disponível" reflect an open Nexa session even
      // when the user has not selected that room yet.
      const memberships = await prisma.roomMember.findMany({ where: { userId: auth.user.id }, select: { roomId: true } });
      for (const membership of memberships) await socket.join(presenceKey(membership.roomId));
      next();
    } catch { next(new Error('Serviço de conexão temporariamente indisponível. Tentando reconectar…')); }
  });

  const participant = (client: { id: string; data: SocketData }): CallParticipant | null => client.data.call ? {
    socketId: client.id, userId: client.data.userId, username: client.data.username,
    displayName: client.data.displayName, avatarUrl: client.data.avatarUrl, status: client.data.status, inCall: true,
    microphone: client.data.call.microphone, camera: client.data.call.camera, screen: client.data.call.screen,
    attemptId: client.data.call.attemptId, handRaisedAt: client.data.call.handRaisedAt,
  } : null;
  async function snapshot(sala: string): Promise<RoomCall> {
    const clients = await io.in(callKey(sala)).fetchSockets();
    const active = clients.map(client => ({ client, participant: participant(client) }))
      .filter((entry): entry is { client: typeof clients[number]; participant: CallParticipant } => Boolean(entry.participant && entry.client.data.call?.roomId === sala));
    const first = active[0]?.client.data.call;
    const participants = active.filter(entry => entry.client.data.call?.id === first?.id).map(entry => entry.participant);
    const users = participants.length ? await prisma.user.findMany({
      where: { id: { in: [...new Set(participants.map(item => item.userId))] } },
      select: { id: true, username: true, displayName: true, avatarPath: true, updatedAt: true },
    }) : [];
    const currentUsers = new Map(users.map(user => [user.id, user]));
    return {
      sala, callId: first?.id ?? null, startedAt: first?.startedAt ?? null,
      participants: participants.map(item => {
        const user = currentUsers.get(item.userId);
        return user ? { ...item, username: user.username, displayName: user.displayName || user.username, avatarUrl: avatarUrl(user) } : item;
      }),
    };
  }
  async function presence(sala: string) {
    const clients = await io.in(presenceKey(sala)).fetchSockets();
    const unique = new Map<string, { userId: string; socketId: string; username: string; displayName: string; avatarUrl: string | null; status: PresenceStatus; inCall: boolean }>();
    for (const client of clients) {
      if (!client.data.userId) continue;
      const previous = unique.get(client.data.userId);
      const inCall = client.data.call?.roomId === sala;
      if (!previous || inCall) unique.set(client.data.userId, {
        userId: client.data.userId, socketId: client.id, username: client.data.username, displayName: client.data.displayName,
        avatarUrl: client.data.avatarUrl, status: client.data.status, inCall: inCall || previous?.inCall || false,
      });
    }
    const users = unique.size ? await prisma.user.findMany({
      where: { id: { in: [...unique.keys()] } },
      select: { id: true, username: true, displayName: true, avatarPath: true, updatedAt: true },
    }) : [];
    for (const user of users) {
      const current = unique.get(user.id); if (!current) continue;
      unique.set(user.id, { ...current, username: user.username, displayName: user.displayName || user.username, avatarUrl: avatarUrl(user) });
    }
    io.to(presenceKey(sala)).emit('usuarios_online', { sala, users: [...unique.values()] });
  }
  async function broadcastCall(sala: string) {
    io.to(channelKey(sala)).to(callKey(sala)).emit('chamada_atualizada', await snapshot(sala));
    await presence(sala);
  }
  async function broadcastTyping(sala: string) {
    const users = new Map<string, { userId: string; displayName: string }>();
    for (const client of await io.in(channelKey(sala)).fetchSockets()) {
      if (client.data.typing && client.data.userId && client.data.sala === sala) users.set(client.data.userId, { userId: client.data.userId, displayName: client.data.displayName });
    }
    io.to(channelKey(sala)).emit('usuarios_digitando', { sala, users: [...users.values()] });
  }
  function stopTyping(socket: ClientSocket, sala = socket.data.sala) {
    if (!sala || !socket.data.typing) return;
    socket.data.typing = false; void broadcastTyping(sala);
  }
  async function leaveCall(socket: ClientSocket, reason: CallLeft['reason']) {
    const call = socket.data.call;
    const sala = call?.roomId;
    const leaving = participant(socket);
    if (!sala || !call || !leaving) return;
    const key = recoveryKey(sala, call.id, leaving.userId, call.attemptId);
    const timer = recoveryTimers.get(key); if (timer) clearTimeout(timer); recoveryTimers.delete(key);
    callTrace('leave-confirmed', { socketId: socket.id, roomId: sala, callId: call.id, reason });
    socket.data.call = undefined;
    await socket.leave(callKey(sala));
    await prisma.callAttendance.updateMany({ where: { callId: call.id, userId: leaving.userId, leftAt: null }, data: { leftAt: new Date() } }).catch(() => undefined);
    socket.to(channelKey(sala)).to(callKey(sala)).emit('participante_saiu', {
      sala, callId: call.id, socketId: socket.id, username: leaving.displayName, reason,
    });
    await broadcastCall(sala);
    await withRealtimeLock(`call:${sala}`, async () => {
      const current = await snapshot(sala);
      if (current.callId !== call.id) {
        await prisma.callHistory.updateMany({ where: { id: call.id, endedAt: null }, data: { endedAt: new Date() } });
      }
    }).catch(() => undefined);
  }
  function scheduleDisconnectedCall(socket: ClientSocket, transportReason: string) {
    if (transportReason === 'server shutting down') return;
    const call = socket.data.call; const sala = call?.roomId; const leaving = participant(socket);
    if (!sala || !call || !leaving) return;
    const key = recoveryKey(sala, call.id, leaving.userId, call.attemptId);
    if (recoveryTimers.has(key)) return;
    callTrace('recovery-window-started', { socketId: socket.id, roomId: sala, callId: call.id, reason: transportReason, graceMs: callRecoveryGraceMs });
    socket.to(channelKey(sala)).to(callKey(sala)).emit('conexao_participante', {
      sala, callId: call.id, socketId: socket.id, userId: leaving.userId, username: leaving.displayName, status: 'reconnecting',
    });
    const timer = setTimeout(() => {
      recoveryTimers.delete(key);
      track(withRealtimeLock(`call:${sala}`, async () => {
        const clients = await io.in(callKey(sala)).fetchSockets();
        const restored = clients.some(client => client.data.userId === leaving.userId && client.data.call?.id === call.id && client.data.call.roomId === sala);
        if (restored) { callTrace('recovery-confirmed', { socketId: socket.id, roomId: sala, callId: call.id }); return; }
        const attendance = await prisma.callAttendance.findUnique({ where: { callId_userId: { callId: call.id, userId: leaving.userId } }, select: { leftAt: true } });
        if (attendance?.leftAt) { callTrace('recovery-cleanup-cancelled', { socketId: socket.id, roomId: sala, callId: call.id, reason: 'already-left' }); return; }
        callTrace('recovery-timeout', { socketId: socket.id, roomId: sala, callId: call.id, reason: transportReason });
        await prisma.callAttendance.updateMany({ where: { callId: call.id, userId: leaving.userId, leftAt: null }, data: { leftAt: new Date() } }).catch(() => undefined);
        io.to(channelKey(sala)).to(callKey(sala)).emit('participante_saiu', { sala, callId: call.id, socketId: socket.id, username: leaving.displayName, reason: 'timeout' });
        const current = await snapshot(sala);
        io.to(channelKey(sala)).to(callKey(sala)).emit('chamada_atualizada', current); await presence(sala);
        if (current.callId !== call.id) await prisma.callHistory.updateMany({ where: { id: call.id, endedAt: null }, data: { endedAt: new Date() } });
      }).catch(error => callTrace('recovery-timeout-error', { socketId: socket.id, roomId: sala, callId: call.id, error: error instanceof Error ? error.name : 'UnknownError' })));
    }, callRecoveryGraceMs);
    timer.unref?.(); recoveryTimers.set(key, timer);
  }
  function reject(socket: ClientSocket, ack: unknown, error: string, code?: string) {
    if (typeof ack === 'function') (ack as Ack)({ ok: false, error, code });
    else socket.emit('erro_operacao', error);
  }
  function signalTarget(socket: ClientSocket, data: unknown) {
    if (!isRecord(data) || !validId(data.to) || !validId(data.callId)) return null;
    const call = socket.data.call;
    if (!call || data.sala !== call.roomId || call.id !== data.callId || data.to === socket.id) return null;
    return { to: data.to, sala: call.roomId, callId: call.id, from: socket.id };
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

  async function removeClientFromRoom(socket: ClientSocket, roomId: string) {
    if (socket.data.call?.roomId === roomId) await leaveCall(socket, 'room-change');
    if (socket.data.sala === roomId) {
      stopTyping(socket, roomId);
      await socket.leave(channelKey(roomId));
      socket.data.sala = undefined; socket.data.joining = false; socket.data.revision += 1;
    }
    await socket.leave(presenceKey(roomId));
  }

  app.delete('/rooms/:id', requireAuth, async (request, response) => {
    const roomId = routeId(request.params.id);
    const userId = getAuth(request).user.id;
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      select: {
        createdById: true,
        members: { select: { userId: true } },
        messages: { select: { attachments: { select: { storedName: true } } } },
      },
    });
    if (!room || !room.members.some(member => member.userId === userId)) {
      response.status(403).json({ error: 'Você não tem acesso a esta sala.' }); return;
    }
    if (room.createdById === userId) {
      const connected = [...io.sockets.sockets.values()].filter(socket => socket.data.sala === roomId || socket.data.call?.roomId === roomId);
      await Promise.all(connected.map(socket => removeClientFromRoom(socket, roomId)));
      await Promise.all([...io.sockets.sockets.values()].filter(socket => room.members.some(member => member.userId === socket.data.userId)).map(socket => socket.leave(presenceKey(roomId))));
      await prisma.room.delete({ where: { id: roomId } });
      await Promise.all(room.messages.flatMap(message => message.attachments).map(file => removeAttachment(file.storedName).catch(() => undefined)));
      for (const member of room.members) io.to(userKey(member.userId)).emit('sala_removida', { roomId, reason: 'deleted' });
    } else {
      await prisma.roomMember.delete({ where: { userId_roomId: { userId, roomId } } });
      const connected = [...io.sockets.sockets.values()].filter(socket => socket.data.userId === userId && (socket.data.sala === roomId || socket.data.call?.roomId === roomId));
      await Promise.all(connected.map(socket => removeClientFromRoom(socket, roomId)));
      await Promise.all([...io.sockets.sockets.values()].filter(socket => socket.data.userId === userId).map(socket => socket.leave(presenceKey(roomId))));
      io.to(userKey(userId)).emit('sala_removida', { roomId, reason: 'left' });
      void presence(roomId);
    }
    response.status(204).end();
  });

  app.post('/rooms/:id/attachments', requireAuth, attachmentUpload.single('file'), async (request, response) => {
    const roomId = routeId(request.params.id);
    const member = await memberFor(request, roomId);
    const file = request.file;
    if (file) {
      const invalid = validateUpload({ name: file.originalname, type: file.mimetype, size: file.size });
      if (invalid) { response.status(file.size > MAX_UPLOAD_BYTES ? 413 : 400).json({ error: invalid }); return; }
    }
    const accepted = file ? safeAttachment(file) : null;
    const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
    const replyToId = Number.isInteger(Number(request.body?.replyToId)) && Number(request.body.replyToId) > 0 ? Number(request.body.replyToId) : null;
    if (!member) { response.status(403).json({ error: 'Você não tem acesso a esta sala.' }); return; }
    if (!file || !accepted) { response.status(400).json({ error: 'Conteúdo ou formato inválido. Use imagem, documento, MP4 ou WebM.' }); return; }
    if (text.length > 4000) { response.status(400).json({ error: 'A legenda deve ter até 4.000 caracteres.' }); return; }
    if (replyToId && !await prisma.mensagem.findFirst({ where: { id: replyToId, roomId } })) { response.status(400).json({ error: 'A mensagem respondida não existe nesta sala.' }); return; }
    const requestedName = `${randomUUID()}${accepted.extension}`;
    let storedName: string;
    try { storedName = await storeAttachment(requestedName, file.buffer, accepted.mimeType); }
    catch (error) {
      console.error('Falha no armazenamento do anexo:', error instanceof Error ? error.message : 'erro desconhecido');
      response.status(503).json({ error: 'O armazenamento de arquivos está indisponível. Tente novamente.' }); return;
    }
    try {
      const mentions = await mentionIds(roomId, text);
      const created = await prisma.mensagem.create({ data: {
        sala: roomId, roomId, userId: getAuth(request).user.id, autor: getAuth(request).user.username,
        texto: text, replyToId,
        mentions: mentions.length ? { create: mentions.map(userId => ({ userId })) } : undefined,
        attachments: { create: { name: safeName(file.originalname), mimeType: accepted.mimeType, size: file.size, storedName } },
      }, include: messageInclude });
      io.to(channelKey(roomId)).emit('nova_mensagem', formatMessage(created));
      response.status(201).json({ message: formatMessage(created, getAuth(request).user.id) });
      track(notifyMessage(created, getAuth(request).user.id).catch(() => undefined));
    } catch (error) {
      await removeAttachment(storedName).catch(() => undefined);
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
      response.type(attachment.mimeType);
      response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
      response.setHeader('Cache-Control', 'private, no-cache');
      if (isBlobReference(attachment.storedName)) {
        const result = await getBlob(attachment.storedName, { ...blobAuth, access: 'private', ifNoneMatch: request.get('if-none-match') });
        if (!result) { response.status(404).end(); return; }
        response.setHeader('ETag', result.blob.etag);
        if (result.statusCode === 304) { response.status(304).end(); return; }
        response.setHeader('Content-Length', String(result.blob.size ?? attachment.size));
        const stream = Readable.fromWeb(result.stream as never);
        stream.on('error', () => response.destroy());
        response.on('close', () => stream.destroy());
        stream.pipe(response);
      } else {
        const contents = await readFile(join(fileDirectory, basename(attachment.storedName)));
        response.setHeader('Content-Length', String(attachment.size));
        response.send(contents);
      }
    } catch (error) {
      const missing = (error as { code?: string }).code === 'ENOENT';
      response.status(missing ? 404 : 503).json({ error: missing ? 'Arquivo não encontrado. Solicite o reenvio.' : 'Não foi possível acessar o arquivo. Tente novamente.' });
    }
  });

  io.on('connection', socket => {
    if (socket.recovered && socket.data.call) {
      const { call } = socket.data; const sala = call.roomId;
      const key = recoveryKey(sala, call.id, socket.data.userId, call.attemptId);
      const timer = recoveryTimers.get(key); if (timer) clearTimeout(timer); recoveryTimers.delete(key);
      callTrace('socket-recovered', { socketId: socket.id, roomId: sala, callId: call.id });
      socket.to(channelKey(sala)).to(callKey(sala)).emit('conexao_participante', {
        sala, callId: call.id, socketId: socket.id, userId: socket.data.userId, username: socket.data.displayName, status: 'connected',
      });
      void broadcastCall(sala);
    }
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
      stopTyping(socket, previousRoom);
      if (previousRoom) await socket.leave(channelKey(previousRoom));
      socket.data.sala = sala;
      await socket.join(channelKey(sala));
      await socket.join(presenceKey(sala));
      if (previousRoom) void presence(previousRoom);
      void presence(sala);
      socket.emit('chamada_atualizada', await snapshot(sala));
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
        // The unique constraint handles retries atomically in the P2002 path.
        // New messages need no preliminary lookup by clientMessageId.
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
      await Promise.all(existing.attachments.map(file => removeAttachment(file.storedName).catch(() => undefined)));
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
      socket.data.typing = data.typing;
      void broadcastTyping(sala);
    });

    socket.on('entrar_chamada', async (data: unknown, ack) => {
      if (!isRecord(data) || !validId(data.sala) || !validId(data.attemptId)) {
        reject(socket, ack, 'Informe uma sala válida para entrar na chamada.'); return;
      }
      const sala = data.sala;
      const member = await prisma.roomMember.findUnique({ where: { userId_roomId: { userId: socket.data.userId, roomId: sala } } });
      if (!member) { reject(socket, ack, 'Você não tem acesso a esta sala.'); return; }
      try {
        const joined = await withRealtimeLock(`call-user:${socket.data.userId}`, () => withRealtimeLock(`call:${sala}`, async () => {
          const current = await snapshot(sala);
          const ownCall = socket.data.call;
          if (ownCall && ownCall.attemptId === data.attemptId && ownCall.roomId === sala) return { call: current, isNewCall: false };
          const connected = await io.fetchSockets();
          const existing = connected.find(client => client.id !== socket.id && client.data.userId === socket.data.userId && client.data.call);
          if (ownCall || existing?.data.call) throw new Error('already-in-other-call');
          if (current.participants.some(item => item.userId === socket.data.userId)) throw new Error('already-in-call');
          if (current.participants.length >= MAX_CALL_PARTICIPANTS) throw new Error('call-full');
          const isNewCall = !current.callId;
          const callId = current.callId ?? randomUUID();
          const startedAt = current.startedAt ?? new Date().toISOString();
          if (isNewCall) {
            await prisma.callHistory.updateMany({ where: { roomId: sala, endedAt: null }, data: { endedAt: new Date() } });
            await prisma.callHistory.create({ data: { id: callId, roomId: sala, startedAt: new Date(startedAt) } });
          }
          await prisma.callAttendance.upsert({
            where: { callId_userId: { callId, userId: socket.data.userId } },
            create: { callId, userId: socket.data.userId },
            update: { joinedAt: new Date(), leftAt: null },
          });
          await socket.join(callKey(sala));
          socket.data.call = {
            id: callId, roomId: sala, startedAt, attemptId: String(data.attemptId),
            microphone: false, camera: false, screen: false, handRaisedAt: null,
          };
          const recovery = recoveryKey(sala, callId, socket.data.userId, String(data.attemptId));
          const recoveryTimer = recoveryTimers.get(recovery);
          if (recoveryTimer) {
            clearTimeout(recoveryTimer); recoveryTimers.delete(recovery);
            socket.to(channelKey(sala)).to(callKey(sala)).emit('conexao_participante', {
              sala, callId, socketId: socket.id, userId: socket.data.userId, username: socket.data.displayName, status: 'connected',
            });
          }
          return { call: await snapshot(sala), isNewCall };
        }));
        if (typeof ack === 'function') ack({ ok: true, data: joined.call });
        void broadcastCall(sala);
        if (joined.isNewCall) void notifyCall(sala, joined.call.callId!, socket.data.userId, socket.data.displayName);
      } catch (error) {
        if (error instanceof Error && error.message === 'already-in-call') { reject(socket, ack, 'Você já está nesta chamada.'); return; }
        if (error instanceof Error && error.message === 'already-in-other-call') { reject(socket, ack, 'Você já está em uma chamada em outra sala. Saia da chamada atual antes de entrar em outra.', 'ALREADY_IN_CALL'); return; }
        if (error instanceof Error && error.message === 'call-full') { reject(socket, ack, 'A chamada atingiu o limite de 15 participantes.', 'CALL_FULL'); return; }
        reject(socket, ack, 'Não foi possível registrar a chamada. Tente novamente.');
      }
    });
    socket.on('sair_chamada', (data: unknown) => {
      const call = socket.data.call;
      if (!isRecord(data) || !call || data.sala !== call.roomId) return;
      if (call && call.attemptId === data.attemptId) {
        callTrace('manual-leave-received', { socketId: socket.id, roomId: call.roomId, callId: call.id });
        void leaveCall(socket, 'manual');
      }
    });
    socket.on('sincronizar_chamada', async (data: unknown, ack) => {
      const call = socket.data.call;
      if (!isRecord(data) || !call || data.sala !== call.roomId || data.attemptId !== call.attemptId) { reject(socket, ack, 'Não foi possível sincronizar esta chamada.'); return; }
      const sala = call.roomId;
      callTrace('snapshot-requested', { socketId: socket.id, roomId: sala, callId: call.id });
      if (typeof ack === 'function') ack({ ok: true, data: await snapshot(sala) });
    });
    socket.on('atualizar_midia', (data: unknown) => {
      const call = socket.data.call;
      if (!isRecord(data) || !call || data.sala !== call.roomId || typeof data.microphone !== 'boolean' || typeof data.camera !== 'boolean' || typeof data.screen !== 'boolean' || call.attemptId !== data.attemptId) return;
      Object.assign(call, { microphone: data.microphone, camera: data.camera, screen: data.screen });
      void broadcastCall(call.roomId);
    });
    socket.on('atualizar_mao', (data: unknown) => {
      const call = socket.data.call;
      if (!isRecord(data) || !call || data.sala !== call.roomId || typeof data.raised !== 'boolean' || call.attemptId !== data.attemptId) return;
      call.handRaisedAt = data.raised ? new Date().toISOString() : null;
      void broadcastCall(call.roomId);
    });
    socket.on('enviar_reacao', (data: unknown) => {
      const allowed = new Set(['👍', '👏', '❤️', '😂', '🎉', '🤔']);
      const call = socket.data.call;
      if (!isRecord(data) || !call || data.sala !== call.roomId || typeof data.emoji !== 'string' || !allowed.has(data.emoji) || call.attemptId !== data.attemptId) return;
      io.to(callKey(call.roomId)).emit('reacao_chamada', {
        id: randomUUID(), sala: call.roomId, callId: call.id, userId: socket.data.userId,
        username: socket.data.username, displayName: socket.data.displayName, emoji: data.emoji, createdAt: new Date().toISOString(),
      });
    });
    socket.on('atualizar_status', async data => {
      if (!isRecord(data) || !['online', 'busy', 'dnd', 'away'].includes(String(data.status))) return;
      socket.data.status = data.status as PresenceStatus;
      await prisma.userPreference.upsert({ where: { userId: socket.data.userId }, create: { userId: socket.data.userId, status: socket.data.status }, update: { status: socket.data.status } });
      for (const client of io.sockets.sockets.values()) if (client.data.userId === socket.data.userId) client.data.status = socket.data.status;
      for (const room of socket.rooms) if (room.startsWith('presence:')) void presence(room.slice('presence:'.length));
    });
    socket.on('atualizar_perfil', async () => {
      const user = await prisma.user.findUnique({ where: { id: socket.data.userId } });
      if (!user) return;
      const displayName = user.displayName || user.username; const picture = avatarUrl(user);
      for (const client of io.sockets.sockets.values()) {
        if (client.data.userId !== user.id) continue;
        client.data.displayName = displayName; client.data.avatarUrl = picture;
      }
      const memberships = await prisma.roomMember.findMany({ where: { userId: user.id }, select: { roomId: true } });
      for (const membership of memberships) void broadcastCall(membership.roomId);
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
    socket.on('disconnecting', reason => { scheduleDisconnectedCall(socket, reason); stopTyping(socket); });
    socket.on('disconnecting', () => {
      const affectedPresence = [...socket.rooms].filter(room => room.startsWith('presence:')).map(room => room.slice('presence:'.length));
      setTimeout(() => { for (const roomId of affectedPresence) void presence(roomId); }, 0);
    });
  });
  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    const file = (_request as express.Request & { uploadFile?: { name: string; type: string } }).uploadFile;
    if (file && error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') { response.status(413).json({ error: uploadSizeError(file) }); return; }
    if (error instanceof multer.MulterError) { response.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'O arquivo deve ter no máximo 10 MB.' : 'Não foi possível processar o arquivo.' }); return; }
    next(error);
  });
  return { app, io, server, whenIdle };
}
