import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PrismaClient, User } from '@prisma/client';

export const SESSION_COOKIE = 'cw_session';
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export function opaqueToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function readCookie(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

export async function sessionUser(prisma: PrismaClient, cookieHeader: string | undefined) {
  const raw = readCookie(cookieHeader, SESSION_COOKIE);
  if (!raw) return null;
  const session = await prisma.session.findUnique({ where: { id: tokenHash(raw) }, include: { user: true } });
  if (!session || session.expiresAt <= new Date() || !session.user.emailVerifiedAt) {
    if (session) await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (Date.now() - session.lastSeenAt.getTime() > 5 * 60_000) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  return { sessionId: session.id, user: session.user };
}

export async function createSession(prisma: PrismaClient, user: User, response: Response, request?: Request) {
  const raw = opaqueToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await prisma.session.create({ data: {
    id: tokenHash(raw), userId: user.id, expiresAt,
    userAgent: request?.get('user-agent')?.slice(0, 500), ipAddress: request?.ip?.slice(0, 100),
  } });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  // The Vercel frontend and API are different sites in some mobile browsers.
  // Cross-site credentialed fetches require SameSite=None; Secure in production.
  const sameSite = secure && process.env.COOKIE_SAME_SITE?.toLowerCase() !== 'lax' ? 'None' : 'Lax';
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(raw)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}${secure}`);
}

export function clearSessionCookie(response: Response) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const sameSite = secure && process.env.COOKIE_SAME_SITE?.toLowerCase() !== 'lax' ? 'None' : 'Lax';
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0${secure}`);
}

export interface AuthenticatedRequest extends Request { auth?: { sessionId: string; user: User } }

export function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    email: user.email,
    birthDate: user.birthDate.toISOString().slice(0, 10),
    avatarUrl: user.avatarPath ? `/users/${user.id}/avatar?v=${user.updatedAt.getTime()}` : null,
    emailVerified: Boolean(user.emailVerifiedAt),
  };
}
