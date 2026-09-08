import 'dotenv/config';
import { createPlatform } from '../src/platform';
import { prisma } from '../src/db';
import { createRealtimeInfrastructure } from '../src/realtime';

// Avatars live in the database. Attachments use private Vercel Blob when its
// credentials are configured, with /tmp retained only as a local fallback.
const { server } = createPlatform(prisma, {
  storageRoot: process.env.VERCEL ? '/tmp/nexa-storage' : undefined,
  realtime: createRealtimeInfrastructure(),
});

export default server;
