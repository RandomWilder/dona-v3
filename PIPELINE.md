# Vibe-Coding Pipeline — Dona Dom Phase 1

How this project gets built: one developer directing agents (Claude Code + Cursor), with the process doing the reviewing. Lives alongside `ROADMAP.md`. Current as of Aug 2026.

---

## 1. Principles (the 2026 consensus, adapted to this project)

1. **You are the director, not the typist.** The agent inspects, writes, runs, tests, and self-critiques; your job is architecture, judgment, and verification. Speed must never outrun oversight — AI still introduces a known security flaw in ~45% of generated samples, so the pipeline, not vigilance, is what keeps quality up.
2. **The spec is the prompt.** Requirements live in files the agents read (`SPEC.md`, `SPEC-<module>.md`); code sessions start from the spec, not from a chat description. Specs are executable gates, not documentation.
3. **CI is the reviewer.** Solo means no human code review — so typecheck, lint, contract tests, and the agent golden set gate every merge. Never merge red, never "fix it after".
4. **Small verified slices.** One vertical slice per session; plan → implement → verify → deploy to staging. If a task can't be described with 3 acceptance bullets, split it before starting.
5. **The golden dataset is the most important reliability artifact.** Our product IS an LLM agent — every production failure becomes a golden case, and CI reruns the whole set on any change to prompts, models, retrieval, or tools.

## 2. Division of labor: Claude Code vs Cursor

| Work | Tool | Why |
|---|---|---|
| Multi-file features, refactors, anything touching 4+ files | **Claude Code** | Reads the whole repo, runs tests/builds itself, works autonomously |
| Planning (before any big change) | **Claude Code plan mode** | Hard read-only sandbox — plan is written before edits are possible |
| Noisy research (explore a library, audit a module) | **Claude Code subagents** | Keeps the main context clean |
| Surgical edits, code review of agent output, UI polish | **Cursor** | Interactive, visual, precise — review diffs as they land |
| Parallel independent tasks | Claude Code in **git worktrees** / Cursor background agents | Isolated codebases, no stepping on your own work |

Practical setup: open the repo in Cursor, run Claude Code in Cursor's integrated terminal (or the extension). Claude Code generates the bulk; Cursor is where you read, adjust, and polish. Same context files feed both (next section), so behavior is consistent across tools.

## 3. The context layer (files agents read)

```
AGENTS.md               ← root, 20–30 lines MAX: commands, style, architecture map
CLAUDE.md               ← thin pointer: "Read AGENTS.md. Extra Claude-specific notes below."
SPEC.md                 ← shared conventions + foundation rules (the 8 invariants)
SPEC-<module>.md        ← one per module; updated BEFORE the code changes
.cursor/rules/*.mdc     ← scoped rules only (e.g. "*.html: tokens.css vars only, RTL logical props")
.claude/skills/         ← repeatable workflows with real steps (see §6)
.claude/settings.json   ← permissions allowlist + hooks
docs/decisions/ADR-*.md ← why choices were made (agents cite these instead of relitigating)
tasks/todo.md           ← current week's slices with acceptance criteria
```

Rules that matter:
- **AGENTS.md stays lean** — the standard is read natively by Cursor and everything else; duplicated README content measurably hurts agent performance. Commands, code style, directory map. Nothing else.
- **CLAUDE.md points at AGENTS.md** — one source of truth, two loaders.
- **`.cursor/rules/` is for file-scoped rules only** (things AGENTS.md can't express): UI files → design tokens only; `src/kernel/**` → never import module internals; `*.sql` → migration conventions.
- **Spec first, then code.** The session ritual for any module change: update `SPEC-<module>.md` → tell the agent to read it → implement → contract tests prove the spec.

## 4. Guardrails (enforced by code, not memory)

**Hooks** (`.claude/settings.json`) — rules with teeth, fire on lifecycle events:
- `PostToolUse` (file write) → run Biome format + lint on the touched file
- `PostToolUse` (edit in `src/<module>/`) → run that module's focused tests
- `PreToolUse` (Bash) → block `rm -rf`, raw `psql` against prod, `gcloud` mutations outside deploy scripts
- `SessionStart` → print current branch + failing tests, so no session starts blind

**Permissions**: allowlist the routine (test, lint, git status/diff, docker compose) so flow is uninterrupted; keep deploy and destructive commands behind prompts.

**Secrets discipline**: keys live in Secret Manager and `.env` (gitignored); never in prompts, never in code. Standing instruction in AGENTS.md: parameterized queries, validate all inputs at the edge — saying it in the constitution measurably changes what agents generate.

**Plan mode is mandatory** for: anything touching the kernel, migrations, auth/verification, or 2+ modules. Plan is reviewed (you, in 2 minutes), then executed.

## 5. The verification pipeline (local → CI → staging → prod)

```
local:   biome + typecheck + focused tests        (hooks run these as you go)
   ↓ push / PR
CI:      typecheck · lint · unit + contract tests
         golden set evals  ← blocks merge on grounding/refusal/isolation regression
         race + timeout tests (dispatch)          npm audit / dependency scan
   ↓ merge to main
staging: auto-deploy (Cloud Run) → migrations → smoke test (health + one scripted agent conversation)
   ↓ tag v*
prod:    deploy → smoke → done   (rollback = re-deploy previous revision, one command)
```

- **Any PR touching a prompt, model id, retrieval config, or tool definition triggers the full eval run.** A quality regression past threshold does not merge — same as a failing unit test.
- Staging smoke test includes one real scripted conversation (verify → lease question → citation present) so "deployed but silently broken" cannot happen.
- Deploy and rollback are single commands from day 1 (week 1 of the roadmap proves both directions on purpose).

## 6. The golden set (our product-specific gate)

- Start with ~30–50 Hebrew cases (week 3 of the roadmap): grounding, refusal-to-invent, isolation attempts, escalation triggers, tone. **50 catches large regressions; grow toward ~200 for statistical confidence; past ~500 is diminishing returns.**
- Each case: input conversation + expected behavior (assertions on: which tool was called, citation present, no invented facts, correct refusal). Tool-selection accuracy and trajectory checks, not just final-text matching.
- **The feedback loop is the product**: production failure → becomes a golden case same day → CI blocks that failure forever → the correction is also the tenant-facing trust-repair flow. One mechanism, two payoffs.
- Version the dataset in the repo (`evals/golden/*.json`); review diffs to it like code.

## 7. Daily + weekly loop

**Daily (per slice):**
1. Pick the slice from `tasks/todo.md` (written with acceptance criteria)
2. Update the module spec if behavior changes
3. Claude Code: plan mode (if non-trivial) → approve plan → implement + tests
4. Cursor: read the diff — you review everything that merges, even though CI is the gate
5. Merge green → staging auto-deploys → 2-minute smoke on staging
6. End of day: staging is current, `todo.md` updated

**Weekly (Friday, 30 min):**
- Checkpoint demo against the roadmap week
- Review golden set diffs + any new eval cases from the week's real transcripts
- Move cut-line items; update `ROADMAP.md` checkboxes
- Tag prod release if the week's slice is done

## 8. Day-1 setup checklist (in order)

- [ ] `git init` + GitHub repo; branch protection on `main` (checks required, no force push)
- [ ] Scaffold: `AGENTS.md` (20 lines), `CLAUDE.md` pointer, `SPEC.md` with the 8 foundation rules, `tasks/todo.md`
- [ ] `.claude/settings.json`: permissions allowlist + the four hooks from §4
- [ ] `.cursor/rules/`: ui-tokens rule, kernel-boundary rule, migrations rule
- [ ] Biome + tsconfig + `node --test` wiring; one passing dummy test
- [ ] GitHub Actions: `ci.yml` (typecheck/lint/test) + `deploy.yml` (staging on main, prod on tag)
- [ ] GCP: project, Artifact Registry, Cloud Run services (staging/prod), Cloud SQL + pgvector, Secret Manager; Workload Identity Federation for Actions (no long-lived keys)
- [ ] `evals/` folder with runner stub + first 3 golden cases (even trivial ones — the gate exists from commit one)
- [ ] Prove the pipeline: break a test → PR blocked; fix → merge → staging live; tag → prod; rollback once on purpose

## 9. Anti-patterns (the 2026 failure modes, named)

- **Chat-driven architecture**: deciding structure ad hoc in prompts instead of specs/ADRs → agents relitigate and drift. Write it down once.
- **Merge-then-verify**: "CI is slow, I'll push to main" — the one habit that turns vibe speed into production incidents.
- **Context bloat**: a 300-line CLAUDE.md nobody maintains. Lean constitution + scoped rules + skills-on-demand.
- **Prompt-tweaking without evals**: changing the agent's prompt because one conversation looked bad, with no golden run — you fix one case and silently break five.
- **Trusting the demo**: an agent that "worked when I tried it" is untested. If it isn't in the golden set or a contract test, it doesn't work yet.
- **Letting the agent hold secrets**: pasting keys into prompts or committing `.env`. Treat AI tools like public channels.
