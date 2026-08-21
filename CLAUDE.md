# Claude Code notes

Read `AGENTS.md` — it is the constitution for this repo (commands, architecture, style, boundaries).

Claude-specific additions:
- The golden set in `evals/` is a test suite: any change to prompts, model ids, retrieval, or tool definitions must pass it before merge.
- Spec files are the prompt: start module work by reading `SPEC-<module>.md`, and propose spec edits before code edits when behavior changes.
- One slice per session (see `tasks/todo.md`); finish with its Verify step — never self-certify.
