import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { httpStatus, KernelError, toErrorBody } from '../errors.ts';

const uiRoot = path.dirname(fileURLToPath(import.meta.url));

// An allowlist, not a directory listing: the `:file` parameter is only ever
// compared against these names, so no request-derived string is joined onto a
// filesystem path.
const fontFiles = [
  'heebo-hebrew.woff2',
  'heebo-latin.woff2',
  'ibm-plex-mono-latin-400.woff2',
  'ibm-plex-mono-latin-500.woff2',
] as const;

// The image is immutable, so every asset is read once at registration rather
// than on each request.
export function registerUiAssets(app: FastifyInstance): void {
  const tokens = readFileSync(path.join(uiRoot, 'tokens.css'));
  const fonts = new Map<string, Buffer>(
    fontFiles.map((name) => [
      name,
      readFileSync(path.join(uiRoot, 'fonts', name)),
    ]),
  );

  app.get('/ui/tokens.css', async (_request, reply) => {
    reply
      .header('content-type', 'text/css; charset=utf-8')
      .header('cache-control', 'no-cache')
      .header('x-content-type-options', 'nosniff');
    return tokens;
  });

  app.get('/ui/fonts/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    const body = fonts.get(file);
    if (!body) {
      const error = new KernelError('not_found', 'asset not found');
      reply.code(httpStatus(error.code));
      return toErrorBody(error);
    }
    reply
      .header('content-type', 'font/woff2')
      // Names are stable and the bytes behind them never change.
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff');
    return body;
  });
}

// Screens are self-contained HTML files (SPEC.md rule 6). `no-cache` until
// assets are content-hashed, so a deploy cannot leave stale markup against a
// fresh stylesheet.
export function registerHtmlPage(
  app: FastifyInstance,
  url: string,
  file: string,
): void {
  const html = readFileSync(file, 'utf8');
  app.get(url, async (_request, reply) => {
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-cache')
      .header('x-content-type-options', 'nosniff');
    return html;
  });
}
