import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createPlatform } from '../src/platform';

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'coworking-browser-'));
  const database = join(directory, 'test.db');
  await copyFile(resolve(__dirname, '../prisma/dev.db'), database);
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${database.replaceAll('\\', '/')}` } } });
  await prisma.emailVerificationToken.deleteMany(); await prisma.session.deleteMany();
  await prisma.mensagem.deleteMany({ where: { roomId: { not: null } } }); await prisma.roomMember.deleteMany(); await prisma.room.deleteMany(); await prisma.user.deleteMany();
  const tokens = new Map<string, string>();
  const { server, io, app, whenIdle } = createPlatform(prisma, { storageRoot: join(directory, 'storage'), sendVerificationEmail: async message => {
    tokens.set(message.username, message.token); return true;
  } });
  app.get('/__test/verification/:username', (request, response) => {
    const token = tokens.get(request.params.username);
    if (!token) { response.status(404).json({ error: 'not-found' }); return; }
    response.json({ token });
  });
  app.post('/__test/disconnect/:username', (request, response) => {
    for (const socket of io.sockets.sockets.values()) if (socket.data.username === request.params.username) socket.conn.close();
    response.status(204).end();
  });
  app.post('/__test/disconnect-call', (request, response) => {
    const usernames = Array.isArray(request.body?.usernames) ? new Set(request.body.usernames.filter((value: unknown): value is string => typeof value === 'string')) : new Set<string>();
    const targets = [...io.sockets.sockets.values()].filter(socket => usernames.has(socket.data.username));
    targets.forEach(socket => socket.conn.close());
    response.json({ disconnected: targets.length });
  });
  server.listen(3355, '127.0.0.1', () => console.log('Isolated browser test server: 3355'));
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    const fallback = setTimeout(() => process.exit(0), 2_000);
    io.disconnectSockets(true);
    io.close();
    server.closeAllConnections();
    server.close();
    void whenIdle().then(() => prisma.$disconnect()).then(() => rm(directory, { recursive: true, force: true })).finally(() => {
      clearTimeout(fallback); process.exit(0);
    });
  };
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
void main();
