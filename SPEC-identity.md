# SPEC: identity

Conventions inherited from SPEC.md. The first domain module: it owns people, the phone
numbers that reach them, and what kind of person each one is.

- **Responsibility:** People, phone numbers, person-kinds (tenant, vendor, staff)
- **Depends on:** — (nothing; kernel only)
- **Commands:** `addPerson` · `addPhone` · `findByPhone`
- **Events:** none yet — nothing downstream reacts to a person being created

## Why this module is load-bearing (slice 6.1)

Week 2's sentence is `phone → person → unit → current occupancy`. This module is its
first two words. The tenant mapping table arriving from Dona Dom carries `050-…`,
`+9725…` and `9725…` in the same column, and the channel adapter will hand over
whatever WhatsApp reports. If two spellings of one number become two people, the
importer silently duplicates tenants and `occupancy.resolveByPhone` answers with the
wrong unit — the tenant-isolation failure SPEC.md forbids, arriving through the front
door rather than through an attack.

So the invariant is enforced by Postgres, not by care: **`identity_phones.phone` is the
primary key.** One number belongs to exactly one person, system-wide.

## Tables

Migration `0004_identity.sql`. The kernel runs it and never reads it (SPEC-kernel.md,
"module-owned tables").

| Table | Holds |
|---|---|
| `identity_people` | `id`, `display_name` (pii), `language`, `created_at` |
| `identity_phones` | `phone` (pii, E.164, **primary key**), `person_id`, `created_at` |
| `identity_person_kinds` | `(person_id, kind)` — a person may hold more than one |

`kind` is one of `tenant` · `vendor` · `staff`, enforced by a CHECK constraint. A person
can be several at once: the plumber who rents an apartment is a `vendor` and a `tenant`,
one person, one phone.

**The `staff` kind is not a login.** It classifies a human being; `staff_operators`
(SPEC-staff.md) is an admin-panel credential. Nothing joins them, and nothing should:
identity owns people, the staff module owns the way into the admin panel.

`language` is `he` or `en`, defaulting to `he`. ROADMAP week 6 assumes
"per-person language field already in identity"; the column costs nothing now and costs a
migration against real tenant data later.

`created_at` carries **no `DEFAULT now()`**. SPEC-kernel.md decision 3 puts time in SQL
under the injected clock; a column default is a second source of truth that no test can
see. Every insert passes `clock.now()` explicitly. (`0003_staff_auth.sql` carries defaults
it never uses — harmless, not retrofitted here.)

## Phone normalisation

Its own unit (`internal/phone.ts`), pure: no clock, no pool, no database. Stored form is
always E.164.

Separators are removed first — spaces, hyphens, parentheses, dots, and the Unicode
bidi control characters a Hebrew form can paste in (`U+200E`–`U+200F`, `U+202A`–`U+202E`).
A leading
`00` becomes `+`. Then:

| Input shape | Rule |
|---|---|
| `+…` | Accepted as E.164 if 8–15 digits follow |
| `972…` | Becomes `+972…`, then the Israeli check |
| `0…` | Leading `0` dropped, `+972` prefixed, then the Israeli check |
| anything else | `invalid` — a bare number with no `0` and no country code is ambiguous |

**The Israeli check** runs on the national number (what follows `+972`):

- first digit `5` or `7` (mobile, VoIP) → 9 digits
- first digit `2`, `3`, `4`, `8`, `9` (landline) → 8 digits
- anything else — `1…` service numbers, `0…`, wrong lengths → `invalid`

Worked examples, all of which are tests:

```
050-123-4567      → +972501234567
+972 50 123 4567  → +972501234567
972501234567      → +972501234567
0501234567        → +972501234567
03-1234567        → +97231234567
00972501234567    → +972501234567
+44 20 7946 0958  → +442079460958   (international, explicit)
0501234           → invalid          (too short for an Israeli mobile)
501234567         → invalid          (no leading 0, no country code)
1800123456        → invalid          (service number, not a person)
```

**Israeli by default, international when explicit.** A tenant never types a country code;
a foreign vendor or an overseas owner is still storable. The ambiguous middle — a bare
national number with no `0` — is refused rather than guessed.

## Commands

All three go through `contract.ts`; nothing outside the module touches `internal/`.

### `addPerson({ intentKey, displayName, kinds, language? }, actor) → Person`

Creates a person with at least one kind. Validated at the edge: `intentKey` non-empty,
`displayName` trimmed to 1–200 characters, `kinds` non-empty and drawn from the fixed set
(duplicates collapsed), `language` one of `he` / `en`.

Idempotent through the kernel's `once(key, work)` on `identity.addPerson:<intentKey>`.
A person has **no natural business key** — two tenants can share a name, and a person may
exist before any phone is known — so the caller names the intent. The importer's intent
key is its source row; the agent's is the case it is acting for. A second call with the
same key returns the first result rather than a second person.

### `addPhone({ personId, phone }, actor) → { personId, phone }`

Attaches a normalised number to an existing person. Unknown `personId` → `not_found`;
unnormalisable input → `invalid`.

Idempotent **on the unique index**, not on a kernel key: this command's intent *is* its
data. `INSERT … ON CONFLICT (phone) DO NOTHING` and then read the owner — same person
means the caller is repeating themselves and gets the first result; a different person
means two tenancies are claiming one number and gets `conflict`. Where the schema already
states the intent, a kernel key would only add a second, weaker copy of the same rule.

### `findByPhone(phone) → Person | null`

Normalises, then resolves phone → person with kinds attached. **A miss returns `null`, not
`not_found`:** "nobody has this number" is an answer, and the five error codes are for
failures. This follows `staff.findByEmail`. The caller decides what an unknown number
means — for the channel adapter in week 4 it means "offer a callback, disclose nothing".

## Audited

Both mutations are wrapped in the kernel's `audit.around`, so an audit row is written
whether the command succeeds or throws: `identity.addPerson` and `identity.addPhone`,
with the caller's `actor` (`tenant` / `staff` / `agent` / `system`) and the inputs.

Edge validation runs **inside** the audited work, so a command rejected as `invalid`
leaves an `error` row rather than disappearing before the trail starts.

`addPerson`'s `subject_id` is the **intent key**, not the new person id: it is known before
the work runs and stays the same across a replay, where a freshly-minted id would name a
person who was never created. `addPhone`'s subject is the `personId`.

Phone numbers and names reach `audit_log` deliberately — it is a table, not a log
(SPEC-kernel.md). SPEC.md's "PII never in logs" governs stdout, and nothing here prints.

## Not yet in place

- **Reads are not audited.** `findByPhone` writes nothing. Its callers — agent tools, the
  admin people view — audit their own use, and a PII-read trail is a week-6 concern.
- **No merge or split of people**, and no way to remove a phone or a kind. Everything here
  is additive; correcting a mistaken import is a manual database task until an admin
  screen owns it (week 2 day 10 lists, week 6 for edits).
- **No contact preferences** (preferred channel, quiet hours) — those are policy data and
  land with the channel work in week 4.
- **No `normalizePhone` on the public contract.** It stays internal until a caller outside
  the module needs it; the day-8 importer is the likely first.
