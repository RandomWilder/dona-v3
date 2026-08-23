import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { registerHtmlPage } from '../../kernel/ui/assets.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

// The ops shell. No session in front of it yet — slice 5.2 adds one before any
// real content lands behind it.
export function registerStaffUi(app: FastifyInstance): void {
  registerHtmlPage(app, '/admin', path.join(here, 'index.html'));
}
