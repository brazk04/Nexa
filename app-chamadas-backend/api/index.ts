import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createPlatform } from '../src/platform';

const prisma = new PrismaClient(process.env.DATABASE_URL
  ? { datasources: { db: { url: process.env.DATABASE_URL } } } : undefined);

// Vercel's filesystem is temporary. Persistent avatars and attachments need an
// object-storage adapter before production; /tmp only prevents startup failure.
const { server } = createPlatform(prisma, {
  storageRoot: process.env.VERCEL ? '/tmp/nexa-storage' : undefined,
});

export default server;
