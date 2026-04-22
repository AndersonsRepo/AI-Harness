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
