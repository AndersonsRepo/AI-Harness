# Code Review Team

Use this preset for thorough code review of PRs or uncommitted changes.

## Team Composition
- **Team Lead**: orchestrator (coordinates review angles, synthesizes feedback)
- **Teammates**: researcher, reviewer

## Workflow
1. **Research** — Researcher analyzes the diff, identifies affected systems and risk areas
2. **Review** — Reviewer performs systematic review (correctness, security, performance, style)
3. **Synthesize** — Orchestrator combines findings into actionable feedback

## Task Dependencies
```
researcher analysis → reviewer (uses research for context) → orchestrator synthesis
```

## Plan Approval
Not required — review is non-destructive.

## Example Invocation
```
Create an agent team to review the changes in this PR / the uncommitted changes.
Use the code-review preset: researcher maps the blast radius,
reviewer checks quality across all angles.
```
