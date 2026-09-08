import 'dotenv/config';
import { createPlatform } from './src/platform';
import { prisma } from './src/db';
import { createRealtimeInfrastructure } from './src/realtime';

const { server, io, whenIdle } = createPlatform(prisma, { realtime: createRealtimeInfrastructure() });
const port = Number(process.env.PORT ?? 3333);
server.listen(port, () => console.log(`Coworking Platform em http://localhost:${port}`));
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  io.close(() => { void whenIdle().then(() => prisma.$disconnect()).then(() => process.exit(0)); });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
