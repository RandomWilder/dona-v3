# Evidence — Slice 11.2: lease upload → GCS, attached to an occupancy

Captured 2026-08-25, the second slice of day 11. Staging serves `bfec0bb`.

## The bar, and how it was met

*"A real lease uploads from the admin and comes back down attached to the right
tenancy."* It did — the real signed lease, 1,695,258 bytes of it, uploaded by the
owner in a browser because the upload needs the admin password and that was never
shared.

```
row      01a0391c-22c5-7b10-b173-c10421e07d20 · lease · application/pdf · 1695258 bytes
path     leases/bldg-01a038fe-…/unit-01a038fe-…/tenancy-01a038fe-…/lease-01a0391c-….pdf
readback 1695258 bytes · starts "%PDF-1.7" · matches row: true
parties  0
```

**The path names no person.** It names no street either: four ids and the word
`lease`. That is the second half of the verify step, and it is true by
construction rather than by inspection — `documentPath` throws on anything that
is not a uuid, and a test aims a building's *name* at it to prove the throw.

## What only this upload could prove

Two things the test suite cannot reach, both now shown:

- **`app-staging` can write.** The `objectCreator` grant slice 7.0 deferred
  "until the slice that needs it" is live; the object exists because the deployed
  service put it there, under its own identity and not a human's.
- **The store is the bucket, not memory.** The boot line says so, which is the
  whole reason it says anything:

```
dona-v3 bfec0bb listening on 0.0.0.0:8080 — staff seed: already exists · viewer seed: already exists · docs: gs://dona-v3-staging-docs
```

## The real lease's own address, and no one who lives there

The lease is for בית שמש, הרב קוק 48, unit 24 — an address staging's mock data
does not contain. Rather than hang a real contract off a mock flat in תל אביב,
which would have made slice 13.1's extracted fields visibly disagree with the
tenancy carrying them, the **place** was seeded and the **people** were not:

| | |
|---|---|
| building | הרב קוק 204 · בית שמש, הרב קוק 48 |
| unit | 24 |
| tenancy | from 2025-08-15, open-ended |
| parties | **0** |

Open-ended is honest rather than lazy: the term is an initial period plus two
options capped at ten years (`SPEC-occupancy.md`), and extracting it is 13.1's
job. A single `ends_on` invented today would be a fact nobody read.

So the one real contract in the system is attached to a tenancy that matches its
contents, and **no real person entered the database**. The names, ID numbers and
signatures stay inside the PDF, where they already were.

## The audit trail

```
staff.attachDocument      ok  role=admin  inputs={"capability":"mutate"}
occupancy.attachDocument  ok  role=-      inputs={"kind":"lease","tenancyId":"01a038fe-…","contentType":"application/pdf"}
```

Two rows for one action, the shape 9.1 chose deliberately: the edge row records
*who was allowed and why*, the module row records *what changed*. Neither carries
a filename — the name the browser sent was dropped on arrival — and the only id
in either is a tenancy's, which names a place.

## Gate

```
npm run typecheck   -> clean
npm run lint        -> 89 files, no fixes applied
REQUIRE_POSTGRES=1 npm test -> 308 pass, 0 fail, 0 skipped   (303 -> 308)
npm run evals       -> 3/3
```

Covered by test rather than by staging: the round trip through the HTTP edge · a
viewer refused, with the refusal on the audit record · a vacant flat refused · a
non-PDF and an empty file refused · one tenancy's documents staying out of
another's list · a row whose object has gone reporting `not_found` rather than
serving an empty file · the whole object name percent-encoded, slashes included,
so a path segment cannot address a different object.

## Decisions worth re-reading later

**The path convention changed, and 7.0's is grandfathered.** The hand-uploaded
object still sits at `leases/bet-shemesh/harav-kook-48/bldg-204/unit-24/…` and was
left there — moving it would break nothing and prove nothing. New objects key on
ids, because generating the readable shape means transliterating Hebrew in code,
and two streets that transliterate alike file one flat's lease under another's.
The database row is the index now.

**Object first, row second.** An orphan object in a versioned bucket is
invisible and recoverable; a row whose object is missing is a lease the admin
lists and cannot open. A contract test asserts the ordering by failing the store
and finding no row.

**11.1's classification test earned its keep in the next slice.** It failed the
moment `occupancy_documents` existed and stayed failing until the table was
classified. `occupancy_documents` is domain data and is truncated with the rest —
so a reset now **orphans its objects on purpose**, deleting being the one
operation this system has no path for until week 6.

## Still open after this slice

- **Nothing reads a document but a staff session.** Tenant-scoped retrieval is
  12.2, and `tenancyAccess` is still the value that will scope it.
- **A document cannot be removed, corrected or replaced.** Uploading again adds a
  second document rather than a version, which is the honest behaviour for a
  correction and not a substitute for an edit path.
- **The real lease's removal is still owed at phase-1 sign-off**, from both
  buckets — and now from `occupancy_documents` too, which is a row a deletion
  path will have to know about. `tasks/fuses.md` holds the deadline.
