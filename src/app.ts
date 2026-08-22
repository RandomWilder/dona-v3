import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

export interface AppDeps {
  pool: Pool;
  version: string;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async (_request, reply) => {
    try {
      await deps.pool.query('SELECT 1');
      return { ok: true, version: deps.version, db: 'up' };
    } catch {
      reply.code(503);
      return {
        ok: false,
        version: deps.version,
        code: 'unavailable',
        message: 'database unreachable',
      };
    }
  });

  return app;
}
