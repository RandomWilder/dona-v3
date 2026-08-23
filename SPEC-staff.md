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

**No auth yet.** `/admin` is open on staging until slice 5.2 puts a session in front of it. It
exposes nothing — no data, no commands — so the gap is a missing gate, not a leak. 5.2 closes it
before any real content lands behind it.
