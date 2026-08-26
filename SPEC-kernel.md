# SPEC: kernel

Conventions inherited from SPEC.md. The kernel holds no business logic — it is the shared machinery every module is built on.

- **Responsibility:** Ids, clock, error shape, migrations, idempotency, audit, outbox, durable work
- **Depends on:** — (nothing; every other module may depend on it)

## Primitives (slice 2.2)

- **Error shape** — `KernelError(code, message, details?)` and `toErrorBody()`. The five codes are fixed in SPEC.md; `toErrorBody` maps any non-kernel error to `unavailable` so internals never reach the wire. `httpStatus(code)` is the single place status codes are decided.
- **Ids** — `newId(clock)` returns RFC 9562 UUIDv7: a 48-bit millisecond timestamp then random bits, so ids sort by creation time and stay index-friendly as Postgres primary keys.
- **Clock** — `Clock.now()`. Business logic never calls `Date.now()` or `new Date()`; it receives a clock. `fixedClock(start)` is the test double and advances on demand. Time reaches SQL as a bound parameter, never as `NOW()`.

### Edge validation (`validate.ts`, slice 7.1)

`requireText(value, field, max)` · `optionalText(value, field, max)` ·
`validId(value, field)` · `asText(value)`.

Everything a caller can get wrong becomes `KernelError('invalid', ...)` here, rather than a
Postgres cast error surfacing as `unavailable` three layers down. `requireText` trims first
and measures after, so a padded 200-character name is 200 characters and `'   '` is empty.
`asText` never throws: audit entries are built *before* validation runs, so the entry has to
survive a caller passing a number where a string belongs.

Extracted at the rule of three — `identity` and `portfolio` each carried a private copy, and
`occupancy` would have been the third. They live in the kernel because they are the *shape*
of a value and nothing more. A validator that knows a domain vocabulary stays in its module:
`portfolio`'s `validKind` and `optionalFloor`, `identity`'s `validKinds` and `validLanguage`,
`occupancy`'s `validRole`. The line is whether the kernel would have to learn a business
word to hold it — the kernel holds no business logic.

### At the HTTP edge (slice 5.1)

`buildApp` installs `setNotFoundHandler` and `setErrorHandler`, so Fastify's own bodies never reach the wire: its 404 echoes the requested path back, and its 500 carries the thrown message. Both now render as `{ code, message }` — an unknown route is `not_found`, and anything unrecognised becomes `unavailable` / "unexpected error" via `toErrorBody`. This mattered the moment the app grew a second route.

Known gap, to close with the first route that takes a body: Fastify's schema-validation failures are client errors and must map to `invalid` (400), not `unavailable` (503). Every route today is a GET with no body, so nothing can reach that path yet.

### Module-owned tables (slice 5.2)

Migration `0003_staff_auth.sql` is the first schema the kernel runs on another module's behalf. The runner is kernel machinery; the tables are not. A module's tables are described in that module's spec — `SPEC-staff.md` for `staff_operators`, `staff_sessions` and `staff_login_attempts` — and the kernel never reads them.

## Object store (`objects.ts`, slice 11.2)

`put(path, bytes, contentType)` and `read(path)`. Infrastructure on the same footing as
`db.ts`: it holds the shape of a transfer and no business logic at all — it does not know
what a lease is, and the paths it is handed are built by the module that owns them
(`SPEC-occupancy.md`).

Two implementations. `createGcsStore({ bucket })` talks to the GCS JSON API over `fetch`,
with `google-auth-library` for access tokens and nothing else: token acquisition differs
between Cloud Run's metadata server and a laptop's ADC, and hand-rolling an OAuth refresh
for a bucket holding signed contracts is the wrong economy — while the transfer itself is
two HTTP calls that need no SDK. `createMemoryStore()` is what the tests use, so no test
reaches the network and none needs a bucket.

**Which one is running is reported at boot**, beside the seed lines. An absent
`DOCS_BUCKET` is not an error — locally there is no bucket and `npm run dev` must still
start — so it falls back to memory and *says so*. A deployed revision whose boot line reads
`docs: memory` is wrong in the same visible way a `-dev` version string is.

A missing object is `not_found`, never empty bytes.

## PDF text (`pdf.ts`, slice 12.1)

`pages(bytes)` → one entry per page, each carrying its size and its **positioned** text
items. Infrastructure on the same footing as `objects.ts`: it holds the shape of a document
and no business logic — it does not know what a lease or a clause is, and the module that
does (`SPEC-occupancy.md`) turns these items into chunks.

**Positions, not a string.** A reader that returns page text as a paragraph is unusable for
the document this system exists to read: the lease's facts live in a two-column label/value
annex, and flattened text binds each value to the label on the line above. `getTextContent()`
gives every item an x/y transform, a width and a bidi direction, which is what makes both the
column pairing and a traceable citation possible.

`createPdfjsText()` wraps Mozilla's `pdfjs-dist` — the one runtime dependency this slice
added, and the reason is the paragraph above. It is imported lazily, so a process that never
reads a PDF never pays for it. The input is a third-party PDF, and a PDF is a program, so
nothing here renders: `useSystemFonts: false` and `disableFontFace: true`, because text
extraction needs no glyph built at runtime. (pdfjs's `isEvalSupported` switch, the obvious
thing to reach for, no longer exists in v6 — eval-based font compilation was removed from the
library outright, which is the stronger version of setting it.)

A file that is not a PDF, or is one the parser cannot open, is `invalid` — never a driver
stack. A page with no text layer is **not** an error: it comes back with zero items, and
saying which pages those were is the caller's job (week 3's OCR cut line).

## Settings (`config.ts`, slice 12.2)

SPEC.md rule 4 says policies are data — "config rows editable in admin, never constants". Until
12.2 nothing in this system had a tunable, so nothing config-shaped existed. The embedding model
id and its dimension count are the first, and this is the smallest thing that honours the rule.

One table, `config_settings`: `key` text primary key, `value` jsonb, `updated_at`. A typed reader
(`getSetting(key, fallback)`) and nothing else — **no admin screen**, which is week 5's `catalog`
and is where the "editable in admin" half of rule 4 gets built. Until then a row is changed by
hand, and that is the honest state.

### The dimension is config *and* schema, and the reader says so

A `vector(n)` column has its dimension compiled into the column type. So `embedding.dimensions`
cannot be freely edited the way a deductible can: changing it without a migration produces
vectors the column rejects, or — worse, if the column were untyped — vectors nothing can compare.

The reader therefore **asserts the row agrees with the schema's width** and refuses to embed when
it does not. A setting that can be set to a value the system cannot honour is a trap; one that
refuses loudly is a config row with a constraint, which is what this one is. Changing the
dimension is a migration plus a re-embed, and the spec says so rather than letting someone
discover it.

## Embeddings (`embeddings.ts`, slice 12.2)

`embed(texts)` → one vector per text, order preserved. Infrastructure on the footing `objects.ts`
and `pdf.ts` stand on: it holds the shape of a call and no business logic — it does not know what
a lease or a clause is.

**The first model call this project makes.** Weeks 1–2 built an operations system of record with
no AI in it at all; SPEC.md rule 2 governs what happens from here — the agent is a client, never
a brain, and this is a client of the narrowest kind: text in, numbers out, no prompt.

`createOpenAiEmbedder({ apiKey, model, dimensions })` talks to the embeddings endpoint over
`fetch` with no SDK, the same economy `objects.ts` argued for GCS: one HTTP call, a bearer token,
and a JSON body. `text-embedding-3-large` requested at 1536 dimensions — the model ROADMAP.md
names, at a width pgvector can index, since hnsw caps at 2000 and the model's native 3072 would
force `halfvec`.

Texts are sent in batches, and a batch that fails is not silently partial: the call throws and
the caller's transaction rolls back, so a document is never half-indexed.

`createUnconfiguredEmbedder()` is the default when no key is configured, and it **throws** rather
than returning zeros — the same argument `createUnconfiguredStore` makes. A process that lost its
key must not index a lease into vectors that match nothing, because that failure is invisible
until someone asks a question and gets silence.

**Which one is running is reported at boot**, beside the document store. A deployed revision
running on a refusing embedder is wrong in exactly the way `docs: memory` is wrong, and it has to
be sayable.

## Idempotency (`idempotency.ts`)

`once<T>(key, work)` — the key is the caller's business intent (job id, offer id), never a random value.

- First call claims the key atomically and runs the work.
- A later call with the same key returns the **first result**, deep-copied so callers cannot mutate the stored value.
- A call arriving while the first is still running gets `conflict`.
- A command that **throws** releases its key: failures are retryable, only successes are memoized.
- A claim older than `staleAfterMs` (default 60s, measured on the injected clock) is reclaimable, so a process that dies mid-command cannot wedge a key permanently.

## Audit (`audit.ts`)

`write(entry)` records one row: actor (kind + id), action, subject, inputs, outcome. `around(entry, work)` wraps a command and records `ok` or `error` with the `KernelError` code either way, then re-throws — this is what makes "every command is audited" enforceable rather than aspirational.

`actor_role` (added slice 9.1) records the role an actor held when the entry was written — nullable, because tenant, agent and system actors have none, and unconstrained, because the kernel does not know any module's role vocabulary. It answers "what permitted this", which `actor_id` alone cannot.

`audit_log` is a **table, not a log**. SPEC.md's "PII never in logs" governs log output; command inputs are stored here deliberately, because the audit trail is the system of record for who did what. Field-level redaction is a later concern and belongs in this module when it arrives.

## Outbox (`events.ts`)

`publish(event)` writes the row first, then attempts delivery in the same call. A handler that throws leaves the row unhandled with `last_error` set; the event is never lost because the write precedes delivery. `deliverPending()` replays unhandled rows in `at` order and is the recovery path after a crash or restart.

## Durable work (`work.ts`)

`schedule({kind, runAt, payload, intentKey?})` · `cancel(id)` · `register(kind, handler)` · `tick()` · `start()` / `stop()`.

- Scheduling twice with the same `intentKey` returns the existing id — timers are idempotent on intent, like commands.
- `tick()` drains everything due at the clock's current time; `start()` only calls `tick()` on an interval. Tests drive `tick()` directly, so no test ever sleeps.
- Claiming uses `FOR UPDATE SKIP LOCKED`: two runners can never take the same job.
- A failing handler backs off exponentially, capped at 60s, and records `last_error`.
- Work outlives the process — it lives in Postgres, so a runner started after a restart picks up what an earlier one scheduled.

## Shared UI surface (slice 5.1)

SPEC.md rule 6 — one presentation system — lives here: the kernel owns the token layer and the fonts, and every screen in every module is a self-contained HTML file that links it.

- **`ui/tokens.css`** — the only place a colour, a type face, a size, a radius or a spacing step is named. Ported verbatim from dona-v2, where it was proven RTL-correct; changing a value here changes it everywhere, which is the point. A screen that hard-codes `#fff` or `14px` has left the system.
- **`ui/fonts/*.woff2`** — Heebo (Hebrew + Latin subsets) and IBM Plex Mono, self-hosted with their OFL licences beside them. No Google Fonts request: tenant screens must not leak a visit to a third party, and the pages must render on a slow Israeli mobile connection without a second DNS lookup.
- **`ui/assets.ts`** — `registerUiAssets(app)` serves `GET /ui/tokens.css` and `GET /ui/fonts/:file`. Files are read once at registration, not per request: the deployed image is immutable, so disk I/O on the hot path buys nothing.
- **Font names are an allowlist, never a path.** The `:file` parameter is matched against a fixed `Set` and otherwise 404s; no request-derived string is ever joined onto a filesystem path. This is the rule for every static route the system ever grows.
- **Caching** — fonts `public, max-age=31536000, immutable` (their names are stable and their bytes never change). HTML and `tokens.css` are `no-cache` until assets are content-hashed, so a deploy cannot leave a stale stylesheet against fresh markup.

`ui/tokens.test.ts` enforces the invariant from the outside: no shell may contain a hex colour, a `fonts.googleapis` URL, or a physical `left:`/`right:`. It fails on the HTML, not on the CSS, because that is where the discipline actually erodes.

## Escaping data into HTML (`ui/html.ts`, slice 10.1)

Until 10.1 every screen was a static file and no request-derived or database-derived string
ever reached the markup — `staff/ui/routes.ts` said so as a property of the login page. The
people and properties views end that: a tenant's name, a building's street, a unit's label
and an operator's own typing all now land inside HTML. So the escaper lands in the kernel
before the first view needs it, on the same argument that moved `requireText` here in 7.1 —
`channel` renders tenant-supplied text in week 4, and a second copy would drift.

- **`escapeHtml(value)`** — `&`, `<`, `>`, `"`, `'` to their entities, ampersand first so an
  escape is never itself re-escaped. Non-strings are refused rather than coerced: `String(x)`
  on an object yields `[object Object]`, which hides a bug instead of surfacing it.
- **``h`...` ``** — a tagged template where the literal parts pass through untouched and
  **every interpolation is escaped**. This is the form the views use. The direction matters:
  escaping by default means forgetting a call is impossible, where an `escapeHtml()` you must
  remember to write is one edit away from an injection. There is deliberately **no** "raw" or
  "trusted" escape hatch — a view that needs to compose markup nests one `h` inside another.
- Numbers interpolate as numbers; `null` and `undefined` render as the empty string rather
  than as the words "null" and "undefined", which is what a nullable `floor` or `endsOn` wants.

`ui/html.test.ts` covers each character, the literal/interpolation split, and the case the
rule exists for: a person recorded as `<script>alert(1)</script>` renders inert.

## Decisions

Recorded so they are not relitigated (PIPELINE.md §9, "chat-driven architecture").

1. **Postgres only, no in-memory twins.** dona-v2 maintained parallel memory and Postgres implementations of all three; they drift, and the kernel is Postgres-backed by SPEC.md rule 5. One code path. Tests skip when Postgres is unreachable (`pg-support.ts`) — CI must therefore run with a Postgres service, or the durability suite silently no-ops. `REQUIRE_POSTGRES=1` makes that a failure instead of an assumption: with it set, an unreachable database throws `unavailable` rather than returning `null`. CI sets it; local runs do not, so a developer without Docker still gets a useful test run.
2. **No sleeps, in code or tests.** dona-v2 busy-waited 20ms on idempotency contention and polled with `setTimeout` in tests. Contention returns `conflict`; tests drive `tick()` and advance a `fixedClock`.
3. **The clock is a parameter, not `NOW()`.** Time in SQL comes from the injected clock, so deadline behavior is provable without waiting for it.
4. **Explicit `state` on idempotency keys.** dona-v2 used a null `result` to mean "in flight", which cannot distinguish that from a command whose result is legitimately null.
5. **Failed commands release their key.** The alternative — memoizing failures — would make a transient database blip permanent for that intent.
