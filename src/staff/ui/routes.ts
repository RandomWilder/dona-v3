import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { createIdentity } from '../../identity/contract.ts';
import { createAuditLog } from '../../kernel/audit.ts';
import { type Clock, systemClock } from '../../kernel/clock.ts';
import { KernelError } from '../../kernel/errors.ts';
import type { Html } from '../../kernel/ui/html.ts';
import { createOccupancy } from '../../occupancy/contract.ts';
import { createPortfolio } from '../../portfolio/contract.ts';
import { createStaffAuth, type Session } from '../internal/auth.ts';
import { createStaffCommands } from '../internal/commands.ts';
import {
  clearSessionCookie,
  isHttps,
  readSessionToken,
  sessionCookie,
} from '../internal/cookies.ts';
import { createStaffQueries } from '../internal/queries.ts';
import {
  buildingPage,
  buildingsPage,
  emptyPage,
  type PageContext,
  peoplePage,
  personPage,
  unitPage,
} from './views.ts';

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

// The shell, with the current destination marked and the page dropped into it.
// The two substitutions are the pattern `loginPages` above already uses, and
// each throws at registration if its marker has gone — a page that silently
// rendered without its nav would be a worse failure than a boot error.
function shellPages(): (dest: string, body: Html) => string {
  const shell = readFileSync(path.join(here, 'index.html'), 'utf8');
  if (!shell.includes('<!--main-->')) {
    throw new Error('index.html no longer has the <!--main--> marker');
  }
  return (dest, body) => {
    const marker = `data-dest="${dest}"`;
    if (!shell.includes(marker)) {
      throw new Error(`index.html has no nav item for ${dest}`);
    }
    return shell
      .replace(marker, `${marker} aria-current="page"`)
      .replace('<!--main-->', body.value);
  };
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

// A browser form posts strings and only strings. The modules do the real
// validation at their own edge (`requireText`, `validId`); this just refuses to
// hand them something that is not a string at all.
function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// An untouched optional box posts an empty string, which means "no floor" and
// not floor zero. Anything else is passed through as a number for portfolio's
// `optionalFloor` to accept or reject — parsing it here would be a second,
// weaker copy of that rule.
function floorOf(value: unknown): number | undefined {
  const text = asString(value);
  if (text.length === 0) {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
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
  const render = shellPages();
  const login = loginPages();

  // The three domain modules, reached through their contracts and handed to the
  // guarded surface — never called from a route directly, which is what keeps
  // the permission check on one path (SPEC-staff.md).
  const identity = createIdentity({ pool: deps.pool, clock });
  const portfolio = createPortfolio({ pool: deps.pool, clock });
  const occupancy = createOccupancy({
    pool: deps.pool,
    clock,
    identity,
    portfolio,
  });
  const guarded = { identity, portfolio, occupancy, pool: deps.pool, clock };
  const commands = createStaffCommands(guarded);
  const queries = createStaffQueries(guarded);

  async function currentSession(
    request: FastifyRequest,
  ): Promise<Session | null> {
    const token = readSessionToken(request.headers.cookie);
    return token === null ? null : auth.readSession(token);
  }

  // Every admin page below is behind this. A route that forgets to call it
  // serves nothing, because it has no session to render a page from.
  function page(
    dest: string,
    build: (
      session: Session,
      context: PageContext,
      request: FastifyRequest,
    ) => Promise<Html>,
  ) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const session = await currentSession(request);
      if (!session) {
        return reply.redirect('/admin/login', 302);
      }
      const context: PageContext = {
        role: session.operator.role,
        error: errorText(request),
      };
      return html(reply, render(dest, await build(session, context, request)));
    };
  }

  // Route parameters and query values are strings or they are nothing. The
  // modules validate them properly (`validId` at every edge); this only gets
  // them out of Fastify's `unknown` without a cast at each call site.
  function param(request: FastifyRequest, name: string): string {
    const value = (request.params as Record<string, unknown>)?.[name];
    return typeof value === 'string' ? value : '';
  }

  function queryText(request: FastifyRequest, name: string): string | null {
    const value = (request.query as Record<string, unknown>)?.[name];
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : null;
  }

  // A refused or invalid command comes back as a code in the query string, and
  // the page turns it into one Hebrew sentence. Never the raw error text: the
  // message may carry a field name or a database detail, and SPEC.md's rule is
  // one error shape that never leaks internals.
  function errorText(request: FastifyRequest): string | null {
    const code = (request.query as Record<string, unknown>)?.error;
    if (code === 'not_allowed') {
      return 'התפקיד שלך אינו מאפשר את הפעולה הזו.';
    }
    if (code === 'invalid') {
      return 'חלק מהשדות אינם תקינים.';
    }
    if (code === 'conflict') {
      return 'הרשומה כבר קיימת.';
    }
    if (typeof code === 'string' && code.length > 0) {
      return 'הפעולה לא הושלמה.';
    }
    return null;
  }

  // A create form posts, then the browser is sent back to the page it came
  // from — so a reload does not re-submit, and the new row is read back through
  // the same query the page always uses.
  function create(
    url: string,
    back: (request: FastifyRequest) => string,
    run: (
      body: Record<string, unknown>,
      session: Session,
      request: FastifyRequest,
    ) => Promise<void>,
  ): void {
    app.post(url, async (request, reply) => {
      const session = await currentSession(request);
      if (!session) {
        return reply.redirect('/admin/login', 302);
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        await run(body, session, request);
        return reply.redirect(back(request), 302);
      } catch (error) {
        const code = error instanceof KernelError ? error.code : 'unavailable';
        return reply.redirect(`${back(request)}?error=${code}`, 302);
      }
    });
  }

  app.get(
    '/admin',
    page('queue', async () =>
      emptyPage(
        'תור',
        'התור עוד לא נפתח. פניות דיירים ייכנסו לכאן עם מודול הפניות, בשבוע 5.',
      ),
    ),
  );

  // The destinations week 2 does not fill. Real URLs and real pages, so the nav
  // does not have to change when their content arrives.
  const pending: Array<[string, string, string, string]> = [
    [
      '/admin/conversations',
      'conversations',
      'שיחות',
      'תמלילי שיחות עם דונה, עם המקורות שצוטטו בכל תשובה, מגיעים בשבוע 4.',
    ],
    [
      '/admin/approvals',
      'approvals',
      'אישורים',
      'אישור טיוטות של דונה לפני שליחה — שבוע 7.',
    ],
    ['/admin/reports', 'reports', 'דוחות', 'דוחות תפעול — שבוע 7.'],
    [
      '/admin/guidance',
      'guidance',
      'הנחיות',
      'סוגי עבודות, כללי השתתפות עצמית ומדריכי עשה-זאת-בעצמך — שבוע 5.',
    ],
  ];
  for (const [url, dest, title, note] of pending) {
    app.get(
      url,
      page(dest, async () => emptyPage(title, note)),
    );
  }

  app.get(
    '/admin/properties',
    page('properties', async (session, context) =>
      buildingsPage(await queries.listBuildings(session), context),
    ),
  );

  app.get(
    '/admin/properties/:buildingId',
    page('properties', async (session, context, request) =>
      buildingPage(
        await queries.getBuilding(param(request, 'buildingId'), session),
        context,
      ),
    ),
  );

  app.get(
    '/admin/units/:unitId',
    page('properties', async (session, _context, request) =>
      unitPage(await queries.getUnitDetail(param(request, 'unitId'), session)),
    ),
  );

  app.get(
    '/admin/people',
    page('people', async (session, context, request) => {
      const phone = queryText(request, 'phone');
      // A malformed number is the same answer as one nobody holds: `invalid`
      // from the normaliser becomes "not found" rather than a different page,
      // so probing this box teaches nothing about which numbers are in the
      // system.
      let found = null;
      if (phone !== null) {
        try {
          found = await queries.findByPhone(phone, session);
        } catch (error) {
          if (!(error instanceof KernelError) || error.code !== 'invalid') {
            throw error;
          }
        }
      }
      return peoplePage(phone, found, context);
    }),
  );

  app.get(
    '/admin/people/:personId',
    page('people', async (session, _context, request) =>
      personPage(
        await queries.getPersonDetail(param(request, 'personId'), session),
      ),
    ),
  );

  create(
    '/admin/properties',
    () => '/admin/properties',
    async (body, session) => {
      await commands.addBuilding(
        {
          name: asString(body.name),
          city: asString(body.city),
          street: asString(body.street),
          houseNumber: asString(body.houseNumber),
        },
        session,
      );
    },
  );

  create(
    '/admin/properties/:buildingId/units',
    (request) =>
      `/admin/properties/${encodeURIComponent(param(request, 'buildingId'))}`,
    async (body, session, request) => {
      await commands.addUnit(
        {
          buildingId: param(request, 'buildingId'),
          label: asString(body.label),
          // An empty field is "no floor", not floor zero: a form always posts
          // its inputs, so "" is what an untouched optional box sends.
          floor: floorOf(body.floor),
        },
        session,
      );
    },
  );

  create(
    '/admin/people',
    () => '/admin/people',
    async (body, session) => {
      const person = await commands.addPerson(
        {
          // The form has no intent key to give, so the request supplies one.
          // A person has no natural key — two tenants can share a name — which
          // is why identity takes one at all (SPEC-identity.md).
          intentKey: `admin:${randomUUID()}`,
          displayName: asString(body.displayName),
          kinds: ['tenant'],
        },
        session,
      );
      const phone = asString(body.phone);
      if (phone.length > 0) {
        await commands.addPhone({ personId: person.id, phone }, session);
      }
    },
  );

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
