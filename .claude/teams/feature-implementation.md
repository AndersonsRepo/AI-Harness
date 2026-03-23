# Feature Implementation Team

Use this preset when building a new feature or making significant changes to the codebase.

## Team Composition
- **Team Lead**: orchestrator (plans phases, manages dependencies, debriefs)
- **Teammates**: researcher, builder, reviewer

## Workflow
1. **Research** — Researcher investigates existing patterns, relevant code, and potential conflicts
2. **Build** — Builder implements based on research findings (depends on research completion)
3. **Review** — Reviewer checks implementation quality (depends on builder completion)
4. **Debrief** — Orchestrator synthesizes results, extracts learnings to vault

## Task Dependencies
```
researcher tasks → builder tasks → reviewer tasks → orchestrator debrief
```

## Plan Approval
Required for tasks modifying 3+ files or touching infrastructure code.

## Example Invocation
```
Create an agent team to implement [feature description].
Use the feature-implementation preset: researcher investigates first,
builder implements, reviewer checks quality.
```
