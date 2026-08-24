# SPEC: import

Conventions inherited from SPEC.md. **Not a domain module** — a tool, as `staff` is an edge.
It owns no tables, defines no invariants, and every write goes through another module's
`contract.ts`.

- **Responsibility:** Loading the tenant mapping table from a CSV file
- **Depends on:** identity, portfolio, occupancy — through their contracts only
- **Commands:** `importTenants(text, deps, options) → ImportReport` · `parseCsv(text)`
- **Events:** none

## Why it holds no state

Everything it does is already idempotent one layer down: `portfolio` keys a building by its
address and a unit by its label, `occupancy` keys a tenancy by `(unit_id, starts_on)` and a
party by its primary key, and `identity` keys a person by the caller's intent. So
"re-running the file changes nothing" is a property of those modules rather than of a
ledger this tool would otherwise have to keep. It writes nothing of its own and could be
deleted without losing a fact.

## The input format is ours, not theirs

Dona Dom's file shape is unknown — "organized by apartment, phone numbers included" is the
whole of what was promised (`tasks/fuses.md` fuse #3). Guessing it would produce a parser
fitted to an imagined file. So this file states what we accept, and reconciling their export
to it is a header rename done deliberately, in the open, when it arrives.

**One row is one party of one tenancy.** This is the load-bearing choice. The real lease
carries two tenants and two mobile numbers with nothing saying which is whose
(`docs/reference/lease-template-donadom.md`), and a format with two name columns and two
phone columns would force the importer to pair them. One row, one person, one phone means
it is never in a position to guess. A household whose mapping is genuinely unknown cannot
be expressed, which is the point: it goes back to a human instead of into the database.

| column | required | notes |
|---|---|---|
| `building_name` `city` `street` `house_number` | ✔ | idempotent on the address |
| `unit_label` | ✔ | `03` and `3` are one unit — `portfolio`'s rule |
| `floor` | | whole number, or blank |
| `starts_on` | ✔ | `YYYY-MM-DD`, checked by `occupancy`'s `validDate` |
| `ends_on` | | blank is an open-ended term |
| `parking_spot` `storage_unit` | | blank is none |
| `person_name` | ✔ | |
| `phone` | ✔ | any spelling; `identity` normalises to E.164 |
| `role` | ✔ | `tenant` · `billed` · `guarantor` |

Column order does not matter; names do. A missing required column fails the whole file —
that is a wrong file, not a bad row.

A UTF-8 BOM and CRLF line endings are handled, because a spreadsheet exporting Hebrew on
Windows produces both, and a BOM otherwise attaches itself to the first column name and
silently breaks every lookup.

## The person's key is the phone

`identity.addPerson` needs an intent key. `SPEC-identity.md` originally said the importer's
key would be its source row; that is wrong and was amended in this slice. A row number moves
when the file is re-sorted or when one line is inserted near the top, and every key below it
shifts — minting a second person for someone who already exists, which is the duplication
the whole design exists to prevent. The normalised phone is the one thing about a row that
cannot move, and one phone is one person by schema.

Consequence, stated plainly: **the importer creates and never updates.** A corrected
spelling of a name in a re-imported file does nothing, because the person already exists
under that key. Correcting a person is an admin-screen job (week 6), not an import.

## Rejects

A row that fails leaves a `Rejection { line, code, reason }` and the run continues. The line
is the physical line in the source file, counted through quoted newlines, so it points at
what the operator sees in their spreadsheet.

Only a **structural** failure aborts the run: an unterminated quote, a ragged row, a missing
required column. After any of those the line numbers are no longer meaningful, and a reject
list with wrong line numbers is worse than no list.

An unexpected non-`KernelError` failure is recorded as `unavailable / "unexpected failure"`
with no detail. The run may be reading real tenant data, and an internal message could carry
some of it.

## Dry run

Default. `--commit` is required to write, because the first run against real tenant data
should be readable before it is irreversible.

**A dry run validates; it does not simulate.** It parses the file and applies every field
rule through the same module functions the commands use, so a row it accepts is a row those
commands accept. What it does not do is execute the writes, which means it cannot surface a
failure that only exists in the database's current state.

In practice that set is nearly empty here — every command this tool calls is idempotent, and
because a person is keyed by their phone, the one conflict `identity` can raise (a number
claimed by a second person) is unreachable through this path. The honest gap is that a
future column, or a command that gains a conflict, would not be caught until `--commit`.
Simulating properly needs the module commands to accept a transaction rather than a pool;
that is a real change to four modules and belongs in its own slice, not smuggled into this
one.

## Usage

```
npm run import -- <file.csv>            # dry run, prints the report
npm run import -- <file.csv> --commit   # writes
```

Exits non-zero if anything was rejected, so it is usable from a script. `src/import/fixtures/pilot-sample.csv`
is a realistic seeded building — one household of three parties, a second of two, and five
rows that are each wrong in a different way.

## Not yet in place

- **No real file has been imported.** Built ahead of its data, per `ROADMAP.md`'s own
  contingency ("weeks 2–3 run on a realistic seeded building; importer makes swap-in a
  one-hour job"). The slice's third acceptance bar — five spot-checks against the source
  document — cannot be met until Dona Dom sends the table.
- **No update path**, as above.
- **No "unconfirmed" party↔phone state.** The format makes the ambiguity unrepresentable
  rather than modelling it. If the real file turns out to carry households that genuinely
  cannot be split, that is the moment to model it, with the file in hand.
- **No vendor or asset import.** This tool loads the tenant mapping table only.
