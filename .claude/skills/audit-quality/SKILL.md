---
name: audit-quality
description: Investigate suspected agent-quality regressions by reading the regression-replay timeline, drilling into per-run scorecards, and tracing flagged outcomes to specific commits. Read-only investigation; proposes fixes but does not apply them.
user-invocable: true
argument-hint: "[symptom hint, e.g. \"researcher feels off on retrieval tasks since last week\"]"
context: fork
agent: quality-auditor
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
model: sonnet
---

# Audit Quality

Invokes the `quality-auditor` agent to investigate suspected agent-quality regressions.

The agent is read-only by design and reads the regression-replay timeline (`vault/shared/regression-replay/timeline.md`), per-run scorecards (`runs/*.md`), captured baselines (`baselines/*.json`), candidate outputs (`runs/candidates/*.txt`), and git log to trace flagged outcomes to specific commits.

## Usage

```
/audit-quality
/audit-quality "researcher feels off on retrieval tasks since last week"
/audit-quality "builder dropped error handling in last PR"
/audit-quality "flake rate up on shape-03"
```

`$ARGUMENTS` is the optional symptom hint. Without a hint, the agent scans the most recent ~20 timeline entries for flagged/regress/disagreement/partial outcomes and reports.

## Steps

1. **Pin the agent context.** The auditor's instructions live in `.claude/agents/quality-auditor.md` (install from `.claude/examples/agents/quality-auditor.md` if not present). The shared rubric is `vault/shared/regression-replay/rubric.md` (currently v2). Both should be read at the start of every invocation so the auditor's verdicts remain consistent across sessions.

2. **Run the timeline scan.** Read `vault/shared/regression-replay/timeline.md`. Identify recent entries where outcome is one of: `flagged`, `regress`, `flaky_*`, `disagreement`, `partial`. If `$ARGUMENTS` is present, filter to entries that plausibly match the hint (by date window, agent role, or shape).

3. **Drill into scorecards.** For each interesting timeline entry, read the corresponding `vault/shared/regression-replay/runs/<date>-*.md` scorecard. Note the per-seed verdicts, which seeds flagged, the per-run PoLL judge votes, and the candidate output paths.

4. **Pull candidates if needed.** If a regress fires, read the relevant `vault/shared/regression-replay/runs/candidates/<date>-<seed>-run-<n>.txt` files and compare against the corresponding `baselines/<seed>-<date>-h<v>.json` `agent_response.text` field.

5. **Cross-reference commits.** For tier-1 (commit-triggered) entries, the timeline row carries the SHA. Run `git show <sha>` and `git log --oneline <prev>..<sha>` to identify what changed in the flagged window. For tier-2 weekly entries, scan the week leading up to the run.

6. **Watch for the cross-vendor disagreement pattern.** When PoLL shows `sonnet=pass, codex=regress`, that is **not necessarily a regression** — it can reflect Codex's known stricter prior on retrieval-synthesis tasks. Flag it explicitly so the operator knows the disagreement reflects vendor bias, not necessarily a code change. Only call it out as a real regression if the pattern *shifts* (e.g. Sonnet starts also flagging, or both flag together).

7. **Report.** Output format the auditor uses:

   ```
   ## Investigation summary

   [What you found, 2-3 sentences. Include the timeline window analyzed.]

   ## Evidence

   - Timeline rows: <paths>
   - Commits in window: <git log oneline>
   - Candidate outputs reviewed: <paths>
   - Baselines compared: <paths>

   ## Hypothesis

   [Most likely root cause if any. State your confidence level.]

   ## Recommended next action

   [One concrete next step. Do not implement — propose only.]
   ```

## Calibration capture (frictionless)

If during the conversation the user issues a critique on agent output ("the researcher should have surfaced LRN-foo here", etc.), the auditor can capture it as a calibration anchor for the PoLL judges:

```
HARNESS_ROOT=$(pwd) npx tsx \
  bridges/discord/tools/regression-replay/capture-calibration.ts \
  --agent-role <role> \
  --shape <shape-id-or-omit> \
  --context "<original prompt>" \
  --candidate "<agent output, truncated>" \
  --critique "<user's critique verbatim>" \
  --verdict regress|unclear \
  --rationale "<why this verdict>"
```

For long context/candidate, write to a temp file and pass `--candidate @/tmp/file.txt`.

**Always confirm the proposed pair JSON with the user before running the capture.** The auditor must show what it intends to write and let the user edit before commit.

## When the timeline is too sparse

If only a small fraction of seeds are pinned, most regressions won't surface in the timeline yet. The auditor should be honest about coverage limits and suggest pinning more shapes if the user's concern falls outside the currently-pinned domain.

## What the auditor does NOT do

- Edit code or files (read-only).
- Capture calibration without user confirmation.
- Speculate beyond evidence — say "unclear" when signal is sparse.
- Re-run replays unprompted (burns API credits).
- Modify the rubric or seeds (versioned artifacts).

## Output format

Concise. Lead with verdict, then structured detail. Aim for under 800 words for routine audits.
