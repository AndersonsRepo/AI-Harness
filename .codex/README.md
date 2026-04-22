# Codex Notes

This folder is for Codex-specific working context that should not be treated as shared repository policy for other agents.

Use this folder for:
- local contributor guidance for Codex
- summaries of repo subsystems that are expensive to rediscover
- workflow notes that help Codex navigate the repo quickly

Keep shared, user-facing, or agent-agnostic documentation in normal repo docs such as `README.md`, `docs/`, or `vault/`.

Current files:
- `repository-guidelines.md` — concise contributor guide for Codex
- `memory-system.md` — summary of the AI Harness memory pipeline, retrieval model, and maintenance jobs
- `model-agnostic-roadmap.md` — phased plan for Claude + Codex mixed runtime and Codex-only degraded mode

Conventions:
- Prefer `.codex/` for Codex-only notes instead of root-level `AGENTS.md`
- Do not store secrets here
- Treat these files as operational guidance, not product documentation

## Public vs Private Branch Rules

Codex should assume:
- public `main` is template-safe only
- private runtime behavior may live on a separate local branch/worktree

Workflow rules:
- Do not move private local state back onto `main`
- Do not commit active `.claude/agents/*.md`, active `heartbeat-tasks/*.json`, `vault/` data, logs, DBs, `.env` files, or other local runtime artifacts
- Put tracked examples in inert locations such as `.claude/examples/` and `heartbeat-tasks/examples/`
- If a requested improvement is useful locally but encodes private projects, paths, prompts, or workflow assumptions, keep it on the private branch unless the user explicitly asks to generalize it for public `main`
- When preparing public changes from private work, prefer cherry-picking only the safe commit(s) instead of merging the private branch wholesale
- Never push a private branch without explicit user confirmation
