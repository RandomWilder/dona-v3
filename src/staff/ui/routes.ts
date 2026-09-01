import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  createCatalog,
  createDirectorySource,
} from '../../catalog/contract.ts';
import { createChannel } from '../../channel/contract.ts';
import { createIdentity } from '../../identity/contract.ts';
import { createAuditLog } from '../../kernel/audit.ts';
import { type Clock, systemClock } from '../../kernel/clock.ts';
import type { Embedder } from '../../kernel/embeddings.ts';
import { KernelError } from '../../kernel/errors.ts';
import type { Extractor } from '../../kernel/extraction.ts';
import type { ObjectStore } from '../../kernel/objects.ts';
import type { Html } from '../../kernel/ui/html.ts';
import {
  createOccupancy,
  type DocumentKind,
  maxDocumentBytes,
} from '../../occupancy/contract.ts';
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
  chunksPage,
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
  // Where lease documents live. Absent, occupancy falls back to a store that
  // throws rather than one that forgets (SPEC-occupancy.md).
  store?: ObjectStore;
  // How clause text becomes vectors. Absent, occupancy falls back to an embedder
  // that refuses rather than one that returns zeros.
  embedder?: Embedder;
  // How clauses become the twin's fields. Absent, occupancy falls back to an
  // extractor that refuses rather than one that returns nothing.
  extractor?: Extractor;
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

// The kind box on the upload form. An absent or unrecognised value is a lease:
// occupancy validates the vocabulary, and this only has to pick the string it
// hands over. Multipart fields arrive as objects with a `value`.
function kindOf(fields: unknown): DocumentKind {
  const field = (fields as Record<string, { value?: unknown }> | undefined)
    ?.kind;
  const value = typeof field?.value === 'string' ? field.value : '';
  return value.length > 0 ? (value as DocumentKind) : 'lease';
}

// The correction form, out of a posted body. The prefix is doing real work:
// this app's urlencoded parser is `Object.fromEntries(new URLSearchParams(…))`
// (`app.ts`), which keeps only the *last* of a repeated name — so a column of
// checkboxes all called `drop` would silently drop one row and leave the others,
// which is the worst possible failure for a form whose job is removing a row
// that should not be there. One name per input makes the collapse impossible.
function correction(body: Record<string, unknown>): {
  edits: Record<string, string>;
  drops: string[];
} {
  const edits: Record<string, string> = {};
  const drops: string[] = [];
  for (const [name, value] of Object.entries(body)) {
    if (name.startsWith('edit.') && typeof value === 'string') {
      edits[name.slice('edit.'.length)] = value;
    } else if (name.startsWith('drop.')) {
      // A checkbox posts only when it is ticked, so its presence is the answer
      // and its value is whatever the browser felt like sending.
      drops.push(name.slice('drop.'.length));
    }
  }
  return { edits, drops };
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
    store: deps.store,
    embedder: deps.embedder,
    extractor: deps.extractor,
  });
  // Slice 14.1b. Policy is org-wide, so the catalog needs no tenancy and no
  // session -- and `channel` is what puts the two corpora in order.
  const catalog = createCatalog({
    pool: deps.pool,
    clock,
    embedder: deps.embedder,
    source: createDirectorySource(),
  });
  const channel = createChannel({ occupancy, catalog });
  const guarded = {
    identity,
    portfolio,
    occupancy,
    channel,
    pool: deps.pool,
    clock,
  };
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

  // One file, capped where the module caps it — a second number here would
  // drift from the one occupancy enforces, and the request would be read into
  // memory before anything refused it.
  app.register(multipart, {
    limits: { files: 1, fileSize: maxDocumentBytes, fields: 4 },
  });

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
    page('properties', async (session, context, request) =>
      unitPage(
        await queries.getUnitDetail(param(request, 'unitId'), session),
        context,
      ),
    ),
  );

  app.get(
    '/admin/units/:unitId/documents/:documentId/chunks',
    page('properties', async (session, context, request) =>
      chunksPage(
        await queries.getDocumentChunks(
          param(request, 'unitId'),
          param(request, 'documentId'),
          session,
          // A GET with the question in the query string, so a search is a link
          // an operator can share and reload — and so nothing on this page
          // needs JavaScript, which is the rule the admin shell states about
          // itself (SPEC-staff.md).
          asString((request.query as Record<string, unknown>)?.q),
        ),
        context,
      ),
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

  // The upload. A file arrives as multipart; everything else on this screen is
  // a urlencoded form, which is why this does not go through `create()`.
  app.post('/admin/units/:unitId/documents', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return reply.redirect('/admin/login', 302);
    }
    const unitId = param(request, 'unitId');
    const back = `/admin/units/${encodeURIComponent(unitId)}`;
    try {
      const file = await request.file();
      if (!file) {
        throw new KernelError('invalid', 'no file was posted');
      }
      // Read before the capability check only because the parser has already
      // begun; the check still runs before anything is stored, inside the
      // guarded surface. `truncated` is how @fastify/multipart reports the cap
      // being hit, and a truncated PDF must not be stored as a whole one.
      const bytes = await file.toBuffer();
      if (file.file.truncated) {
        throw new KernelError('invalid', 'the document is too large', {
          maxBytes: maxDocumentBytes,
        });
      }

      // The tenancy is resolved here, from the unit, and is never a hidden
      // field: a caller-supplied tenancy id would let a crafted post file a
      // document against a tenancy the operator never opened.
      const tenancy = await occupancy.findCurrentTenancy(unitId);
      if (!tenancy) {
        throw new KernelError('invalid', 'the flat has no current tenancy');
      }

      await commands.attachDocument(
        {
          tenancyId: tenancy.tenancy.id,
          kind: kindOf(file.fields),
          // The browser's content type, checked by the module against the one
          // type it accepts. The filename it also sent is deliberately dropped
          // on the floor: it is a person's name on its way into a log.
          contentType: file.mimetype,
          bytes,
        },
        session,
      );
      return reply.redirect(back, 302);
    } catch (error) {
      const code = error instanceof KernelError ? error.code : 'unavailable';
      return reply.redirect(`${back}?error=${code}`, 302);
    }
  });

  // A pair of ids in a URL is a caller-supplied claim until this turns it into a
  // fact. 11.2 resolves the tenancy from the unit rather than accepting one from
  // the browser; this is that rule read from the other direction, and it is the
  // same check for every write that names a document — one place, so a fifth
  // route cannot be the one that forgets.
  async function requireDocumentOfUnit(
    unitId: string,
    documentId: string,
  ): Promise<void> {
    const tenancy = await occupancy.findCurrentTenancy(unitId);
    const documents = tenancy
      ? await occupancy.listDocuments(tenancy.tenancy.id)
      : [];
    if (!documents.some((document) => document.id === documentId)) {
      throw new KernelError('not_found', 'document not found');
    }
  }

  // Back to the chunks page, which is where a document's clauses, its fields and
  // the reviews of those fields are read against each other.
  function backToChunks(request: FastifyRequest): string {
    return `/admin/units/${encodeURIComponent(param(request, 'unitId'))}/documents/${encodeURIComponent(param(request, 'documentId'))}/chunks`;
  }

  // Reading a stored lease into clauses. A button and not a step of the upload:
  // the lease this system reads was in the bucket before ingestion existed, and
  // a 38-page extraction inside the upload request would hold the browser open
  // for no gain (SPEC-staff.md, "Ingesting a document").
  create(
    '/admin/units/:unitId/documents/:documentId/ingest',
    (request) => `/admin/units/${encodeURIComponent(param(request, 'unitId'))}`,
    async (_body, session, request) => {
      const documentId = param(request, 'documentId');
      await requireDocumentOfUnit(param(request, 'unitId'), documentId);
      await commands.ingestDocument({ documentId }, session);
    },
  );

  // Reading a document's clauses into the twin's fields. Its own button and its
  // own command, for the reason ingestion is: this is a judgement a human
  // reviews, not a step of storing a file (SPEC-staff.md, "Reading the lease's
  // fields").
  create(
    '/admin/units/:unitId/documents/:documentId/extract',
    backToChunks,
    async (_body, session, request) => {
      const documentId = param(request, 'documentId');
      await requireDocumentOfUnit(param(request, 'unitId'), documentId);
      await commands.extractTwin({ documentId }, session);
    },
  );

  // Confirming a field: the operator says the extraction read it right. Nothing
  // about the value is posted — the command copies it off the fact it reads
  // itself. The one thing the form carries is the id of the extraction being
  // looked at, so a re-read between the render and the press is a `conflict`
  // rather than a name attached to a value nobody saw.
  create(
    '/admin/units/:unitId/documents/:documentId/fields/:field/confirm',
    backToChunks,
    async (body, session, request) => {
      const documentId = param(request, 'documentId');
      await requireDocumentOfUnit(param(request, 'unitId'), documentId);
      await commands.reviewLeaseField(
        {
          documentId,
          // Checked against occupancy's registry rather than trusted from the
          // URL, like every other value that arrives in a path.
          field: param(request, 'field'),
          factId: asString(body.factId),
          decision: 'confirmed',
        },
        session,
      );
    },
  );

  // Correcting one. The form posts changes and never a value: `edit.<path>` for
  // a scalar the contract states and `drop.<row>` for a row that does not
  // belong, both applied by occupancy to the value it reads.
  create(
    '/admin/units/:unitId/documents/:documentId/fields/:field/correct',
    backToChunks,
    async (body, session, request) => {
      const documentId = param(request, 'documentId');
      await requireDocumentOfUnit(param(request, 'unitId'), documentId);
      await commands.reviewLeaseField(
        {
          documentId,
          field: param(request, 'field'),
          factId: asString(body.factId),
          decision: 'corrected',
          ...correction(body),
        },
        session,
      );
    },
  );

  // The bytes back. Inline rather than an attachment: an operator checking a
  // lease wants to read it, and a download would leave the file on a laptop.
  app.get('/admin/documents/:documentId', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return reply.redirect('/admin/login', 302);
    }
    const { document, bytes } = await queries.getDocument(
      param(request, 'documentId'),
      session,
    );
    reply
      .header('content-type', document.contentType)
      .header('content-disposition', 'inline')
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff');
    return reply.send(bytes);
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
