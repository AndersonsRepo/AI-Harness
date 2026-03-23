# Debugging Team

Use this preset when tracking down a bug with unclear root cause.

## Team Composition
- **Team Lead**: orchestrator (forms hypotheses, coordinates investigation)
- **Teammates**: researcher, builder

## Workflow
1. **Diagnose** — Researcher traces the bug: reproduces, identifies root cause, documents code path
2. **Fix** — Builder implements the fix based on researcher's diagnosis (depends on diagnosis)
3. **Verify** — Orchestrator verifies the fix addresses the root cause, not just symptoms

## Task Dependencies
```
researcher diagnosis → builder fix → orchestrator verification
```

## Competing Hypotheses Variant
For bugs with multiple possible causes, spawn multiple researcher teammates:
```
Create an agent team to debug [issue]. Spawn 3 researcher teammates,
each investigating a different hypothesis. Have them share findings
and try to disprove each other's theories.
```

## Example Invocation
```
Create an agent team to debug [bug description].
Use the debugging preset: researcher diagnoses first,
builder fixes based on findings.
```
