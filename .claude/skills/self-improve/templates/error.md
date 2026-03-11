```markdown
---
id: ERR-YYYYMMDD-XXX
logged: YYYY-MM-DDTHH:MM:SS
type: error
severity: low | medium | high | critical
status: new | investigating | resolved | wont_fix
category: tool_failure | config_error | api_error | runtime_error
area: frontend | backend | infra | tools | docs | config | general
agent: main | researcher | discord | reviewer
project: ai-harness | mento | client-project | general
pattern-key: short-kebab-case-identifier
recurrence-count: 1
first-seen: YYYY-MM-DD
last-seen: YYYY-MM-DD
tags: [tag1, tag2, tag3]
related:
  - "[[ERR-YYYYMMDD-XXX]]"
---

# Title of the error

## Command
The command or operation that failed.

## Error
Actual error message or output.

## Environment
Relevant context (OS, tool version, project).

## Root Cause
What went wrong (fill in when resolved).

## Fix
How it was fixed (fill in when resolved).
```
