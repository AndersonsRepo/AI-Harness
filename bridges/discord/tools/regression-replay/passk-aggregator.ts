// Pass^k aggregation per rubric.md v2:
//   N=3 runs at T=0
//   3-of-3 pass               → pass
//   2-of-3 pass + 1 unclear   → flaky_unclear (record, don't block)
//   2-of-3 pass + 1 regress   → flaky_regression (block — intermittent regressions are still regressions)
//   ≤1 pass                   → regress
//
// Disagreement at PoLL level (across the two judges) propagates as a
// per-run "disagreement" outcome — count it as not-pass at this layer.

import type { PollResult, PollFinalVerdict } from "./poll-aggregator.js";

export type PassKFinal =
  | "pass"
  | "regress"
  | "flaky_unclear"
  | "flaky_regression"
  | "judge_failure";

export interface PassKResult {
  per_run: PollFinalVerdict[];
  pass_count: number;
  unclear_count: number;
  regress_count: number;
  disagreement_count: number;
  judge_failure_count: number;
  total_runs: number;
  final: PassKFinal;
  reasoning: string;
}

export function aggregatePassK(perRunResults: PollResult[]): PassKResult {
  const total = perRunResults.length;
  const counts = {
    pass: 0,
    unclear: 0,
    regress: 0,
    disagreement: 0,
    judge_failure: 0,
  };
  for (const r of perRunResults) {
    counts[r.final] = (counts[r.final] ?? 0) + 1;
  }

  const verdicts = perRunResults.map((r) => r.final);

  // If every run was a judge failure, surface that — not a real verdict.
  if (counts.judge_failure === total && total > 0) {
    return {
      per_run: verdicts,
      pass_count: 0,
      unclear_count: 0,
      regress_count: 0,
      disagreement_count: 0,
      judge_failure_count: total,
      total_runs: total,
      final: "judge_failure",
      reasoning: "all runs had judge failures",
    };
  }

  // Pass^k = all runs pass.
  if (counts.pass === total && total > 0) {
    return {
      per_run: verdicts,
      pass_count: counts.pass,
      unclear_count: counts.unclear,
      regress_count: counts.regress,
      disagreement_count: counts.disagreement,
      judge_failure_count: counts.judge_failure,
      total_runs: total,
      final: "pass",
      reasoning: `all ${total}/${total} runs passed`,
    };
  }

  // Any regress run → at least flaky_regression. If majority regressed → regress.
  if (counts.regress > 0) {
    const passRate = counts.pass / total;
    if (passRate > 0.5) {
      return {
        per_run: verdicts,
        pass_count: counts.pass,
        unclear_count: counts.unclear,
        regress_count: counts.regress,
        disagreement_count: counts.disagreement,
        judge_failure_count: counts.judge_failure,
        total_runs: total,
        final: "flaky_regression",
        reasoning: `${counts.pass}/${total} pass, ${counts.regress}/${total} regress — intermittent regression`,
      };
    }
    return {
      per_run: verdicts,
      pass_count: counts.pass,
      unclear_count: counts.unclear,
      regress_count: counts.regress,
      disagreement_count: counts.disagreement,
      judge_failure_count: counts.judge_failure,
      total_runs: total,
      final: "regress",
      reasoning: `${counts.regress}/${total} regress — sustained regression`,
    };
  }

  // Disagreement (PoLL-level split) is treated like unclear for Pass^k.
  if (counts.unclear > 0 || counts.disagreement > 0) {
    return {
      per_run: verdicts,
      pass_count: counts.pass,
      unclear_count: counts.unclear,
      regress_count: counts.regress,
      disagreement_count: counts.disagreement,
      judge_failure_count: counts.judge_failure,
      total_runs: total,
      final: "flaky_unclear",
      reasoning: `${counts.pass}/${total} pass; ${counts.unclear} unclear, ${counts.disagreement} disagreement`,
    };
  }

  return {
    per_run: verdicts,
    pass_count: counts.pass,
    unclear_count: counts.unclear,
    regress_count: counts.regress,
    disagreement_count: counts.disagreement,
    judge_failure_count: counts.judge_failure,
    total_runs: total,
    final: "judge_failure",
    reasoning: "no passing runs and no clear regress/unclear signal",
  };
}
