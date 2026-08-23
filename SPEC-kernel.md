# SPEC: kernel

Conventions inherited from SPEC.md. The kernel holds no business logic — it is the shared machinery every module is built on.

- **Responsibility:** Ids, clock, error shape, migrations, idempotency, audit, outbox, durable work
- **Depends on:** — (nothing; every other module may depend on it)

## Primitives (slice 2.2)

- **Error shape** — `KernelError(code, message, details?)` and `toErrorBody()`. The five codes are fixed in SPEC.md; `toErrorBody` maps any non-kernel error to `unavailable` so internals never reach the wire. `httpStatus(code)` is the single place status codes are decided.
- **Ids** — `newId(clock)` returns RFC 9562 UUIDv7: a 48-bit millisecond timestamp then random bits, so ids sort by creation time and stay index-friendly as Postgres primary keys.
- **Clock** — `Clock.now()`. Business logic never calls `Date.now()` or `new Date()`; it receives a clock. `fixedClock(start)` is the test double and advances on demand. Time reaches SQL as a bound parameter, never as `NOW()`.

### At the HTTP edge (slice 5.1)

`buildApp` installs `setNotFoundHandler` and `setErrorHandler`, so Fastify's own bodies never reach the wire: its 404 echoes the requested path back, and its 500 carries the thrown message. Both now render as `{ code, message }` — an unknown route is `not_found`, and anything unrecognised becomes `unavailable` / "unexpected error" via `toErrorBody`. This mattered the moment the app grew a second route.

Known gap, to close with the first route that takes a body: Fastify's schema-validation failures are client errors and must map to `invalid` (400), not `unavailable` (503). Every route today is a GET with no body, so nothing can reach that path yet.

### Module-owned tables (slice 5.2)

Migration `0003_staff_auth.sql` is the first schema the kernel runs on another module's behalf. The runner is kernel machinery; the tables are not. A module's tables are described in that module's spec — `SPEC-staff.md` for `staff_operators`, `staff_sessions` and `staff_login_attempts` — and the kernel never reads them.

## Idempotency (`idempotency.ts`)

`once<T>(key, work)` — the key is the caller's business intent (job id, offer id), never a random value.

- First call claims the key atomically and runs the work.
- A later call with the same key returns the **first result**, deep-copied so callers cannot mutate the stored value.
- A call arriving while the first is still running gets `conflict`.
- A command that **throws** releases its key: failures are retryable, only successes are memoized.
- A claim older than `staleAfterMs` (default 60s, measured on the injected clock) is reclaimable, so a process that dies mid-command cannot wedge a key permanently.

## Audit (`audit.ts`)

`write(entry)` records one row: actor (kind + id), action, subject, inputs, outcome. `around(entry, work)` wraps a command and records `ok` or `error` with the `KernelError` code either way, then re-throws — this is what makes "every command is audited" enforceable rather than aspirational.

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

## Decisions

Recorded so they are not relitigated (PIPELINE.md §9, "chat-driven architecture").

1. **Postgres only, no in-memory twins.** dona-v2 maintained parallel memory and Postgres implementations of all three; they drift, and the kernel is Postgres-backed by SPEC.md rule 5. One code path. Tests skip when Postgres is unreachable (`pg-support.ts`) — CI must therefore run with a Postgres service, or the durability suite silently no-ops. `REQUIRE_POSTGRES=1` makes that a failure instead of an assumption: with it set, an unreachable database throws `unavailable` rather than returning `null`. CI sets it; local runs do not, so a developer without Docker still gets a useful test run.
2. **No sleeps, in code or tests.** dona-v2 busy-waited 20ms on idempotency contention and polled with `setTimeout` in tests. Contention returns `conflict`; tests drive `tick()` and advance a `fixedClock`.
3. **The clock is a parameter, not `NOW()`.** Time in SQL comes from the injected clock, so deadline behavior is provable without waiting for it.
4. **Explicit `state` on idempotency keys.** dona-v2 used a null `result` to mean "in flight", which cannot distinguish that from a command whose result is legitimately null.
5. **Failed commands release their key.** The alternative — memoizing failures — would make a transient database blip permanent for that intent.
