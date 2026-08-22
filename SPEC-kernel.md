# SPEC: kernel

Conventions inherited from SPEC.md. The kernel holds no business logic — it is the shared machinery every module is built on.

- **Responsibility:** Ids, clock, error shape, migrations, idempotency, audit, outbox, durable work
- **Depends on:** — (nothing; every other module may depend on it)

## Primitives (slice 2.2)

- **Error shape** — `KernelError(code, message, details?)` and `toErrorBody()`. The five codes are fixed in SPEC.md; `toErrorBody` maps any non-kernel error to `unavailable` so internals never reach the wire. `httpStatus(code)` is the single place status codes are decided.
- **Ids** — `newId(clock)` returns RFC 9562 UUIDv7: a 48-bit millisecond timestamp then random bits, so ids sort by creation time and stay index-friendly as Postgres primary keys.
- **Clock** — `Clock.now()`. Business logic never calls `Date.now()` or `new Date()`; it receives a clock. `fixedClock(start)` is the test double and advances on demand. Time reaches SQL as a bound parameter, never as `NOW()`.

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

## Decisions

Recorded so they are not relitigated (PIPELINE.md §9, "chat-driven architecture").

1. **Postgres only, no in-memory twins.** dona-v2 maintained parallel memory and Postgres implementations of all three; they drift, and the kernel is Postgres-backed by SPEC.md rule 5. One code path. Tests skip when Postgres is unreachable (`pg-support.ts`) — CI must therefore run with a Postgres service, or the durability suite silently no-ops.
2. **No sleeps, in code or tests.** dona-v2 busy-waited 20ms on idempotency contention and polled with `setTimeout` in tests. Contention returns `conflict`; tests drive `tick()` and advance a `fixedClock`.
3. **The clock is a parameter, not `NOW()`.** Time in SQL comes from the injected clock, so deadline behavior is provable without waiting for it.
4. **Explicit `state` on idempotency keys.** dona-v2 used a null `result` to mean "in flight", which cannot distinguish that from a command whose result is legitimately null.
5. **Failed commands release their key.** The alternative — memoizing failures — would make a transient database blip permanent for that intent.
