import { randomUUID } from 'node:crypto';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import { createClient } from 'redis';
import type { Server } from 'socket.io';

type RedisClient = ReturnType<typeof createClient>;
type RealtimeGlobal = typeof globalThis & {
  __nexaRedis?: RedisClient;
  __nexaRedisReady?: Promise<void>;
};

export interface RealtimeInfrastructure {
  initialize: (io: Server) => Promise<void>;
  withLock: <T>(key: string, task: () => Promise<T>) => Promise<T>;
}

// Marketplace integrations may namespace their variables with the integration
// name (for example, `UptashRedisNexa_REDIS_URL`). Prefer the conventional
// names, but accept those generated aliases without copying the secret.
const redisUrl = process.env.REDIS_URL
  || process.env.KV_URL
  || Object.entries(process.env).find(([name, value]) => Boolean(value) && /(?:^|_)REDIS_URL$/u.test(name))?.[1]
  || Object.entries(process.env).find(([name, value]) => Boolean(value) && /(?:^|_)KV_URL$/u.test(name))?.[1];

export function createRealtimeInfrastructure(): RealtimeInfrastructure | undefined {
  if (!redisUrl) return undefined;

  const shared = globalThis as RealtimeGlobal;
  if (!shared.__nexaRedis) {
    shared.__nexaRedis = createClient({ url: redisUrl });
    shared.__nexaRedis.on('error', error => console.error('Redis realtime indisponivel:', error instanceof Error ? error.message : 'erro desconhecido'));
  }
  const client = shared.__nexaRedis;
  shared.__nexaRedisReady ??= client.connect().then(() => undefined);
  const ready = shared.__nexaRedisReady;

  return {
    initialize: async io => {
      await ready;
      io.adapter(createAdapter(client, {
        streamName: 'nexa:socket-events',
        sessionKeyPrefix: 'nexa:socket-session:',
        maxLen: 10_000,
        onlyPlaintext: true,
      }));
    },
    withLock: async <T>(key: string, task: () => Promise<T>) => {
      await ready;
      const lockKey = `nexa:lock:${key}`;
      const token = randomUUID();
      const deadline = Date.now() + 5_000;
      let acquired = false;
      while (!acquired && Date.now() < deadline) {
        acquired = (await client.set(lockKey, token, { NX: true, PX: 10_000 })) === 'OK';
        if (!acquired) await new Promise(resolve => setTimeout(resolve, 40 + Math.floor(Math.random() * 60)));
      }
      if (!acquired) throw new Error('realtime-lock-timeout');
      try { return await task(); }
      finally {
        await client.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", {
          keys: [lockKey], arguments: [token],
        }).catch(() => undefined);
      }
    },
  };
}
