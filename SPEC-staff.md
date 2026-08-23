# SPEC: staff

Stub — gains its commands in its build week (see ROADMAP.md). Conventions inherited from SPEC.md.

- **Responsibility:** Admin panel edge: auth, roles, queue, conversations, approvals, settings
- **Depends on:** all modules
- **Commands:** TBD (defined here before implementation)
- **Events:** TBD
- **Success criteria:** TBD

## Presentation surface (slice 5.1)

`GET /admin` serves `ui/index.html` — the ops shell. Registered through `contract.ts`
(`registerStaffUi`), so the composition root never reaches into this module's `ui/`.

**Chrome.** A dark rail (`--color-chrome`) on the inline-start edge — which is the *right* in
Hebrew RTL — carrying the brand and the seven destinations named in ROADMAP week 2:
תור · שיחות · אישורים · דוחות · נכסים · אנשים · הנחיות. They are fixed now so week 2 fills
panels in rather than renaming them.

**Three widths, one shell.** ≥1100px: full sidebar. 840–1099px: the rail collapses to icons,
labels move to `title` (the destinations stay reachable, the ops board stays wide). ≤839px: the
rail becomes a drawer behind a top bar — the office is desk-first, but the shell must not break
on a phone, because that is what Friday's demo opens.

**Shell only.** Every destination renders an empty state, not a fake table. Nothing here reads
data; there is no data. Controls follow the ops sizing from `.cursor/rules/ui-tokens.mdc`:
`--size-control-ops` (36px) on the board, `--size-touch` (44px) below 480px.

**No auth yet.** `/admin` is open on staging until slice 5.2 puts a session in front of it. It
exposes nothing — no data, no commands — so the gap is a missing gate, not a leak. 5.2 closes it
before any real content lands behind it.

## Authentication (slice 5.2)

One seeded operator, a server session, and a gate in front of `/admin`. **Roles are not
here** — admin/operator/viewer and "viewer can't mutate, proven by test" are ROADMAP week 2.
Staff credentials live in this module permanently: `identity` owns people, phones and roles
for tenants and vendors, while staff auth is the admin-panel edge, which is what SPEC.md
already says this module is.

### Credential record

`scrypt$N=<n>,r=<r>,p=<p>$<salt-hex>$<hash-hex>` — the cost parameters are stored **in the
record**, so raising them later re-hashes on next login instead of invalidating every
password. Defaults `N=16384, r=8, p=1`, 16-byte salt, 64-byte output. The verifier reads
parameters out of the record it is checking, never out of today's configuration.

Passwords are validated at the edge: at least 12 characters. A shorter one is rejected
before it can be stored.

### Sessions

- Token is 32 random bytes from `randomBytes`, handed to the browser in a cookie and
  **never stored**. `staff_sessions` holds `sha256(token)`. Reading the table gives an
  attacker nothing to ride. A fast hash is right here: the token has 256 bits of entropy,
  so there is no dictionary to run.
- Lifetime 12 hours, absolute — no sliding renewal, no "remember me".
- Expired rows are deleted when a session is read and when a login succeeds. Expiry is
  decided by the injected clock as a bound SQL parameter, never `now()`.
- Cookie `dona_session`: `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` **whenever the
  request arrived over https** — always true on Cloud Run, never on local http, with no
  environment sniffing to get wrong.

### Failed-attempt throttle

`staff_login_attempts` records one row per failed attempt, keyed on the submitted email.
More than **5 failures in 15 minutes** and the account refuses every attempt for the rest
of the window, correct password included; a success clears the account's rows. Postgres-
backed so it holds across Cloud Run instances, and clock-driven so tests never sleep.

This is what SPEC.md's "rate-limit public endpoints" means for the login form, and no more:
per-IP limiting needs a deliberate trust-proxy decision about `X-Forwarded-For` and waits
for week 6.

### One response for every failure

Unknown email, wrong password, throttled account, malformed input: the same `not_allowed`,
the same message, the same redirect to `/admin/login?error=1`. When no operator matches, the
password is still verified against a fixed dummy record, so the two paths do the same work
and cannot be told apart by timing. The one observable difference is deliberate: a throttled
account stays refused even with the right password.

### Seeding

`boot.ts` reads `STAFF_SEED_EMAIL` and `STAFF_SEED_PASSWORD` after migrations and before
`listen()`. Both set and no operator with that email → create one. Either unset → do nothing
and say so in the boot line, so a missing secret can never quietly produce an account.
Password too short → boot fails, rather than seeding something weak. Second run with the
same email → no-op, so every deploy re-running the seeder is safe.

In staging and prod both values come from Secret Manager, mounted like `DATABASE_URL`.
The password never appears in the repo, in a log, in an audit record, or in an agent's
context.

### Audited

Login and logout go through the kernel audit log with `actorKind: 'staff'`: the email and
the outcome, never the password and never the session token. `audit_log` is a table and the
email is deliberate there (SPEC-kernel.md) — but it must never reach stdout.

### Not yet in place

CSP headers · per-IP rate limits · password rotation and change flow · lockout notification ·
login CSRF (`SameSite=Lax` covers cookie-bearing cross-site POSTs, which is logout; a forced-
login CSRF remains possible and is accepted for a single-operator ops board). All week 6.
