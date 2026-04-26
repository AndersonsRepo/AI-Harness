// Panel-of-LLMs aggregation. Per rubric.md v2:
//   - Both pass        → final pass
//   - Either regress   → final regress (block)
//   - One pass + one unclear → final unclear (flag for human)
//   - Disagreement (pass + regress) → final disagreement (escalate)
//
// Disagreement is its own tier — surface, don't paper over with a tiebreaker.

import type { JudgeVerdict, Verdict } from "./judge.js";

export type PollFinalVerdict =
  | "pass"
  | "regress"
  | "unclear"
  | "disagreement"
  | "judge_failure";

export interface PollResult {
  judges: JudgeVerdict[];
  final: PollFinalVerdict;
  disagreement: boolean;
  evidence_summary: string;
}

export function aggregatePoll(judges: JudgeVerdict[]): PollResult {
  // If ALL judges failed, surface that as judge_failure — distinct from any
  // verdict because we can't trust the result at all.
  const failed = judges.filter((j) => !j.ok);
  if (failed.length === judges.length && judges.length > 0) {
    return {
      judges,
      final: "judge_failure",
      disagreement: false,
      evidence_summary: failed.map((j) => `${j.judge}: ${j.error}`).join("; "),
    };
  }

  // Failed judges count as "unclear" in aggregation. We don't know what they
  // would have said, so we can't take their silence as a pass. Bias toward
  // flagging when in doubt (per rubric.md: "false-pass is more dangerous than
  // false-flag").
  const verdicts: Verdict[] = judges.map((j) => (j.ok ? j.verdict : "unclear"));

  const counts: Record<Verdict, number> = {
    pass: verdicts.filter((v) => v === "pass").length,
    regress: verdicts.filter((v) => v === "regress").length,
    unclear: verdicts.filter((v) => v === "unclear").length,
  };

  // Any regress → regress (block on regression). Even a single regress
  // wins over unclears.
  if (counts.regress > 0 && counts.pass === 0) {
    return {
      judges,
      final: "regress",
      disagreement: false,
      evidence_summary: judges
        .filter((j) => j.ok && j.verdict === "regress")
        .map((j) => `${j.judge}: ${j.evidence}`)
        .join("; "),
    };
  }

  // pass + regress → genuine disagreement, escalate.
  if (counts.pass > 0 && counts.regress > 0) {
    return {
      judges,
      final: "disagreement",
      disagreement: true,
      evidence_summary: judges
        .filter((j) => j.ok)
        .map((j) => `${j.judge}=${j.verdict}: ${j.evidence}`)
        .join("; "),
    };
  }

  // All pass → pass. (Note: failed judges are counted as unclear above, so
  // this only fires when EVERY judge returned a successful pass verdict.)
  if (counts.pass === judges.length && counts.pass > 0) {
    return {
      judges,
      final: "pass",
      disagreement: false,
      evidence_summary: "all judges agree: pass",
    };
  }

  // pass + unclear (including failure-as-unclear) → unclear, flag for review.
  // This catches the "1 judge passed, 1 judge failed" case correctly.
  if (counts.pass > 0 && counts.unclear > 0) {
    return {
      judges,
      final: "unclear",
      disagreement: false,
      evidence_summary: judges
        .map(
          (j) =>
            `${j.judge}=${j.ok ? j.verdict : "FAILED"}: ${j.ok ? j.evidence : j.error}`,
        )
        .join("; "),
    };
  }

  // Pure unclear (no pass, no regress).
  if (counts.unclear > 0) {
    return {
      judges,
      final: "unclear",
      disagreement: false,
      evidence_summary: judges
        .map(
          (j) =>
            `${j.judge}=${j.ok ? "unclear" : "FAILED"}: ${j.ok ? j.evidence : j.error}`,
        )
        .join("; "),
    };
  }

  // Defensive — shouldn't reach here.
  return {
    judges,
    final: "unclear",
    disagreement: false,
    evidence_summary: "aggregation reached unexpected state",
  };
}
