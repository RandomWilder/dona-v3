import { readFileSync } from 'node:fs';
import { startServer } from './boot.ts';

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

// Local only — the container reads its configuration from the environment.
loadEnvFile('.env');
loadEnvFile('.env.example');

const started = await startServer({
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
});
// Includes whether an operator was seeded — otherwise a developer cannot tell
// a working local login from a missing one until the form refuses them.
console.log(started);
console.log(
  `dona-v3: http://127.0.0.1:${Number(process.env.PORT ?? 3000)}/health`,
);
