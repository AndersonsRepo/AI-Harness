# Public Repo Policy

This repository mixes publishable source code with local runtime state and personal working context. The rule is simple:

- Commit source code, tests, templates, examples, and documentation that are required to build or understand the project.
- Do not commit secrets, local databases, runtime artifacts, personal vault content, private planning notes, or machine-specific state.

## Safe To Commit

- TypeScript, Python, and other source files under tracked project directories
- Tests and fixtures that do not embed private credentials or private customer/project data
- Docs that describe architecture, setup, or public-facing behavior
- Example config or template files intended for reuse

## Do Not Commit

- `.env` files, API keys, OAuth tokens, Discord tokens, refresh tokens, and other secrets
- SQLite databases, WAL/SHM files, PID files, logs, temp files, and generated runtime state
- Local worktrees, embeddings caches, and bridge runtime scratch data
- Personal vault content, daily notes, learning logs, live state, and other session memory
- Private agent notes, client/project-specific instructions, and local planning files

## Vault And Planning Content

The `vault/` directory is treated as local working memory unless a file is explicitly provided as a reusable template or example. Most vault content is ignored on purpose because it can contain personal context, task history, and project-specific notes that are not appropriate for a public repository.

Likewise, top-level planning files such as `PLAN.md` and `CONTEXT.md` are treated as local working documents unless they are intentionally rewritten as public documentation.

## Runtime Data

The Discord bridge and orchestration stack produce local runtime artifacts such as:

- session state
- telemetry rows
- local databases
- temp prompt/output files
- bot logs

These artifacts are operational data, not source. They should remain ignored in a public repository even when they are useful during development.

## Contributor Rule Of Thumb

Before committing, ask:

1. Is this file required for someone else to build, run, test, or understand the code?
2. Does this file contain local state, sensitive data, or personal/project-specific working context?

If the answer to `1` is no, or the answer to `2` is yes, it probably should not be committed.
