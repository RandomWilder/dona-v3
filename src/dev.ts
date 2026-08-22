import { readFileSync } from 'node:fs';
import { buildApp } from './app.ts';
import { createPool } from './kernel/db.ts';
import { migrate } from './kernel/migrate.ts';

function loadEnvFile(path: string): void {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const cut = line.indexOf('=');
    if (cut <= 0) {
      continue;
    }
    const name = line.slice(0, cut).trim();
    const value = line.slice(cut + 1).trim();
    if (process.env[name] === undefined) {
      process.env[name] = value;
    }
  }
}

loadEnvFile('.env');
loadEnvFile('.env.example');

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as {
  version: string;
};
const port = Number(process.env.PORT ?? 3000);

const pool = createPool();
// First `docker compose up` needs a few seconds before Postgres accepts connections.
const deadline = Date.now() + 30_000;
for (;;) {
  try {
    await pool.query('SELECT 1');
    break;
  } catch (error) {
    if (Date.now() >= deadline) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
await migrate(pool);

const app = buildApp({ pool, version });
await app.listen({ port, host: '127.0.0.1' });
console.log(`dona-v3 ${version}: http://127.0.0.1:${port}/health`);
