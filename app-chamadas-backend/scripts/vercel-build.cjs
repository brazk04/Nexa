const { spawnSync } = require('node:child_process');

// Set PUSH_DB_ON_BUILD=1 only for the first production deployment of a fresh
// database. Normal builds only regenerate Prisma Client.
const schemaCommand = process.env.PUSH_DB_ON_BUILD === '1' ? 'push' : 'generate';
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const schema = spawnSync(process.execPath, ['scripts/postgres-schema.cjs', schemaCommand], {
  stdio: 'inherit',
  env: process.env,
});
if (schema.status !== 0) process.exit(schema.status ?? 1);

const build = spawnSync(npmCommand, ['run', 'build'], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});
process.exit(build.status ?? 1);
