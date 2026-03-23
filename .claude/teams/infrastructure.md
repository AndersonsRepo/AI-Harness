# Infrastructure Team

Use this preset for deployment, monitoring, or system-level changes.

## Team Composition
- **Team Lead**: orchestrator (plans rollout, manages risk)
- **Teammates**: researcher, ops, reviewer

## Workflow
1. **Research** — Researcher audits current state, identifies dependencies and risks
2. **Implement** — Ops makes infrastructure changes based on research (depends on research)
3. **Review** — Reviewer verifies changes are safe and correct (depends on ops)
4. **Verify** — Orchestrator confirms system health post-change

## Task Dependencies
```
researcher audit → ops implementation → reviewer verification → orchestrator health check
```

## Plan Approval
Always required — infrastructure changes can affect system stability.

## Example Invocation
```
Create an agent team to [infrastructure task].
Use the infrastructure preset: research current state first,
ops implements with reviewer verification.
```
