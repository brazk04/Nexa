const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const command = process.argv[2] || 'generate';
if (!['generate', 'push', 'indexes'].includes(command)) {
  console.error('Uso: node scripts/postgres-schema.cjs <generate|push|indexes>');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL precisa estar configurada para usar o schema PostgreSQL.');
  process.exit(1);
}

const sourcePath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
// Keep the temporary schema inside the package so Prisma resolves the local
// package.json and installed CLI instead of trying an auto-install at C:\.
const temporaryPath = path.join(__dirname, '..', 'prisma', `.schema.postgres.${process.pid}.tmp.prisma`);
const source = fs.readFileSync(sourcePath, 'utf8');
const postgresSchema = source
  .replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"')
  .replace(/url\s*=\s*"file:\.\/dev\.db"/, 'url = env("DATABASE_URL")\n  directUrl = env("DIRECT_URL")');
fs.writeFileSync(temporaryPath, postgresSchema, 'utf8');

const directUrl = process.env.DIRECT_URL
  || process.env.NEONBACKEND_DATABASE_URL_UNPOOLED
  || process.env.NEONBACKEND_POSTGRES_URL_NON_POOLING
  || process.env.POSTGRES_URL_NON_POOLING
  || process.env.DATABASE_URL;

const npmCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const schemaArgument = process.platform === 'win32' ? `"${temporaryPath}"` : temporaryPath;
const indexesPath = path.join(__dirname, '..', 'prisma', 'migrations', '20260907200000_performance_indexes', 'migration.sql');
const indexesArgument = process.platform === 'win32' ? `"${indexesPath}"` : indexesPath;
const args = command === 'push'
  ? ['prisma', 'db', 'push', '--schema', schemaArgument, '--accept-data-loss']
  : command === 'indexes'
    ? ['prisma', 'db', 'execute', '--file', indexesArgument, '--schema', schemaArgument]
    : ['prisma', 'generate', '--schema', schemaArgument];
const result = spawnSync(npmCommand, args, {
  stdio: 'inherit',
  env: { ...process.env, DIRECT_URL: directUrl },
  // Windows exposes npx as a .cmd shim rather than a native executable.
  shell: process.platform === 'win32',
});
if (result.error) {
  console.error(`Falha ao executar Prisma: ${result.error.message}`);
}
try { fs.unlinkSync(temporaryPath); } catch { /* Temporary file cleanup is best effort. */ }
process.exit(result.status ?? 1);
