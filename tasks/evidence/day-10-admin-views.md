# Evidence — Slice 10.1: admin people + properties views

Captured 2026-08-25. GitHub Actions runs age out of the UI; this is the durable record.

ROADMAP week 2's last bar: **the pilot building is browsable on staging.** Before this
slice it was not browsable at all — `/admin` served one static file whose `נכסים` and
`אנשים` panels were empty states switched by client-side JavaScript, and nothing in the
system had ever rendered a row of data.

## What the slice turned out to be

Not a UI slice. The three domain modules exposed **no browse reads**: `portfolio` could
fetch a unit by an id it gave you no way to learn, `identity` could only resolve a phone,
and `occupancy` could go person → place but never place → person. "List + create" needed
reads on three contracts before it needed a single `<table>`.

**No migration.** Every index these reads use already existed
(`portfolio_units_building`, `occupancy_tenancies_unit`, `identity_phones_person`) —
checked against the schema, not assumed.

## The acceptance bar

| bar | how it was met |
|---|---|
| the pilot building is browsable — buildings, units, and the people in them | `walks building → unit → person as an admin` — four pages, each reached only by a link the previous page rendered, ending on a named tenant |
| server-rendered from the module contracts | every page is HTML off the server; the only script left in the shell is the mobile drawer toggle. Panels became URLs — a page whose content depends on which button was clicked last has no address to link, bookmark or reload |
| no client framework, no bundler | unchanged: one shell file with a `<!--main-->` marker the routes fill, the same substitution `loginPages()` has always done on the login error paragraph |
| Hebrew RTL, tokens only | `kernel/ui/tokens.test.ts` still passes — it fails on the HTML, which is where the discipline erodes |
| a viewer cannot mutate through the new forms | `lets a viewer read every page and refuses every create` — three POSTs refused, ids re-counted afterwards to prove nothing moved |

## The three bars, checked by breaking them

Each mechanism was removed, the suite re-run, and the file restored:

| removed | result |
|---|---|
| the `escapeHtml` call inside `h` | **8 of 27** escaping/view/browse tests fail; restored → 27/27 |
| `requireCapability` from `commands.ts` | `lets a viewer read every page and refuses every create` fails |
| `AT TIME ZONE 'Asia/Jerusalem'` from occupancy's shared `today` | **both** `findCurrentTenancy` boundary tests fail, alongside `resolveByPhone`'s |

The third is the one worth naming: the new read reuses the *same* predicate constant, so
breaking it breaks both entry points at once. That is the property the reuse was for.

## Verification

Full CI gate, run locally exactly as CI runs it:

```
npm run typecheck   -> clean
npm run lint        -> 80 files, no fixes applied
REQUIRE_POSTGRES=1 npm test -> 279 pass, 0 fail, 0 skipped   (236 -> 279)
npm run evals       -> 3/3
```

**One unexplained failure, recorded rather than smoothed over.** In the gate run
immediately after the last edit to `index.html`, one test failed. Its identity was not
captured, and it has not recurred in **17 consecutive full runs** since. The carried-in
`staff` session-sweep flake (`tasks/todo.md`, "Carried in from week 2") is the obvious
suspect — it is documented as failing roughly one run in five — but that is a guess and is
written here as one.

## Seen in a browser, not only in tests

Run locally at 375px and at desktop width. Two real defects were found this way and fixed,
each with a test added:

- an asset with no label rendered as **`boiler`** — the raw enum, in English, on a Hebrew
  ops board. Asset kinds are now named (`assetKindNames`);
- an open-ended tenancy read **"מ־01.03.2025 עד —"**, which looks like missing data rather
  than an open term. It now says `ללא מועד סיום`.

Also corrected: the shell footer still read *"שלד בלבד"* — "shell only" — which stopped
being true the moment this slice landed.

The desktop screenshot shows what the natural-ordering fix is for: units listing
**1, 2, 3, 10, קרקע** rather than 1, 10, 2, 3.

## Decisions on the record

- **Detail reads are audited; list reads are not.** Asaf's call, before the plan. The 9.1
  rule is that every staff *action* leaves a record, and the honest reading of that for
  reads is not "every page load" — a row per nav click makes `audit_log` mostly navigation
  and makes the week-2 demo harder to read. What a privacy request asks is *who opened
  this tenant's record*, which is the detail view. `staff.getUnitDetail` and
  `staff.getPersonDetail` write a row with the actor and role; the lists write none. Both
  asserted in `audits a detail read and leaves a list read untraced`.
- **`אנשים` is a lookup, not a roster.** Also Asaf's call. There is deliberately no
  "list every person" read: a screen whose entire content is every tenant's personal data,
  unscoped and unpaginated, is a liability. People are reached through the property, plus a
  phone box over the existing `resolveByPhone`.
- **The escaper is in the kernel, not in `staff`.** `channel` renders tenant text in week 4
  and must not grow a second copy — the argument that moved `requireText` in 7.1. It
  escapes **by default** through a tagged template with no raw escape hatch: forgetting is
  impossible, where an `escapeHtml()` you must remember to call is one edit from an
  injection.
- **A malformed phone and an unknown one get the same page.** Probing the lookup box must
  not teach which numbers are in the system. Asserted in
  `answers a nonsense number the same way as an unknown one`.
- **`findCurrentTenancy` returns `null`, not `not_found`.** The unit exists and nobody
  lives there; an empty flat is an ordinary state of the world, rendered as a vacancy. A
  unit id naming nothing is `portfolio.getUnit`'s `not_found`, raised first.

## Two corrections where reality disagreed with the spec

Both were the spec being wrong, not the test — the same way round as 7.1's timezone note.

1. **Unit ordering.** `SPEC-portfolio.md`'s first draft claimed `label_key` alone sorted
   `2` before `10` because the normaliser strips leading zeros. It does not — `label_key`
   is text, and a real staircase listed as 1, 10, 11, 2. The read now sorts numeric labels
   as numbers and everything else as text after them; the spec was rewritten to match.
2. **Parameter properties are not erasable syntax.** `class Html { constructor(readonly
   value: string) }` is valid TypeScript and Node 24 refuses it, because the runtime strips
   types rather than compiling them. An explicit field instead. AGENTS.md already said
   "erasable syntax only"; this is what that rule looks like when it fires.

## Gaps, stated

- **The read guard has no failing role.** All three roles hold `read`, so
  `requireCapability(role, 'read')` on the five reads cannot refuse anyone today — there is
  no reachable `not_allowed` on a view. The check exists so a fourth role cannot silently
  open the views. `internal/queries.test.ts` pins the whole grid so the fact stays visible
  rather than reading as tested coverage.
- **No CSRF token on the create forms.** The session cookie is `SameSite=Lax`, which is
  what stops a cross-site POST from carrying it. A token stays deferred to week 6 with
  login CSRF, as `SPEC-staff.md` already recorded.
- **No edit, no delete, no search, no pagination.** Every view is list-and-create.
  Correcting a misspelled building is still a manual database task.
- **The viewer account for Friday's demo still cannot be created by the system** — the
  seeder creates but never updates, `administer` still has no command. Unchanged by this
  slice, and still 10.2's to solve.
- **The building list is unbounded.** Deliberate for a few-dozen-building portfolio, and
  the local database made the shape visible: 1,291 buildings of test residue rendered as
  one list. The ordering chosen is already the stable sort a keyset cursor would need.
