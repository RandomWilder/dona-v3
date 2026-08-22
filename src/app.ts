import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { httpStatus, KernelError, toErrorBody } from './kernel/errors.ts';

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
      const error = new KernelError('unavailable', 'database unreachable');
      reply.code(httpStatus(error.code));
      return { ok: false, version: deps.version, ...toErrorBody(error) };
    }
  });

  return app;
}
