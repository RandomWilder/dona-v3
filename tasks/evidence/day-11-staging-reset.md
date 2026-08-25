# Evidence — Slice 11.1: reset staging and seed it from the template

Captured 2026-08-25, the first slice of week 3.

## The carried premise was wrong, and measuring it was the slice

Week 2 closed carrying this, in `todo.md` and in `day-10-week-2-close.md` both:

> Staging carries test residue — ~1,291 buildings, ~1,000 people.

**Staging held one person and no buildings.** Measured before anything was
written, by the dry run:

```
would remove:  identity_people 1 · identity_phones 1 · identity_person_kinds 1 · idempotency_keys 1
would keep:    staff_operators 2 · staff_sessions 2 · audit_log 27 · schema_migrations 8
```

The right-hand column is what proves the connection was staging's and not
something else: two operators (`asaf`, `nelly`) and 27 audit records are exactly
the week-2 demo.

Where the residue actually lives: **the laptop, and CI's service container.** CI
runs against `postgres://dona:dona@127.0.0.1:5432/dona`
(`.github/workflows/ci.yml:41`) — a container that dies with the job. Nothing
outside the app has ever reached staging's database; establishing that path was
this slice's own third bullet. The local database, meanwhile, held **2,843
people and 2,721 buildings** when the same dry run was pointed at it.

So the hazard was real and its address was wrong. The lookups that returned the
wrong people during 8.1 were local lookups. Nothing about the fix changes; the
reason written into the code and the runbook does.

## What the reset does

`infra/reset-staging-data.sh` → `npm run reset` → `src/reset/contract.ts`.

Emptied: the three domain modules' tables **plus `idempotency_keys`**. That last
one is the finding worth keeping. Every key in the store memoizes a domain
command — `identity.addPerson:import:person:+9725…` — so truncating people while
keeping the memo hands the next import the id of a person who no longer exists.
Not an error: a broken graph that looks like a successful re-seed. Staff auth
does not use the store, so nothing else is affected.

Preserved: `staff_operators`, `staff_sessions`, `staff_login_attempts`,
`audit_log`, `outbox`, `scheduled_work`, `schema_migrations`. The logins are in
use and the audit trail is evidence. The counts are taken before and after and
compared — a preserved table that moves raises rather than passes.

Two properties chosen deliberately:

- **No `CASCADE`.** A future table referencing a domain table, and missing from
  the list, makes this fail loudly. `CASCADE` would instead reach through into
  the tables we promised not to touch.
- **Staging only, with no flag that changes it.** The script reads the
  connection name out of the secret and refuses unless it is
  `dona-v3:me-west1:dona-staging`, before opening a tunnel to anything.
  `assertNotProduction` is the second layer, for the case where someone exports
  a socket URL by hand.

## Verification

Local rehearsal first, on the disposable database — which, being genuinely
dirty, is the only place the destructive path could be proved at scale:

```
removed: identity_people 2843 · identity_phones 2150 · identity_person_kinds 2910 ·
         portfolio_buildings 2721 · portfolio_units 2464 · portfolio_assets 386 ·
         occupancy_tenancies 1693 · occupancy_parties 1901 · idempotency_keys 3323
kept:    staff_operators 1456 · staff_sessions 732 · staff_login_attempts 150 ·
         audit_log 23967 · outbox 192 · scheduled_work 576 · schema_migrations 8
seeded 24 of 24 rows · rejected 0
```

Then staging:

```
removed: identity_people 1 · identity_phones 1 · identity_person_kinds 1 · idempotency_keys 1
kept:    staff_operators 2 · staff_sessions 2 · audit_log 27 · schema_migrations 8
seeded 24 of 24 rows · rejected 0
```

Staging now reads `buildings 3 · units 10 · people 13 · tenancies 10` — the
template exactly. Seven `resolveByPhone` spot-checks against the CSV, two more
than the bar asked for:

| phone (as written in the CSV) | resolved | tenancies |
|---|---|---|
| `050-123-4567` | דנה כהן | tenant + billed, resident |
| `0521234567` | יעל כהן | tenant, resident |
| `+972541234567` | אבי מזרחי | tenant + billed, resident |
| `053-765-4321` | רות לוי | tenant + billed, resident |
| `+972529991234` | משה פרידמן | **two** — tenant+billed resident, and guarantor with `party` access |
| `054-663-9182` | דוד גולן | guarantor, `party` access |
| `058-610-2030` | אורי שמש | tenant, resident |

The fifth row is the one that matters: one person, two tenancies, two different
levels of access, resolved from a spelling that is not the one in the file.

Gate, before and after:

```
npm run typecheck   -> clean
npm run lint        -> 83 files, no fixes applied
REQUIRE_POSTGRES=1 npm test -> 287 pass, 0 fail, 0 skipped   (283 -> 287)
npm run evals       -> 3/3
```

## The browse, run by the owner

Confirmed after the merge, on staging serving `1f01462`. Not self-certified, and
it could not have been: it needs the admin password, which is Asaf's and was
deliberately never shared — the same constraint as the week-2 demo.

`נכסים` reads **3 בניינים**, and they are the template's:

| on screen | address | CSV |
|---|---|---|
| גני אלון | הנשיא 8, חיפה | ✓ |
| בית שקד | ביאליק 12א, רמת גן | ✓ |
| מעונות הדר | ארלוזורוב 45, תל אביב | ✓ |

Nothing else is listed — the residue question answered on the screen rather than
in a count. Opening בית שקד gives **3 דירות**: flats 2, 5 and 8 on floors 1, 2
and 4, exactly what the CSV holds for that address — including `12א` surviving
as a house number that is text rather than a number.

## What is still not proved here

**The truncate is not covered by a test that executes it.** `node --test` runs
files in parallel against one database, so a test that emptied `identity_people`
would break the identity, occupancy and import suites mid-run. What is tested is
the part that would fail silently instead: every table in the database is on
exactly one of the two lists, read-only, so migration 0009 cannot add a table
that nobody classified.

## Two notes for the machine, not the plan

Neither is a dona-v3 problem; both cost time and will recur on a new machine.

- `gcloud components install cloud-sql-proxy` finishes, then the SDK offers to
  install its own bundled Python 3.13 and asks for a sudo password. Unrelated;
  the component is already installed by that point. Cancel it.
- The proxy authenticates with **Application Default Credentials**, which are
  separate from the accounts in `gcloud auth list`. An expired ADC session fails
  as `invalid_grant · invalid_rapt`, which reads like a permissions problem and
  is not. `gcloud auth application-default login` fixes it.

Both are in `docs/runbook-deploy.md` now.
