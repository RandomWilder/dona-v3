import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { registerChannelUi } from './channel/contract.ts';
import type { Clock } from './kernel/clock.ts';
import type { Embedder } from './kernel/embeddings.ts';
import { httpStatus, KernelError, toErrorBody } from './kernel/errors.ts';
import type { Extractor } from './kernel/extraction.ts';
import type { ObjectStore } from './kernel/objects.ts';
import { registerUiAssets } from './kernel/ui/assets.ts';
import { registerStaffUi } from './staff/contract.ts';

export interface AppDeps {
  pool: Pool;
  version: string;
  clock?: Clock;
  // Where lease documents live. Wired at boot; absent in tests that never touch
  // one, where occupancy falls back to a store that throws rather than forgets.
  store?: ObjectStore;
  // Same shape: absent, occupancy falls back to an embedder that refuses rather
  // than one that returns zeros.
  embedder?: Embedder;
  // And again: absent, occupancy falls back to an extractor that refuses rather
  // than one that reads a lease into no fields at all.
  extractor?: Extractor;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // The login form posts as a browser form. Fastify parses JSON out of the box
  // and nothing else; this is the whole of what @fastify/formbody would have
  // added, so it is not worth a runtime dependency.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  app.get('/health', async (_request, reply) => {
    try {
      await deps.pool.query('SELECT 1');
      return { ok: true, version: deps.version, db: 'up' };
    } catch {
      const error = new KernelError('unavailable', 'database unreachable');
      reply.code(httpStatus(error.code));
      return { ok: false, version: deps.version, ...toErrorBody(error) };
    }
  });

  // Until this slice the only route was /health, so Fastify's own 404 and 500
  // bodies never showed. They do now — and they carry the requested path and
  // raw error text. SPEC.md: one error shape, and never leak internals.
  app.setNotFoundHandler(async (_request, reply) => {
    const error = new KernelError('not_found', 'route not found');
    reply.code(httpStatus(error.code));
    return toErrorBody(error);
  });

  app.setErrorHandler(async (caught, _request, reply) => {
    const body = toErrorBody(caught);
    reply.code(httpStatus(body.code));
    return body;
  });

  // Presentation: the shared token layer, then one shell per module edge.
  // Modules are reached through their contract, never through their internals.
  registerUiAssets(app);
  registerStaffUi(app, {
    pool: deps.pool,
    clock: deps.clock,
    store: deps.store,
    embedder: deps.embedder,
    extractor: deps.extractor,
  });
  registerChannelUi(app);

  // The bare URL is what someone types on a phone; send it where the system
  // actually starts rather than at a 404.
  app.get('/', async (_request, reply) => reply.redirect('/admin', 302));

  return app;
}
