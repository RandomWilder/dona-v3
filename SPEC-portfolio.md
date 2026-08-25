# SPEC: portfolio

Conventions inherited from SPEC.md. The module of **places**: buildings, the units in
them, and the equipment that breaks.

- **Responsibility:** Buildings, units, assets in a unit or a building, access notes
- **Depends on:** — (nothing; kernel only, and deliberately not `identity`)
- **Commands:** `addBuilding` · `addUnit` · `addAsset` · `getUnit`
- **Events:** none yet — nothing downstream reacts to a place being recorded

## Places, not people (slice 6.2)

A unit does not know who lives in it. That join is `occupancy`'s and nothing else's,
which is why this module imports nothing: it can be populated from a property list
before a single tenant is known, and it stays correct when tenants change.

Two things make this more than storage:

**Duplicate places are the phone problem one level up.** The day-8 importer reads a
building's address off many rows. If `רחוב הרצל 12` and `רחוב הרצל  12` become two
buildings, the units split across the halves and every occupancy under one of them
resolves to the wrong place. So places get natural keys and unique indexes, exactly as
a phone number did in `identity`.

**Access notes are entry codes.** A real access note reads "code 4471, key in the meter
cupboard". It is operational data for whoever is being sent to the door, not something a
tenant-facing caller should ever receive by accident — so the read is fail-closed about
it (below).

## Tables

Migration `0005_portfolio.sql`. The kernel runs it and never reads it.

| Table | Holds |
|---|---|
| `portfolio_buildings` | `id`, `name`, `city` / `street` / `house_number`, `address_key` (normalised, **unique**), `access_notes`, `created_at` |
| `portfolio_units` | `id`, `building_id`, `label`, `label_key` (normalised), `floor`, `access_notes`, `created_at` — **unique on `(building_id, label_key)`** |
| `portfolio_assets` | `id`, `building_id`, `unit_id` (**nullable**), `kind`, `label`, `notes`, `created_at` |

`house_number` is `text`, not a number: `12א` is an address in Israel.

### An asset names its building always, and its unit optionally

`unit_id IS NULL` means a **building asset** — a lift, a gate, the intercom panel. A
boiler is apartment 3's; a lift is not, and forcing it under some arbitrary flat would
make week 5 dispatch a lift fault against whoever was parked underneath it.

The pairing is held by a composite foreign key rather than two independent ones:

```sql
FOREIGN KEY (unit_id, building_id) REFERENCES portfolio_units (id, building_id)
```

so an asset cannot name unit 3 of one building and the address of another. That is what
the otherwise-redundant `UNIQUE (id, building_id)` on `portfolio_units` exists for.

Uniqueness is `UNIQUE NULLS NOT DISTINCT (building_id, unit_id, kind, label)` — the
`NULLS NOT DISTINCT` clause (PostgreSQL 15+, and both sides run 16) is what makes the
building-asset rows collide with each other instead of silently duplicating, since their
`unit_id` is NULL.

`ON DELETE RESTRICT` throughout, where `identity` cascades. A person's phone numbers are
that person's and go with them; a building's units are not disposable with it. Nothing
deletes anything today, and refusal is the safe default to start from.

`created_at` carries **no `DEFAULT now()`**, as in `0004_identity.sql`: time in SQL comes
from the injected clock (SPEC-kernel.md decision 3), and a test asserts it.

## No intent keys — places have natural identity

`identity.addPerson` takes a caller-supplied `intentKey` because two tenants can share a
name and a person has no natural key. **A place does.** A building *is* its address; a
unit *is* its label within a building; an asset *is* its kind and label within its place.

So all three creates here are idempotent on a unique index, the way `addPhone` is, and
the kernel's `once()` is not used in this module at all. Calling `addBuilding` twice with
one address returns the same building — and, being a first-result-wins idempotency, the
second call's `name` is ignored rather than applied. Correcting a name is an edit, and
edits are not in this slice.

### Normalisation is naive on purpose

`address_key` is `city|street|house_number`, each `trim`med, internal whitespace
collapsed, lowercased. `label_key` is the same, plus: a label that is **all digits** has
leading zeros stripped, so `03` and `3` are one apartment.

Nothing here knows that `רח׳` and `רחוב` are the same word, and that is deliberate. Real
pilot addresses arrive on day 8; a normalisation rule invented before seeing them is a
guess, and a wrong guess **merges two real buildings** — which is far worse than leaving
two spellings apart for the importer to map deliberately. This paragraph is the note to
revisit once the data is in hand.

## Commands

### `addBuilding({ name, city, street, houseNumber, accessNotes? }, actor) → Building`

Idempotent on `address_key`. Every text field is trimmed and length-checked at the edge.

### `addUnit({ buildingId, label, floor?, accessNotes? }, actor) → Unit`

Idempotent on `(building_id, label_key)`. A `buildingId` that does not exist →
`not_found`; a `buildingId` that is not an id at all → `invalid`, checked before it can
reach Postgres as a cast error.

### `addAsset({ buildingId, unitId?, kind, label?, notes? }, actor) → Asset`

Idempotent on `(building_id, unit_id, kind, label)`. Omitting `unitId` records a building
asset. A `unitId` belonging to a **different** building is refused as `invalid` — checked
in code so the caller gets a sentence rather than a driver error, with the composite FK
underneath as the thing that makes it impossible rather than merely unlikely.

`kind` is one of: `boiler` · `solar_heater` · `air_conditioner` · `lift` · `intercom` ·
`gate` · `water_pump` · `electrical_panel` · `other`, with free-text `label` beside it for
what the office actually calls it. A fixed set rather than free text because an importer
that can write `boiler` can write `boilr`, and two spellings are two assets. When
`catalog` lands in week 5 this vocabulary becomes data rows and the CHECK constraint goes.

### `getUnit(unitId, options?) → UnitView`

The tree, in one query: the unit, its building, and the assets of both — each tagged
`scope: 'unit' | 'building'`, so a lift reaches whoever is looking at apartment 3 without
pretending to be its boiler.

**Access notes are opt-in.** `getUnit(id)` omits them; `getUnit(id, { includeAccessNotes:
true })` returns them for the unit and its building. A caller cannot leak an entry code by
forgetting to strip a field — it has to ask. Week 5's dispatch decides when a vendor
actually sees them.

**A miss is `not_found`, not `null`** — and the contrast with `identity.findByPhone` is
the rule for the whole codebase:

- a lookup by a **user-supplied key** (a phone number someone typed) returns `null`,
  because "nobody has this number" is a true answer about the world;
- a fetch by a **system id** returns `not_found`, because the id must have been issued by
  something, so a miss is a dangling reference and a bug somewhere.

### `listBuildings() → Building[]`

Every building, ordered city → street → house number, which is how someone looking for one
scans a list rather than by insertion time. Added in 10.1 because the properties view had no
way to learn an id: `getUnit` and `getBuilding` both take one, and until this existed nothing
could produce the first.

**Access notes are never returned here**, not even opt-in. `getUnit`'s rule is that a caller
must ask for an entry code; a list is exactly the shape where a field nobody asked for gets
swept into a page, a log, or a screenshot. Asking for one building's notes is a decision
about one building — there is no legitimate "give me every entry code in the portfolio", so
the option is not offered.

**No pagination, and it is not an oversight.** The pilot is one building; Dona Dom's whole
portfolio is a few dozen. A `LIMIT` with no cursor would be a silently truncated list, which
is worse than a long one. When the count justifies it, the ordering above is already the
stable sort a keyset cursor needs.

### `getBuilding(buildingId, options?) → BuildingView`

`{ building, units }` — the building and its units. The second half of the browse path:
`listBuildings` → `getBuilding` → `getUnit`.

**Units come back in natural order, which `label_key` alone does not give.** The first draft
of this section claimed the normaliser's leading-zero stripping was enough for `2` to sort
before `10`; the test disagreed, and the spec was wrong rather than the test — `label_key` is
text, and a plain sort lists a real staircase as 1, 10, 11, 2. So a purely numeric label sorts
as a number and everything else (`3א`, `קרקע`) sorts as text after it. This is presentation
order for one building's unit list and nothing depends on it beyond that.

Access notes are opt-in exactly as `getUnit`'s are, and the option covers **both** the
building and its units — one flag, because a caller who has asked for entry codes has asked.
A miss is `not_found`, by the system-id rule above.

## Audited

All three mutations go through `audit.around` with the caller's `actor`:
`portfolio.addBuilding` · `portfolio.addUnit` · `portfolio.addAsset`. Validation runs
**inside** the audited work, so a command rejected as `invalid` leaves an `error` row
rather than vanishing. A unit's and an asset's subject is the **parent building id** —
caller-supplied, so it is known before the work runs. `addBuilding` records **no subject**
and carries the address in `inputs` instead: its id is not known beforehand, and on a
repeat the caller receives the existing building, so a freshly minted id would name a row
that was never created.

All four reads — `getUnit`, `listBuildings`, `getBuilding`, and `findByPhone`'s counterpart
in `identity` — write nothing. This module audits changes, not glances. Who *looked* at a
place is a real question, and it is answered one layer up: `staff` audits the detail views
that put a unit and the people in it on a screen (`SPEC-staff.md`, slice 10.1). Recording it
here as well would double every row for no extra answer, and this module cannot see the
operator behind the read in any case.

Note still that an access-notes read is a disclosure, and when a vendor is first sent an
entry code (week 5) **that** is the moment that needs its own audit record.

## Not yet in place

- ~~**No listing.**~~ Closed in 10.1: `listBuildings` and `getBuilding` above, shaped by the
  properties view that needed them.
- **Still no search and no filter.** The list is the whole list. A city filter is trivial to
  add and nothing yet asks for it.
- **No edits and no deletes.** A misspelled building name is corrected by hand until an
  admin screen owns it. This is why first-result-wins idempotency is safe to ship.
- **No sub-areas** (rooms, parking bays, storage) and no geo coordinates. Neither is
  needed to answer "which boiler is broken".
- **Nothing about people.** No owner, no manager, no tenant — `occupancy` (7.1) joins
  places to people, and this module must not learn how.
