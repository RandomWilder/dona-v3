import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { createAuditLog } from '../../kernel/audit.ts';
import { type Clock, systemClock } from '../../kernel/clock.ts';
import { KernelError } from '../../kernel/errors.ts';
import { createStaffAuth, type Session } from '../internal/auth.ts';
import {
  clearSessionCookie,
  isHttps,
  readSessionToken,
  sessionCookie,
} from '../internal/cookies.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface StaffDeps {
  pool: Pool;
  clock?: Clock;
}

interface Credentials {
  email: string;
  password: string;
}

// Two variants of one file, computed once. The failed-login page is the same
// HTML with the error paragraph revealed — no templating, and nothing from the
// request is ever interpolated into the page.
function loginPages(): { clean: string; withError: string } {
  const clean = readFileSync(path.join(here, 'login.html'), 'utf8');
  const withError = clean.replace(
    ' id="login-error" hidden>',
    ' id="login-error">',
  );
  if (withError === clean) {
    throw new Error('login.html no longer has the hidden error paragraph');
  }
  return { clean, withError };
}

// Authenticated screens must not sit in a cache — including the back-forward
// cache, which is why this is no-store rather than no-cache.
function html(reply: FastifyReply, body: string): string {
  reply
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff');
  return body;
}

function credentials(body: unknown): Credentials | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== 'string' || typeof password !== 'string') {
    return null;
  }
  return { email, password };
}

export function registerStaffUi(app: FastifyInstance, deps: StaffDeps): void {
  const clock = deps.clock ?? systemClock;
  const auth = createStaffAuth(deps.pool, { clock });
  const audit = createAuditLog(deps.pool, clock);
  const shell = readFileSync(path.join(here, 'index.html'), 'utf8');
  const login = loginPages();

  async function currentSession(
    request: FastifyRequest,
  ): Promise<Session | null> {
    const token = readSessionToken(request.headers.cookie);
    return token === null ? null : auth.readSession(token);
  }

  app.get('/admin', async (request, reply) => {
    if (!(await currentSession(request))) {
      return reply.redirect('/admin/login', 302);
    }
    return html(reply, shell);
  });

  app.get('/admin/login', async (request, reply) => {
    if (await currentSession(request)) {
      return reply.redirect('/admin', 302);
    }
    const failed = (request.query as Record<string, unknown>)?.error === '1';
    return html(reply, failed ? login.withError : login.clean);
  });

  app.post('/admin/login', async (request, reply) => {
    const submitted = credentials(request.body);
    // Every failure below leaves by this same door: no field-level hints, no
    // distinction between an unknown address and a wrong password.
    const fail = () => reply.redirect('/admin/login?error=1', 302);
    if (!submitted) {
      return fail();
    }
    try {
      const session = await auth.login(submitted.email, submitted.password);
      await audit.write(
        {
          actorKind: 'staff',
          actorId: session.operator.id,
          actorRole: session.operator.role,
          action: 'staff.login',
          subjectId: session.operator.id,
          // The password is never an input to anything that is recorded.
          inputs: { email: session.operator.email },
        },
        { outcome: 'ok' },
      );
      reply.header(
        'set-cookie',
        sessionCookie(
          session.token,
          session.expiresAt,
          clock.now(),
          isHttps(request),
        ),
      );
      return reply.redirect('/admin', 302);
    } catch (error) {
      const code = error instanceof KernelError ? error.code : 'unavailable';
      await audit.write(
        {
          actorKind: 'staff',
          action: 'staff.login',
          inputs: { email: String(submitted.email).slice(0, 320) },
        },
        { outcome: 'error', code },
      );
      return fail();
    }
  });

  app.post('/admin/logout', async (request, reply) => {
    const token = readSessionToken(request.headers.cookie);
    if (token !== null) {
      const session = await auth.readSession(token);
      await auth.logout(token);
      if (session) {
        await audit.write(
          {
            actorKind: 'staff',
            actorId: session.operator.id,
            actorRole: session.operator.role,
            action: 'staff.logout',
            subjectId: session.operator.id,
            inputs: { email: session.operator.email },
          },
          { outcome: 'ok' },
        );
      }
    }
    reply.header('set-cookie', clearSessionCookie(isHttps(request)));
    return reply.redirect('/admin/login', 302);
  });
}
