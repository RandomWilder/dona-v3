# dona-v3 — Dona Dom Tenancy OS

## Commands
- Test: `npm test` · Typecheck: `npm run typecheck` · Lint: `npm run lint` · Format: `npm run format`
- Golden set: `npm run evals` (gates merges alongside the tests; cases in `evals/golden/`)
- Dev: `npm run db:up && npm run dev` (http://127.0.0.1:3000/health)
- Clean clone → running: `npm ci && npm run db:up && npm run dev` (Docker required; env defaults come from `.env.example`, no `.env` needed locally)
- Node 24 type stripping runs `.ts` directly — no build step.

## Architecture
- Modular monolith, one deployable. Modules under `src/<module>/`: identity, portfolio, occupancy, catalog, vendor-roster, case, job, dispatch, fulfillment, channel, staff. Shared kernel: `src/kernel/`.
- A module may import another module's `contract.ts` only — never `src/<module>/internal/`.
- Read `SPEC.md` first. Before touching a module, read its `SPEC-<module>.md`; update the spec before changing behavior.
- Policies (rates, timeouts, deductibles, feature flags) are config/data rows — never constants in code.

## Code style
- TypeScript, erasable syntax only; explicit `.ts` extensions on relative imports; `import type` for types.
- Biome: single quotes, semicolons, trailing commas. No new runtime dependency without a stated reason in the commit body.
- Tests live beside code (`*.test.ts`); inject clock/ids — no sleeps, no `Date.now()` inside logic.
- UI: self-contained HTML + `/ui/tokens.css` tokens only; Hebrew RTL with logical CSS properties; no bundler.

## Boundaries
- Validate at every edge. Secrets only via env / Secret Manager — never in code, logs, or prompts.
- Plan mode before touching: kernel, migrations, auth/verification, or 2+ modules in one change.
- CI (`.github/workflows/ci.yml`) runs typecheck + lint + tests against a Postgres service and the golden set; both checks are required on `main`. Set `REQUIRE_POSTGRES=1` when a run must fail rather than skip the durability suite.
- Current work: `tasks/todo.md` · Plan: `ROADMAP.md` · Process: `PIPELINE.md`
