# SPEC: occupancy

Conventions inherited from SPEC.md. The join module: it is the only place in the system
where a person and a place meet.

- **Responsibility:** Current tenancy — who lives where, who is billed, who guaranteed it;
  lease documents indexed per occupancy (week 3)
- **Depends on:** identity, portfolio — through their `contract.ts` only
- **Commands:** `openTenancy` · `addParty` · `endTenancy` · `getTenancy` · `resolveByPhone`
- **Events:** none yet — nothing downstream reacts to a tenancy opening

## Why this module is load-bearing (slice 7.1)

Week 2's sentence is `phone → person → unit → current occupancy`. `identity` is its first
two words and `portfolio` its third; this module is the last one, and the arrows between
them. Nothing else in the system knows that a person and a unit are related.

That makes it the seam SPEC.md's **"absolute tenant isolation enforced at the query layer"**
hangs on. Every read in weeks 3–5 — the lease a tenant may ask about, the case they may
open, the history they may see — is scoped by what `resolveByPhone` returns. A wrong answer
here is not a bug in one screen; it is one tenant reading another's tenancy, which is the
failure SPEC.md forbids, arriving through the front door rather than through an attack.

So this module got its isolation tests before it got features.

## Tables

Migration `0006_occupancy.sql`. The kernel runs it and never reads it (SPEC-kernel.md,
"module-owned tables"). `created_at` carries no `DEFAULT now()` anywhere, as in `0004` and
`0005`: time in SQL comes from the injected clock.

| Table | Holds |
|---|---|
| `occupancy_tenancies` | `id`, `unit_id`, `starts_on`, `ends_on`, `parking_spot`, `storage_unit`, `created_at` |
| `occupancy_parties` | `(tenancy_id, person_id, role)` — a person may hold more than one role |

### The foreign keys cross module lines, deliberately

`occupancy_tenancies.unit_id` references `portfolio_units`, and
`occupancy_parties.person_id` references `identity_people`. AGENTS.md's boundary rule
governs *code* imports — no module reaches past another's `contract.ts`, and this one does
not. SPEC.md's module map already declares `occupancy` depends on both, so the direction is
legal and there is no cycle.

Referential integrity is then Postgres's job, by the same argument that made
`identity_phones.phone` a primary key rather than an indexed column: this is the one place
the join exists, and a dangling tenancy is exactly the kind of thing that must be impossible
rather than merely unlikely. `ON DELETE RESTRICT` throughout — a unit with a tenancy on it
cannot quietly vanish.

### The role is on the link, not on the person

The real Dona Dom lease (`docs/reference/lease-template-donadom.md`) has **three kinds of
party, not two**: two tenants jointly and severally, and a guarantor who signs the שטר חוב,
has his own phone number, and does not live there.

`role` is one of `tenant` · `billed` · `guarantor`, enforced by a CHECK constraint, and it
lives on the tenancy↔person link. Putting it on the person would make the guarantor a
`tenant` *system-wide* — and would leave nowhere to say that one man guarantees his
daughter's flat while renting his own. On the link, both facts fit, and `identity` needs no
change at all: it still only knows people, phones and person-kinds.

A person holds **one row per role**. Someone who lives there and also pays holds `tenant`
and `billed` — the same shape as `identity_person_kinds`, and for the same reason.

`billed` is not a synonym for `tenant`. A parent paying a student's rent is `billed` and
nothing else; they are a party to the tenancy who does not live in the flat, exactly as the
guarantor is.

### Parking and storage belong to the tenancy

Both are numbered in the lease, and the lease lets the landlord **reassign a bay**,
temporarily or permanently — EV-charger installation is named as a reason. A reassignment is
therefore a change to the *tenancy*, not to the building, which is why `parking_spot` and
`storage_unit` are nullable columns here and not on `portfolio_units`. Putting them on the
unit would make one tenant's reassignment rewrite the place itself.

## What "current" means

```
starts_on <= today AND (ends_on IS NULL OR ends_on >= today)
```

Inclusive at both ends: the day a tenancy starts, it is current; the day it ends, it is
still current.

**`today` is the injected clock rendered in `Asia/Jerusalem`**, not in UTC —
`($1::timestamptz AT TIME ZONE 'Asia/Jerusalem')::date`. Israel runs two or three hours
*ahead* of UTC, so the Israeli date advances first: at 00:30 in Tel Aviv it is still
yesterday in UTC. Comparing in UTC therefore lands every boundary up to three hours late,
in both directions:

- a tenancy beginning 1 October is not current for a tenant messaging at 00:30 on
  1 October — they are told they have no tenancy, on the morning they moved in;
- a tenancy that ended 30 September is still reported current at 01:00 on 1 October, which
  is the same mistake pointing at someone who has left.

The tenants are in Israel and the dates in the lease are Israeli dates. Two tests pin the
boundary with a `fixedClock` at `21:30Z` — 00:30 the next day in Tel Aviv — one on each
side, because each catches a UTC comparison failing in the opposite direction.

`ends_on IS NULL` is an open-ended tenancy. A non-null `ends_on` is **the end of the term
currently in force, not the lease's ultimate expiry** — the lease runs an initial period
plus two options capped at ten years overall, so exercising an option is an update to this
column rather than a contradiction of it. Week 3's digital twin models the term structure;
`resolveByPhone` only ever needs to know "is this current", which is why one date range is
enough here and would not be enough there.

## Idempotency: no intent keys

This module sides with `portfolio`, not `identity`. A tenancy has a **natural key** —
`UNIQUE (unit_id, starts_on)`, one tenancy of one unit beginning on one date — so
`openTenancy` is idempotent on the unique index and the kernel's `once()` is unused here.
`addParty` is idempotent on its primary key, as `identity`'s kinds are.

This is the property the day-8 importer rests on: re-running the same file cannot produce a
second tenancy, because the second insert collides with the first rather than relying on the
importer to remember.

`endTenancy` is the exception in shape, not in principle: setting the same end date twice is
the same tenancy, and setting a *different* one is a `conflict` rather than a silent
overwrite. A tenancy that ended on the wrong date is a correction, and a correction should
have to say so.

## Commands

All five go through `contract.ts`; nothing outside the module touches `internal/`.
`identity` and `portfolio` arrive as injected dependencies typed by their own contracts, so
the dependency is visible in the constructor rather than buried in a join.

### `openTenancy({ unitId, startsOn, endsOn?, parkingSpot?, storageUnit? }, actor) → Tenancy`

The unit's existence is checked through `portfolio.getUnit(unitId)`, which turns an unknown
unit into a `not_found` sentence rather than a foreign-key driver error. Dates are `YYYY-MM-DD`
strings, validated at the edge; `endsOn` before `startsOn` → `invalid`.

### `addParty({ tenancyId, personId, role }, actor) → Party`

Unknown tenancy or person → `not_found`; unknown role → `invalid`.

### `endTenancy({ tenancyId, endsOn }, actor) → Tenancy`

Unknown tenancy → `not_found`; `endsOn` before the tenancy's `startsOn` → `invalid`; a
different end date already recorded → `conflict`.

### `getTenancy(tenancyId) → TenancyView`

The tenancy, its parties with their roles, and the unit. An unknown id is `not_found`, not
`null` — an id must have been issued by something, so a miss is a dangling reference. This
follows `portfolio.getUnit` rather than `identity.findByPhone`.

### `resolveByPhone(phone) → OccupancyResolution | null`

The chain the agent calls on every conversation.

```
{
  person: Person,                  // from identity.findByPhone
  tenancies: [{
    tenancy: Tenancy,              // incl. parkingSpot / storageUnit
    roles: OccupancyRole[],        // this person's roles on this tenancy, sorted
    access: 'resident' | 'party',
    unit: UnitView,                // from portfolio.getUnit
  }]                               // current only, ordered by startsOn
}
```

- **`null` means nobody holds this number.** An answer, not a failure — the
  `identity.findByPhone` rule. The caller decides what an unknown number means; for the
  channel adapter in week 4 it means "offer a callback, disclose nothing".
- **`tenancies: []` means the person is known and lives nowhere.** A vendor, an owner, an
  ex-tenant. Distinct from `null`, and neither is an error.
- **A list, never a guess.** A person renting two flats is a fact, not a conflict, and
  picking "the most recent" would be the one shape that can silently answer about the wrong
  flat. Callers that require exactly one assert on the length and say so.
- **Access notes are never requested.** `getUnit` is called without `includeAccessNotes`, so
  an entry code cannot reach a resolution by accident. A caller who needs one asks
  `portfolio` for it, having first decided it is entitled to.

## Roles and access (`internal/roles.ts`)

Its own unit, pure: no clock, no pool, no database — as `identity`'s `phone.ts` and
`portfolio`'s `keys.ts` are.

`tenancyAccess(roles)` returns `resident` if the roles include `tenant`, and `party`
otherwise. That single value is what makes "a guarantor does not get a tenant's access" a
**seam rather than a convention**: it is computed once, from the link, and week 3's document
retrieval is scoped by it instead of re-deciding the question.

A guarantor is a `party`. So is a `billed` party who is not also a tenant. Being on the hook
for the money is not the same as living behind the door, and only the second earns the
entry code, the fault history, and the lease's contents.

Building this seam in 7.1 — with every party the lease will ever carry — is deliberate. The
alternative is reopening it in week 3, against real tenant data, with retrieval already
written on top of it.

## Audited

`openTenancy`, `addParty` and `endTenancy` are wrapped in the kernel's `audit.around`, so a
row is written whether the command succeeds or throws. Edge validation runs **inside** the
audited work, so a rejected command leaves an `error` row rather than no row.

`openTenancy` has no subject id — the tenancy it names may not exist yet, and on a repeat the
caller gets the existing tenancy, whose id is not the one this call would have minted. Its
unit id is in `inputs`. The other two take the `tenancyId` as their subject.

## Not yet in place

- **Overlapping tenancies on one unit are not prevented in general.** `UNIQUE (unit_id,
  starts_on)` stops the case that matters — a re-run import creating a second copy — but two
  tenancies with different start dates and overlapping ranges are still insertable. The
  schema-level fix is an exclusion constraint over a `daterange`, which needs the
  `btree_gist` extension; whether the Cloud SQL runtime user may `CREATE EXTENSION` is
  unverified, and finding out is its own slice rather than a guess inside this one.
- **Reads are not audited.** `resolveByPhone` and `getTenancy` write nothing. Their callers
  audit their own use, and a PII-read trail is a week-6 concern — the same position
  `identity` takes.
- **No lease documents.** Week 3 indexes them per occupancy; `tenancyAccess` is the value
  that will scope the retrieval.
- **No rent, no money, ever.** SPEC.md rule 7. The lease's rent is an index-linked formula
  against a named base month, which is the week-3 twin's problem and never this module's.
- **No "unconfirmed" party↔phone mapping.** The lease sample carries two tenants and two
  mobile numbers with nothing saying which is whose. An importer must be able to record that
  honestly rather than guess — guessing wrong inside a household is recoverable, guessing
  wrong across households is the isolation failure. That belongs in slice 8.1, where the real
  file is.
- **`validDate` / `optionalDate` are on the contract as of slice 8.1.** The importer must
  reject `2026-02-30` before it writes rather than after, and a second copy of the rule in
  the importer would drift from the one these commands enforce. Behaviour unchanged.
- **Nothing is removable.** No way to detach a party or delete a tenancy; corrections are a
  manual database task until an admin screen owns them.
