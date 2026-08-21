// PostToolUse (Write|Edit): format the touched src file, then run its module's focused tests.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let file = '';
try {
  file = JSON.parse(raw)?.tool_input?.file_path ?? '';
} catch {
  process.exit(0);
}
if (!file || !file.includes('/src/') || !file.endsWith('.ts')) process.exit(0);

const run = (cmd) => {
  try {
    execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    return true;
  } catch (e) {
    console.error(String(e.stdout || '') + String(e.stderr || ''));
    return false;
  }
};

run(`npx --no-install biome check --write "${file}"`);

const m = file.match(/\/src\/([^/]+)\//);
const moduleDir = m ? `src/${m[1]}` : null;
if (moduleDir && existsSync(moduleDir)) {
  if (!run(`node --test ${moduleDir}`)) {
    console.error(`Focused tests failing in ${moduleDir} after this edit.`);
  }
}
process.exit(0);
