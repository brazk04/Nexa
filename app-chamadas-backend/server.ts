import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createPlatform } from './src/platform';

const prisma = new PrismaClient(process.env.DATABASE_URL
  ? { datasources: { db: { url: process.env.DATABASE_URL } } } : undefined);
const { server, io } = createPlatform(prisma);
const port = Number(process.env.PORT ?? 3333);
server.listen(port, () => console.log(`Coworking Platform em http://localhost:${port}`));
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  io.close(() => { void prisma.$disconnect().then(() => process.exit(0)); });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
