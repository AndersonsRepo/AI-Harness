# Repository Guidelines

## Project Structure & Module Organization
`bridges/discord/` contains the main Discord bridge, task orchestration layer, and the highest test concentration. `mcp-servers/` holds standalone TypeScript MCP servers such as `mcp-vault`, `mcp-harness`, and `mcp-projects`, each with its own `package.json` and `tsconfig.json`. Supporting automation and local state live in `heartbeat-tasks/`, `scripts/`, `vault/`, `templates/`, and `docs/`.

## Build, Test, and Development Commands
This repo is package-local, not a single root workspace. Run commands from the relevant package directory.

- `cd bridges/discord && npm install` installs the Discord bridge dependencies.
- `cd bridges/discord && npm run dev` starts the bot with `tsx watch`.
- `cd bridges/discord && npm run build` compiles the bridge to `dist/`.
- `cd bridges/discord && HARNESS_ROOT=../.. npx tsx --test tests/gateway.test.ts tests/commands.test.ts tests/types.test.ts tests/handoff-adapter.test.ts` runs the main integration-style test suite.
- `cd mcp-servers/mcp-vault && npm install && npm run build` builds an MCP server; the same pattern applies to the other `mcp-servers/*` packages.

## Coding Style & Naming Conventions
The codebase is strict TypeScript with ESM output and explicit `.js` import suffixes in source files. Follow the existing 2-space indentation and keep modules focused. Use `camelCase` for functions and variables, `PascalCase` for classes, interfaces, and types, and descriptive file names such as `task-runner.ts` or `monitor-ui.ts`. Prefer small helpers over deeply nested logic; add comments only where behavior is not obvious.

## Testing Guidelines
Tests in `bridges/discord/tests/` use Node’s built-in `node:test` runner through `tsx`. Name new tests `*.test.ts` and colocate them with the existing suite. Cover command handling, transport behavior, and task orchestration paths when changing the bridge. There is no visible repo-wide coverage gate, so include the exact test command you ran in your PR notes.

## Commit & Pull Request Guidelines
Recent commits use short, imperative subjects such as `Add harness_channels MCP tool for live task monitoring` and `Fix channel lock not released...`. Keep commits scoped to one change and lead with `Add`, `Fix`, `Update`, `Refactor`, or similar verbs. PRs should summarize behavior changes, list affected packages, mention config or migration steps, and include screenshots only for Discord UI or monitor changes.

## Configuration & Security Tips
Set `HARNESS_ROOT` before running the bridge or tests. Keep tokens in local `.env` files and never commit project-specific secrets or generated local state such as personal `projects.json` contents.
