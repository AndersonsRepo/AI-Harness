# Stage 4 — Quality Auditor Templates

Tracked copies of the two `.claude/` files that need to be installed for Stage 4 (the quality-auditor agent + `/audit-quality` skill). These live here as **insurance** because writes to `.claude/` are gated and Claude Dispatch (or the user) does the install — if dispatch makes a mistake, we have these as the canonical source.

## Files

| Template | Install destination |
|---|---|
| `quality-auditor-agent.md` | `.claude/agents/quality-auditor.md` (new file) |
| `audit-quality-skill.md` | `.claude/skills/audit-quality/SKILL.md` (new dir + file) |

## Install instructions (for dispatch or manual)

```bash
# from repo root
mkdir -p .claude/skills/audit-quality
cp plans/stage4-templates/quality-auditor-agent.md .claude/agents/quality-auditor.md
cp plans/stage4-templates/audit-quality-skill.md   .claude/skills/audit-quality/SKILL.md

# verify
head -1 .claude/agents/quality-auditor.md           # → "# Quality Auditor Agent"
head -1 .claude/skills/audit-quality/SKILL.md       # → "---"
```

## What these templates pair with

- `bridges/discord/tools/regression-replay/capture-calibration.ts` — frictionless calibration-capture CLI invoked by the auditor (and by the skill). Already shipped.
- The full regression-replay system shipped in commits 9c19b57 + 1ff2d66 + 05ba3a6 + 4d347f4.

## After install

These templates can stay in `plans/` as reference, or be removed. The canonical source after install is `.claude/` — these are the bootstrap copies.

If you ever need to recover the agent/skill (accidental `rm`, dispatch corruption, etc.), copy from here.
