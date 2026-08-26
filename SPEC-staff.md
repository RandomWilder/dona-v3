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

> **Superseded in part by slice 10.1**, below: `נכסים` and `אנשים` now render real rows, the
> shell is server-rendered, and each destination has its own URL. The chrome, the seven
> destinations, the three widths and the control sizing are unchanged — which was the point of
> fixing them in 5.1.

**No auth yet.** `/admin` is open on staging until slice 5.2 puts a session in front of it. It
exposes nothing — no data, no commands — so the gap is a missing gate, not a leak. 5.2 closes it
before any real content lands behind it.

## Authentication (slice 5.2)

One seeded operator, a server session, and a gate in front of `/admin`. **Roles are not
here** — admin/operator/viewer and "viewer can't mutate, proven by test" arrived in slice
9.1, below.
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

## Roles (slice 9.1)

Three roles on the operator, checked server-side on every command. A hidden button is
not a permission check, so nothing in this module gates on the UI: the guard runs before
the domain module is reached, and the test that proves it calls the command directly.

### The matrix

| capability | admin | operator | viewer |
|---|---|---|---|
| `read` — see the board and everything on it | ✔ | ✔ | ✔ |
| `mutate` — create or change people, places, tenancies | ✔ | ✔ | — |
| `administer` — operators, roles, policy rows | ✔ | — | — |

`administer` has no commands behind it yet; it is named now so that the first one to
arrive has an answer waiting rather than inventing a fourth role.

**This matrix is code, not a config row — a stated exception to SPEC.md rule 4.** Rule 4
governs tunables: rates, timeouts, deductibles, kill switches. An access-control matrix
that a runtime row could widen is a privilege-escalation path with a database write as
its exploit; changing who may mutate must cost a deploy and leave a diff.

`internal/roles.ts` holds it, pure and tested alone — the shape `occupancy` uses for
`tenancyAccess`: decided once, never re-decided at a call site. `validRole` lives here
too and not in the kernel, for the reason slice 7.1 drew that line: the kernel holds the
*shape* of a value, never a domain word.

### On the record, and in the session

`staff_operators.role` is `NOT NULL` with a `CHECK` on the three values and **no
`DEFAULT`** — every insert names a role rather than inheriting a lucky one. The role
travels on the session that `readSession` already returns, so a request costs no extra
query to know what its holder may do.

Migration `0008` backfills every existing operator to `admin`. That is what makes the
account already seeded on staging and prod an admin: the seeder creates but never
updates, so a migration is the only thing that can reach a row that already exists.

### Seeding

`seedStaffOperator` creates an `admin`, fixed rather than env-driven. It is the only
account at boot; a `STAFF_SEED_ROLE` that could be set to `viewer` is a way to deploy a
system with no way to administer it.

### The guarded surface (`internal/commands.ts`)

`staff` owns no domain tables, and until this slice it owned no commands either — which
left "a viewer cannot mutate" with nothing to call. It now fronts the mutating commands
of `identity`, `portfolio` and `occupancy` — `addPerson`, `addPhone`, `addBuilding`,
`addUnit`, `addAsset`, `openTenancy`, `addParty`, `endTenancy` and, as of slice 11.2,
`attachDocument` — each taking `(input, session)`. The three modules are injected as their contract types, so the dependency is
visible in the constructor rather than buried in a call.

Each command, in this order:

1. `requireCapability(role, 'mutate')` — **before** the module is reached, so a refusal
   never touches domain state;
2. inside `audit.around`, so a refusal leaves an `error` row with code `not_allowed`
   rather than no row at all — the pattern `identity` established for rejected commands;
3. then the module command, with `actor: { kind: 'staff', id: operator.id }`.

**A successful staff mutation writes two audit rows, deliberately.** The edge row
(`staff.addBuilding`) records the decision and the role that permitted it; the module row
(`portfolio.addBuilding`) records the change. Read later as duplication, they would
invite a "cleanup" that deletes the only record of *who was allowed*.

### Audited with the role

Every entry this module writes carries `actorRole` — the kernel's `audit_log.actor_role`,
nullable because tenant, agent and system actors have no role. Login and logout carry it
too, which is what lets the week-2 demo show two sessions apart in the trail.

### Not here

~~No route calls the guarded surface yet~~ — slice 10.1 below is the caller this predicted.
No second operator can be created either — the seeder creates but never updates, and there
is no operator-management screen, so the viewer account for the week-2 demo has to be made
by hand. That is still true after 10.1.

## Documents on the unit view (slice 11.2)

The upload surface for lease documents. It adds no new access rule and deliberately reuses
both existing ones: writing is `mutate`, so a viewer is refused by the same guard that
refuses every other write, and reading is `read` **and audited**, because a lease is
exactly the record a privacy request means when it asks who opened a tenant's file. That is
the line 10.1 drew — a list read writes no row, a detail read writes one — and a document
is the most detailed read in the system.

### The tenancy is resolved on the server

`POST /admin/units/:unitId/documents` posts a file and nothing else. The tenancy it attaches
to is found by `occupancy.findCurrentTenancy(unitId)` on the server; it is **never a hidden
field in the form**. A hidden field is a caller-supplied id, and the caller here is a
browser: accepting one would let a crafted post file a document against a tenancy the
operator never opened, which is the isolation failure this system is built to make
impossible rather than unlikely.

A vacant flat therefore refuses with `invalid` rather than inventing a tenancy — the same
vacancy `findCurrentTenancy` returns `null` for, and the same one the page already renders
as *"הדירה פנויה"*.

### Multipart, and why it is a dependency

`@fastify/multipart`. The form is plain HTML with `enctype="multipart/form-data"` and no
JavaScript, which keeps the property the admin shell states about itself: nothing on these
pages depends on JavaScript. `app.ts` declined `@fastify/formbody` because the urlencoded
parser it replaces is ten lines; multipart is not ten lines, and it is a security-sensitive
parse of attacker-shaped input.

### `GET /admin/documents/:documentId`

Serves the bytes back with `content-disposition: inline`, `no-store` and `nosniff`, the same
headers every authenticated page carries. The document id is the only thing in the URL, and
it names no person.

## Ingesting a document (slice 12.1)

The button that turns a stored lease into clauses, and a screen to read what came out. It
adds no new access rule either, for the third time: the ingest POST is `mutate`, so a viewer
is refused by the same guard, and the chunks page is `read` **and audited** — the chunks are
the lease's own words, so opening them is the same privacy event as opening the PDF and
leaves the same kind of row.

Both routes hang off the unit:

```
POST /admin/units/:unitId/documents/:documentId/ingest
GET  /admin/units/:unitId/documents/:documentId/chunks
```

and both **check server-side that the document belongs to that unit's current tenancy**,
answering `not_found` when it does not. That is 11.2's rule read from the other direction:
there, the tenancy a document is filed under is resolved from the unit rather than accepted
from the browser; here, a document reached *through* a unit has to actually be that unit's.
A pair of ids in a URL is a caller-supplied claim, and the check is what makes it a fact.

### Why a button and not a step of the upload

The lease this system reads was already in the bucket before ingestion existed, so a path
that ingests an *existing* document was needed regardless. Doing it on upload as well would
hold the browser open for the length of a 38-page extraction, for no gain the operator can
see. Ingestion on attach wants the kernel's durable work and is its own slice
(`SPEC-occupancy.md`, "Not triggered by upload").

The consequence is stated rather than hidden: **a document sits un-ingested until someone
presses the button**, and the unit page says which documents have been read and which have
not, because "no clauses" and "not read yet" are different facts.

### What the result page shows

Clause reference, pages, and the text — in reading order, one card per chunk. It is a
verification surface first: the slice's acceptance bar is that a human can spot-read chunks
against the PDF, and this is where that is done. It is deliberately plain.

It also shows **the pages that carried no text layer**, named, and when the document was last
read. That is the honest half of week 3's OCR cut line: a lease with four image-only pages is
four pages incomplete, and an operator reading an answer from it should be able to know that.

Those facts are read from the document row rather than from the ingest response. The first cut
of this slice took them from the response, which the redirect discarded — the screen could
state them for the length of one request and never again.

The unit page's read/unread state comes from `ingested_at` for the same reason. "Has chunks"
is a different question: a document that was read and produced nothing would otherwise be
indistinguishable from one nobody has opened.

### Asking the lease a question (slice 12.2)

A search field on the chunks page, `GET` with the question in `?q=`. It adds no access rule
either: it rides inside `getDocumentChunks`, which is already `read` and already audited, so
asking a lease a question leaves the same row as opening it.

`GET` rather than `POST` on purpose — a search is a link that can be reloaded and shared, and
nothing on the page needs JavaScript, which is the property the admin shell states about itself.

**The tenancy is never in the form.** It is resolved server-side from the unit the operator
opened, so editing the URL cannot point the search at another tenancy's lease: the pair of ids in
the path is already checked to belong together, and a mismatched pair is `not_found` rather than a
search of one tenancy displayed under another's heading.

It shows the clause reference, the pages and the distance — not an answer. Turning hits into a
Hebrew sentence with a citation is week 4's agent; this surface exists so a human can verify that
the right clause came back, which is the whole of slice 12.2's bar.

## The views (slice 10.1)

ROADMAP week 2's last bar: *the pilot building is browsable on staging*. `נכסים` and `אנשים`
stop being empty states and render what the modules hold.

### Server-rendered, with real URLs

5.1's shell switched panels in the browser: seven `<section>`s in one file, one visible.
That cannot be what 10.1 ships — a page whose content depends on which button was clicked
last has no address, so it cannot be linked, bookmarked, reloaded, or opened from a phone.
Each destination gets a URL and the server renders it:

| route | what it renders |
|---|---|
| `GET /admin/properties` | every building; create form |
| `POST /admin/properties` | `addBuilding` |
| `GET /admin/properties/:buildingId` | the building and its units; create form |
| `POST /admin/properties/:buildingId/units` | `addUnit` |
| `GET /admin/units/:unitId` | the unit, its assets, its current tenancy, the people in it |
| `GET /admin/people` | a phone lookup; no roster |
| `POST /admin/people` | `addPerson` |
| `GET /admin/people/:personId` | the person, their numbers, their tenancies |

`ui/index.html` stays the one shell file and gains a marker the routes fill — the same
substitution `loginPages()` already does on the login page's error paragraph, so there is
still no template engine and no bundler (SPEC.md rule 6). Nav items become links carrying
`aria-current` from the server; the only script left is the mobile drawer toggle.

### `אנשים` is a lookup, not a roster

There is no "list every person" read, and 10.1 deliberately does not add one. A screen whose
entire content is the personal data of every tenant Dona Dom has, unscoped and unpaginated, is
a liability the office does not need: people are reached **through the property** — building →
unit → the parties on its tenancy — plus a phone box over `resolveByPhone`, which is how a
caller is actually identified at a desk. `identity` grew `getPeople(ids)` and `listPhones`
for this, and no list-all.

### The guarded read surface (`internal/queries.ts`)

Reads sit beside the mutations of `internal/commands.ts` — same deps, same `(input, session)`,
same `requireCapability` — in their own file, because the audit rule differs. Every one checks
`read`, which is the capability that until now had the matrix's only unexercised row.

**Detail reads are audited; list reads are not.**

| read | audited |
|---|---|
| `listBuildings` · `getBuilding` · `resolveByPhone` | — |
| `getUnitDetail` · `getPersonDetail` | ✔ |

The rule 9.1 wrote is that every staff *action* leaves a record, and the honest reading of
that for reads is not "every page load". A row per nav click makes `audit_log` mostly
navigation, and the week-2 demo — *show me these two sessions* — gets harder to read, not
easier. What a privacy request actually asks is **who opened this tenant's record**, and that
is the detail view: the screen where a name, a phone number and a unit are on one page. So the
detail reads go through `audit.around` exactly as the mutations do, guard inside, so a refused
read leaves an `error` row rather than none.

**The read guard has no failing role today, and that is stated rather than glossed.** All
three roles hold `read`, so `requireCapability(role, 'read')` on these five reads cannot
currently refuse anyone — there is no reachable `not_allowed` on a view to test end to end.
The check is there so that the day a fourth role arrives, the views are already asking the
matrix instead of being opened by default. `internal/queries.test.ts` pins the whole grid so
the fact stays visible; `commands.ts`'s `mutate` guard is the one with a live refusal, and
9.1's test proves it.

`inputs` carries the **subject id only** — never the name or the phone that was on the screen.
Same reasoning as the mutation rows: the log says who looked at what, and copying the personal
data into it would make the trail a second store of the thing it is protecting.

### The viewer, proven twice

A viewer holds `read`, so every view above renders for them. What they must not have is the
create forms, and the two halves of that are not the same claim:

- **The gate** is `requireCapability(role, 'mutate')` on the POST, reached through
  `internal/commands.ts`. A viewer POSTing directly gets `not_allowed`, and the test proves it
  by POSTing rather than by looking at the page.
- **The hiding** is cosmetic and says so in the code. The form is not rendered for a viewer
  because showing a control that always fails is bad manners, not because it protects anything.
  9.1's rule holds: a hidden button is not a permission check.

A refused POST re-renders its page with the refusal in Hebrew — never a stack trace, and never
the raw error text (SPEC.md: one error shape, never leak internals).

### Escaping

Every value interpolated into these pages goes through the kernel's ``h`` tagged template
(`SPEC-kernel.md`, "Escaping data into HTML"). This module is the first thing in the system to
put database text into markup, and `ui/routes.ts` previously held it as a property that it
never did.

### Not here either

- **CSRF tokens.** The session cookie is `SameSite=Lax`, which is what stops a cross-site form
  POST from carrying it, so the create forms are not open. A token is still the belt to that
  suspenders and stays deferred to week 6 alongside login CSRF, above.
- **No edit and no delete.** Every view is list-and-create. Correcting a misspelled building is
  still a manual database task — `portfolio` and `identity` both say so, and 10.1 does not
  change it.
- **No search, no pagination, no sorting controls.** The pilot is one building.
