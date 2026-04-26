---
rubric_version: 2
harness_version: 1
populated_since: 2026-04-25
---

# Regression Replay Timeline

Rolling 90-day summary of replay runs. One row per run, newest first. Auto-maintained by `heartbeat-tasks/scripts/regression-replay-monitor.py` (tier 1) and `heartbeat-tasks/scripts/regression-replay-weekly.py` (tier 2). On-demand auditor (tier 3) entries are interspersed.

## Format

### Tier 1 (commit-triggered, structural-metrics only)

```
DATETIME          SHA       TYPE    HV  RETRIEVAL  CTX_DELTA  ROUTING  OUTCOME    NOTES
2026-04-25 14:00  -         baseline v1  1.00       0%         exact    ok         initial capture
2026-04-26 09:32  abc1234   commit  v1  0.94       -2.1%       exact    ok         within noise band
2026-04-26 14:51  def5678   commit  v1  0.61       -8.4%       exact    flagged    retrieval shifted, escalate to /audit-quality
```

### Tier 2 (weekly, Pass^3 + PoLL judges)

```
DATETIME          TYPE    HV  PASS^3            POLL_AGREEMENT  DISAGREEMENT  COST     NOTES
2026-04-26 02:00  weekly  v1  shape-01: 3/3     2/2 pass        0/10          $14.20   all pass
                              shape-02: 3/3     2/2 pass        0/10
                              shape-03: 2/3     1/2 pass+1unc   0/10                   shape-03 flaky_unclear, 1 unclear of 3 runs
                              ...
```

### Tier 3 (on-demand auditor)

```
DATETIME          TYPE    HV  TRIGGER                         FINDINGS
2026-04-27 11:15  audit   v1  user invoked /audit-quality     traced flagged retrieval at def5678 to embeddings.ts L142 commit
```

### Harness-version bumps (separator entries)

```
2026-05-15 16:30  HARNESS_VERSION_BUMP  v1 → v2  context-assembler refactor (commit abc9999); 10 seeds re-baselined
```

## Column legend

- **DATETIME**: ISO-style local timestamp.
- **SHA**: commit SHA that triggered the run (tier 1 only).
- **TYPE**: `baseline` | `commit` | `weekly` | `audit` | `HARNESS_VERSION_BUMP`.
- **HV**: harness version at run time (`pinned-harness.md`).
- **RETRIEVAL**: average Jaccard similarity of retrieved-learning sets vs current baseline. 1.00 = identical. Apply 3pp noise floor: 0.97-1.00 = ok, 0.94-0.97 = ok-but-noted, <0.7 = flagged (after noise band).
- **CTX_DELTA**: average context-block size delta vs baseline as percentage. Apply 2-5% noise floor.
- **ROUTING**: did the chain take the same agent path as baseline? `exact` | `differs` | `truncated`.
- **OUTCOME**: `ok` | `flagged` | `regress` | `unclear` | `noise_band`. Tier 1 only emits `ok`/`flagged`/`noise_band`; tier 2 may emit `regress` after PoLL aggregation.
- **PASS^3**: per-seed Pass^k score, e.g. `3/3` (all pass), `2/3` (one flake), `1/3` (two flakes — investigate).
- **POLL_AGREEMENT**: how the two PoLL judges voted on the seed, e.g. `2/2 pass`, `1/2 pass+1regress` (disagreement), `2/2 unclear`.
- **DISAGREEMENT**: count of judges that disagreed across all seeds in the run, e.g. `0/10` = all judges agreed on all seeds.
- **COST**: actual token cost of the run (tier 2 only).
- **NOTES**: short signal pointing to what shifted. For HARNESS_VERSION_BUMP: brief description of the harness change.

## Reading the timeline

When investigating a "feels off" complaint:

1. Scan recent rows for `flagged`, `regress`, `flaky_*`, or `disagreement` outcomes.
2. Check if any HARNESS_VERSION_BUMP separators are nearby — comparisons across them are apples-to-oranges.
3. Drill into the corresponding `runs/*` file for the full per-seed scorecard.
4. If unclear: invoke `/audit-quality` with a hint, e.g. `/audit-quality "researcher feels off on Hey Lexxi tasks since last week"`.

## Cross-version comparison rules

- **Within same `harness_version` AND same `rubric_version`**: full timeline comparison valid.
- **Across `harness_version` bumps**: only structural metrics (Jaccard, ctx_delta, routing) compare cleanly. Output-level verdicts (PoLL pass/regress) require re-baselined comparison.
- **Across `rubric_version` bumps**: PoLL verdicts compare with caution; note the rubric change in the auditor's investigation.

## Timeline rotation

Entries older than 90 days are moved to `runs/archive/timeline-YYYY-Q.md` (one file per quarter) by a weekly heartbeat. The live `timeline.md` stays under ~200 rows for quick scanning.

## Initial state

(empty — initial baselines pending first capture)
