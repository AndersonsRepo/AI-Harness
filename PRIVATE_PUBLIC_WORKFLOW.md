# Private/Public Workflow

This repo now has two active lines of work:

- public template branch/worktree: `main`
- private operating branch/worktree: `private/runtime-local`

The goal is to let the private branch run the live harness without turning future public sync into another history cleanup project.

## Branch Roles

`main`:
- public-safe source of truth
- no private runtime state
- no client/project-specific operating data
- changes should be safe to publish directly

`private/runtime-local`:
- live operational branch for the local harness
- may contain private runtime adjustments, local operating conventions, and private-only docs
- should stay clean in git status even though it uses local scratch/state paths at runtime

## What Should Stay Portable

These changes should usually be written so they can move cleanly from private to public:

- core runtime/orchestration code under `bridges/discord/`
- bug fixes
- test improvements
- schema/migration changes
- monitor, telemetry, queue, handoff, subagent, and tmux orchestration improvements
- generic docs and setup guidance
- repo hygiene improvements that make the public template safer

## What Should Stay Private

These changes should usually remain on `private/runtime-local` unless intentionally generalized:

- private operational docs
- client/project-specific instructions
- local-only runtime behavior that depends on private paths, accounts, or operating assumptions
- local secrets, vault content, state files, logs, scratch dirs, and symlinked runtime paths
- private-only Codex/Claude behavior that is not ready for public template use

## Commit Discipline

To keep transfer clean:

- make public-safe changes in focused commits
- isolate private-only runtime tweaks in separate commits
- do not mix private data handling and public feature work in the same commit
- if a change is partly private and partly portable, split it before committing

Good:
- one commit for runtime policy cleanup
- one separate commit for private bot startup behavior

Bad:
- one commit that combines queue refactors, private path fixes, and local vault workflow changes

## Transfer Rule

Do not merge `private/runtime-local` into `main`.

Use this workflow instead:

1. develop on `private/runtime-local`
2. keep public-safe work in isolated commits
3. cherry-pick those commits onto `main`
4. test on `main`
5. push `main`

If a private branch change needs adaptation before it is public-safe, reimplement or edit it on `main` instead of forcing the original commit across unchanged.

## Operational Guardrails

- keep the private worktree clean after each task
- prefer worktree-local excludes for runtime symlinks and local scratch paths
- avoid changing shared dependency layout while the live private harness is running
- before moving a private commit to `main`, quickly scan for:
  - hardcoded local paths
  - private project names
  - private vault references
  - secrets or tokens
  - private-only docs or assumptions

## Current Practical Default

For now:

- build and operate locally on `private/runtime-local`
- treat `main` as the publication branch
- move changes from private to public by cherry-pick only
