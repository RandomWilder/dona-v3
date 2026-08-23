import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { registerHtmlPage } from '../../kernel/ui/assets.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

// The tenant widget shell. `:link` is accepted and ignored: signed links, OTP
// step-up and sessions are week 4. The parameter is never echoed into the page,
// so an unverified route serves a static shell and discloses nothing.
export function registerChannelUi(app: FastifyInstance): void {
  registerHtmlPage(app, '/t/:link', path.join(here, 'index.html'));
}
