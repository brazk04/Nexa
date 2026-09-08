import { PrismaClient } from '@prisma/client';

type PrismaGlobal = typeof globalThis & { __nexaPrisma?: PrismaClient };

const prismaGlobal = globalThis as PrismaGlobal;

export const prisma = prismaGlobal.__nexaPrisma ?? new PrismaClient(process.env.DATABASE_URL
  ? { datasources: { db: { url: process.env.DATABASE_URL } } }
  : undefined);

// Vercel reuses warm processes. Keeping the client in global scope lets Prisma
// reuse its pool instead of opening another pool for every module reload.
prismaGlobal.__nexaPrisma = prisma;
