# Evidence — Slice 10.2: week 2 checkpoint

Captured 2026-08-25. GitHub Actions runs age out of the UI; this is the durable record.

## What was actually missing

The week-2 demo is *"log in as viewer and as admin — different powers."* Every mechanism
behind it had been tested since 9.1. **The viewer had not.** `SPEC-staff.md` recorded the gap
the day it appeared: the seeder creates but never updates, there is no operator-management
screen, and `administer` is named in the matrix with no command behind it — so a second
operator was a manual `INSERT` and the demo had one actor.

Asaf had already created `staging-staff-viewer-email` / `staging-staff-viewer-password` and
bound `app-staging` to read them, and logging in still failed. That is correct and worth
writing down: **a Secret Manager value is a stored string, not an account.** Nothing read them.

## The design decision

**Two entry points over one internal function — not a role parameter with a default.**

9.1 rejected a `STAFF_SEED_ROLE` because an environment value that could say `viewer` is a way
to deploy a system nobody can administer. A *defaulted* argument has the same defect pointing
the other way: it fails **open** to admin when a caller forgets. So `seedStaffOperator` and
`seedStaffViewer` each name their own role as a literal, and changing who is seeded costs a
deploy and leaves a diff.

They are also separate at the contract seam rather than one call with a flag, because they
differ in what a missing configuration *means*:

| | missing entirely | half set |
|---|---|---|
| admin | **throws** — a system with no way in | throws |
| viewer | silent no-op — one less demo account | throws |

The error message now names the pair that is actually half-set instead of always saying
`STAFF_SEED_*`.

## Verification

```
npm run typecheck   -> clean
npm run lint        -> 80 files, no fixes applied
REQUIRE_POSTGRES=1 npm test -> 283 pass, 0 fail, 0 skipped   (279 -> 283)
npm run evals       -> 3/3
```

- **The four existing seed tests are unedited.** That is the proof the refactor changed nothing.
- **The bar was checked by breaking it:** seed the viewer as `admin` instead and two tests fail,
  including the one that reads the role back out of a *real login* rather than out of the insert.
- **`bootstrap.sh` re-ran clean on staging**, where the two secrets already existed by hand:
  both reported `exists` and were left untouched — which is the property that let a
  hand-created value survive the house rule catching up with it.

**Staging's boot line**, the machine-checkable half of the demo:

```
dona-v3 4b09340 listening on 0.0.0.0:8080 — staff seed: already exists · viewer seed: created
```

## The demo, run by the owner

Not self-certified, and it could not have been: it needs both passwords, which are Asaf's and
were deliberately never shared. In a browser on staging —

- `nelly` (viewer): reached every screen, and saw **no create form**, for people or buildings.
- `asaf` (admin): the same screens with the forms, and creating worked.

Different powers, same URLs, decided server-side. That is the week-2 bar.

## The ordering this created

`--set-secrets` naming a secret that does not exist makes the deploy **fail**. The prod viewer
secrets did not exist when the code merged, so tagging would have failed the release —
`release.yml` deploys prod and already referenced them. Sequence held deliberately:

1. merge → staging deploys and seeds the viewer
2. owner runs the demo on staging
3. `./infra/bootstrap.sh prod` creates the prod pair idempotently
4. owner overwrites the generated prod password (version 2)
5. tag `v0.2.0`

Step 4 has a deadline that outlives this slice: **the seeder creates but never updates**, so a
password version added after prod's first seeding boot has no effect until week 6's rotation
flow exists.

## Week 2 closed — three of four, honestly

ROADMAP week 2's importer bar reads *"real pilot slice imported; 5 spot-checks pass."* Dona Dom's
table has not arrived (`tasks/fuses.md` fuse 3, requested 2026-08-22). The importer is built,
tested, and validated end to end against a specimen written for the purpose
(`docs/reference/tenant-table-template.csv`): 24 rows applied, re-run a no-op, eight
`resolveByPhone` spot-checks correct. **None of that is the bar.** The bar says *real*, and
ticking it on mock data is precisely PIPELINE.md §9's "trusting the demo".

Decided with Asaf rather than assumed: the box carries to week 3 day 1, tied to the fuse.

## Still open after this slice

- **`administer` has no command, and there is no operator-management screen.** The viewer
  arrived by a seeder, which is a different thing. A third operator, or changing anyone's role,
  is still a manual database task.
- **Staging carries test residue** — ~1,291 buildings, ~1,000 people. Harmless for browsing and
  wrong ground for a real import: validating the specimen against a *dirty* database returned
  the wrong people for three of five lookups, because the importer keys a person by phone and
  those numbers were already held. Week 3 day 1 decides it before the real file lands.
