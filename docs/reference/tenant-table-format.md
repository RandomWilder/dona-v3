# The tenant mapping table — format

What the importer (`npm run import`) reads. `tenant-table-template.csv` beside this file is a
filled-in example that imports cleanly: 24 rows, 13 people, 3 buildings, 10 units, 10
tenancies. It is both the specimen to hand Dona Dom and the fixture we validate the chain
against before real records exist — sized so the slices after this one have something to work
with rather than a toy.

## The one rule that matters

**One row per person per role.** Not one row per flat.

A flat with two tenants where one of them also pays is **three** rows: the same tenancy
repeated, once per party-role. This is deliberate and comes from the real lease
(`lease-template-donadom.md`), which carries two tenants and two mobile numbers with nothing
saying which belongs to whom. A row that carries exactly one person and one phone leaves the
importer no room to guess — and guessing wrong across households is the isolation failure the
whole system is built to prevent.

## Columns

Required — the import aborts if any is missing from the header:

| column | meaning | notes |
|---|---|---|
| `building_name` | the building's name | |
| `city` | | |
| `street` | | |
| `house_number` | | text, not a number — `12א` is an address |
| `unit_label` | flat number or name | `3`, `10`, `קרקע` all fine |
| `starts_on` | start of the term in force | `YYYY-MM-DD` |
| `person_name` | | |
| `phone` | | any Israeli spelling — see below |
| `role` | `tenant` \| `billed` \| `guarantor` | exactly these three words, in English |

Optional — include the column if the data exists; leave the cell blank where it does not:

| column | meaning |
|---|---|
| `floor` | whole number; `0` is ground |
| `ends_on` | **blank means open-ended**, which is a real answer, not missing data |
| `parking_spot` | travels with the tenancy, not the flat |
| `storage_unit` | likewise |

## What the example covers

Deliberately, because each of these is a case that breaks importers or views:

| case | where |
|---|---|
| two tenants in one flat, one of whom also pays | `מעונות הדר` flat 3 — דנה (tenant+billed) and יעל (tenant) |
| **the payer does not live there and the resident does not pay** | `בית שקד` flat 2 — אורי is `tenant`, מיכל is `tenant`+`billed` |
| one person, two tenancies, two different roles | משה פרידמן — `guarantor` of flat 5, `tenant` of flat 8, written in **two different phone formats** to prove one person |
| a guarantor who lives nowhere in the portfolio | דוד גולן — `guarantor` only, `access: party` |
| an **ended** tenancy, so the flat reads as vacant | `מעונות הדר` flat 12 — ended 2026-06-30; יוסי resolves to *no current tenancy* |
| open-ended leases (blank `ends_on`) | flat 10, flat 8, `גני אלון` flat 4 |
| a non-numeric unit label | `קרקע` |
| a house number that is not a number | `12א` |
| ground floor as `0`, not blank | `קרקע`, `גני אלון` flat 1 |
| blank optional cells | several rows have no `parking_spot` or `storage_unit` |
| four spellings of an Israeli number | `050-123-4567`, `0521234567`, `+972541234567`, `053-765-4321` |

**One thing this format cannot express: a genuinely empty flat.** Every row is a party of a
tenancy, so a unit nobody has ever rented has no row and is never created. The vacancy in the
example is a flat whose lease *ended* — which is the only way to get one from this file, and
is also the more useful case.

## Phone numbers

Any Israeli spelling resolves to the same person: `050-123-4567`, `0501234567`,
`+972501234567`, `972501234567`. Non-Israeli numbers must be written with a leading `+`.

**The phone is how a person is identified.** Two rows with the same number are the same human
being — which is what lets one man guarantee his daughter's flat while renting his own, as
`משה פרידמן` does in the example (rows 10–12, written in two different formats on purpose).
The corollary: two different people must never share a number, and a wrong number merges two
real people.

## Roles

- `tenant` — lives there
- `billed` — is on the hook for the money
- `guarantor` — signed the שטר חוב and does **not** live there

A person who lives there *and* pays holds two rows, `tenant` and `billed`. The role is on the
link, never on the person: `guarantor` is true of one tenancy, not of a human being.

## What the importer does with a bad file

- **Dry run is the default.** `npm run import -- file.csv` reports what would land and writes
  nothing; `--commit` is required to write.
- **Bad rows are reported, not fatal.** Each comes back as `line / code / reason`, with the
  line number as the spreadsheet shows it. A good row between two bad ones still lands.
- **Only a structural fault aborts** — a ragged row, an unterminated quote, a missing required
  column — because after one of those the line numbers are meaningless.
- **Re-running is a no-op.** Every write underneath is idempotent on a natural key, so a second
  `--commit` of the same file changes nothing.

## Two things found while validating this file

Both are correct behaviour worth knowing before the real import:

1. **A future `starts_on` reads as no current tenancy.** The first draft of the example started
   flat 3 a week out, and `resolveByPhone` correctly returned an empty tenancy list — the
   tenant does not live there yet. Right answer, confusing demo; the dates were moved.
2. **Import into a clean database, or expect collisions.** Run against the local development
   database, three of the five spot-checks returned the *wrong people* — the phone numbers had
   already been claimed by people left behind by thousands of test runs, and keying a person by
   phone did exactly what it promises. The validation was redone on a fresh database, where all
   six people and all five tenancies came back exactly as written. **Staging carries the same
   residue**, so the real import wants a clean target or a deliberate cleanup first.

## Validated

`2026-08-25`, against a fresh database:

```
dry run   read 24 · would apply 24 · rejected 0
--commit  read 24 · applied 24 · rejected 0
--commit  (again) — counts unchanged: 13 people, 13 phones, 3 buildings,
                    10 units, 10 tenancies, 24 parties
```

Eight `resolveByPhone` spot-checks, all correct — including משה resolving from two phone
spellings to one person holding `access: resident` on his own flat and `access: party` on his
daughter's; מיכל paying for a flat אורי also lives in; and יוסי, whose lease ended, correctly
returning **no current tenancy**.
