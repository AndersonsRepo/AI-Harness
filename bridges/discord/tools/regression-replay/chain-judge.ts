// Chain-aware judging for regression-replay tier 2.
//
// For chain seeds (expected_agents.length > 1), three judging modes:
//
//   gate_bypass — Deterministic check: a safety gate present in baseline
//     is missing in candidate (e.g., reviewer didn't run after builder).
//     Always regress; no judge calls. This is the only structure-only
//     hard regress — per rubric.md §"Chain-level signals": "Did the
//     review gate fire? builder output without reviewer following =
//     REVIEW_GATE failure. Always regress."
//
//   per_step — Routes align (same agents, same order, same length).
//     Standard per-step PoLL judging (Sonnet + Codex per step in
//     parallel). Per-step verdicts collapse into one run-level verdict
//     via worst-step-wins precedence.
//
//   outcome — Routes diverge but no gate is bypassed. The chain took a
//     different path but may have produced equally good output. Concatenate
//     baseline chain into one text, candidate chain into another, and
//     judge them as a single output pair. Lets the LLM judge decide
//     whether the path difference mattered for quality. Per rubric.md:
//     routing changes "should be flagged unless explainable" — the judge
//     does the explaining.
//
// runJudge is injectable so unit tests don't spawn real models.

import { runJudge as defaultRunJudge, type JudgeOptions, type JudgeVerdict } from "./judge.js";
import { aggregatePoll, type PollResult, type PollFinalVerdict } from "./poll-aggregator.js";
import type { ChainBaselineEntry } from "./seed-loader.js";

export type RunJudgeFn = (opts: JudgeOptions) => Promise<JudgeVerdict>;

export type JudgingMode = "per_step" | "outcome" | "gate_bypass";

export interface ChainStepVerdict {
  step: number;
  agent: string;
  is_gate: boolean;
  poll: PollResult;
}

export interface ChainRunVerdict {
  /** Per-step PoLL outcomes when judging_mode === "per_step"; single
   *  synthesized step when "outcome"; empty when "gate_bypass". */
  steps: ChainStepVerdict[];
  /** Run-level verdict — feeds aggregatePassK unmodified. */
  final: PollFinalVerdict;
  /** Which judging strategy ran. Drives forensic rendering. */
  judging_mode: JudgingMode;
  /** Identifies the regressing step for forensic display when final = regress. */
  weakest_step?: { step: number; agent: string; reason: string };
  /** Human-readable summary; renders in scorecards and audit-quality output. */
  evidence_summary: string;
  /** Sum of judge costs across all steps. Codex steps contribute 0 today. */
  judge_cost_usd: number;
}

export interface JudgeChainRunOpts {
  baseline: ChainBaselineEntry[];
  candidate: ChainBaselineEntry[];
  /** The seed's resolved prompt — sent to each judge as task context. */
  prompt: string;
  /** Seed shape — used by the judge for calibration-anchor selection. */
  shape: string;
  /** Optional override for unit tests. Defaults to production runJudge. */
  runJudge?: RunJudgeFn;
}

/**
 * Detect whether a safety gate present in baseline is missing in candidate.
 * Gates are entries with `is_gate=true`, set during capture for the
 * deterministically-injected POST_CHAIN_GATES (reviewer + tester after
 * builder). A baseline gate that's absent from candidate's agent set is
 * a real safety violation independent of output quality.
 */
function detectGateBypass(
  baseline: ChainBaselineEntry[],
  candidate: ChainBaselineEntry[],
): { missing: string[]; reason: string } | null {
  const baselineGates = baseline.filter((e) => e.is_gate).map((e) => e.agent);
  if (baselineGates.length === 0) return null;
  const candidateAgents = new Set(candidate.map((e) => e.agent));
  const missing = baselineGates.filter((g) => !candidateAgents.has(g));
  if (missing.length === 0) return null;
  return {
    missing,
    reason: `safety gate(s) bypassed in candidate: ${missing.join(", ")} present in baseline but absent in candidate`,
  };
}

/**
 * Strict structural alignment check. Used only to pick judging mode.
 * Same length AND same agent at every index → routes align.
 */
function routesAlign(
  baseline: ChainBaselineEntry[],
  candidate: ChainBaselineEntry[],
): boolean {
  if (baseline.length !== candidate.length) return false;
  for (let i = 0; i < baseline.length; i++) {
    if (baseline[i].agent !== candidate[i].agent) return false;
  }
  return true;
}

/**
 * Render a chain into a single human-readable text block for outcome-mode
 * judging. Each step gets a header so the judge can identify which agent
 * said what; the routing structure itself is visible to the judge in case
 * the path difference matters for the verdict.
 */
function chainToText(chain: ChainBaselineEntry[]): string {
  return chain
    .map((e) => `### Step ${e.step} — ${e.agent}${e.is_gate ? " (post-chain gate)" : ""}\n\n${e.response}`)
    .join("\n\n---\n\n");
}

/**
 * Collapse per-step PoLLs into a single run-level verdict. Worst-step-wins
 * precedence (mirrors the rubric's bias toward false-flag over false-pass).
 */
function aggregateChainRun(
  steps: ChainStepVerdict[],
): { final: PollFinalVerdict; weakest_step?: { step: number; agent: string; reason: string } } {
  if (steps.length === 0) return { final: "judge_failure" };

  const firstRegress = steps.find((s) => s.poll.final === "regress");
  if (firstRegress) {
    return {
      final: "regress",
      weakest_step: {
        step: firstRegress.step,
        agent: firstRegress.agent,
        reason: firstRegress.poll.evidence_summary || "regress",
      },
    };
  }

  const firstDisagreement = steps.find((s) => s.poll.final === "disagreement");
  if (firstDisagreement) {
    return {
      final: "disagreement",
      weakest_step: {
        step: firstDisagreement.step,
        agent: firstDisagreement.agent,
        reason: firstDisagreement.poll.evidence_summary || "judges split",
      },
    };
  }

  if (steps.every((s) => s.poll.final === "judge_failure")) {
    return { final: "judge_failure" };
  }

  const firstUnclear = steps.find(
    (s) => s.poll.final === "unclear" || s.poll.final === "judge_failure",
  );
  if (firstUnclear) {
    return {
      final: "unclear",
      weakest_step: {
        step: firstUnclear.step,
        agent: firstUnclear.agent,
        reason: firstUnclear.poll.evidence_summary || "unclear",
      },
    };
  }

  return { final: "pass" };
}

function summarizeSteps(steps: ChainStepVerdict[]): string {
  return steps
    .map((s) => `step ${s.step} (${s.agent}${s.is_gate ? " gate" : ""})=${s.poll.final}`)
    .join("; ");
}

async function judgePerStep(
  opts: JudgeChainRunOpts,
  runJudge: RunJudgeFn,
): Promise<ChainRunVerdict> {
  const { baseline, candidate, prompt, shape } = opts;
  const stepVerdicts: ChainStepVerdict[] = [];
  let totalJudgeCostUsd = 0;

  for (let i = 0; i < baseline.length; i++) {
    const baseStep = baseline[i];
    const candStep = candidate[i];
    const [sonnet, codex] = await Promise.all([
      runJudge({
        judge: "sonnet",
        agentRole: baseStep.agent,
        shape,
        baselineOutput: baseStep.response,
        candidateOutput: candStep.response,
        prompt,
      }),
      runJudge({
        judge: "codex",
        agentRole: baseStep.agent,
        shape,
        baselineOutput: baseStep.response,
        candidateOutput: candStep.response,
        prompt,
      }),
    ]);
    if (typeof sonnet.costUsd === "number") totalJudgeCostUsd += sonnet.costUsd;
    if (typeof codex.costUsd === "number") totalJudgeCostUsd += codex.costUsd;
    stepVerdicts.push({
      step: i,
      agent: baseStep.agent,
      is_gate: baseStep.is_gate,
      poll: aggregatePoll([sonnet, codex]),
    });
  }

  const aggregate = aggregateChainRun(stepVerdicts);
  return {
    steps: stepVerdicts,
    final: aggregate.final,
    judging_mode: "per_step",
    weakest_step: aggregate.weakest_step,
    evidence_summary: summarizeSteps(stepVerdicts),
    judge_cost_usd: round4(totalJudgeCostUsd),
  };
}

async function judgeOutcome(
  opts: JudgeChainRunOpts,
  runJudge: RunJudgeFn,
): Promise<ChainRunVerdict> {
  const { baseline, candidate, prompt, shape } = opts;
  const baselineText = chainToText(baseline);
  const candidateText = chainToText(candidate);
  // agentRole "chain" tells the judge it's looking at a multi-agent chain
  // output. Calibration-anchor selection (judge.ts:loadCalibrationAnchors)
  // scores by agent_role match, so anchors tagged "chain" will preferentially
  // surface here once any are populated. Today calibration is empty, so this
  // tag is just for future calibration coverage.
  const baselineRoute = baseline.map((e) => e.agent).join(" → ");
  const candidateRoute = candidate.map((e) => e.agent).join(" → ");
  const augmentedPrompt =
    `${prompt}\n\n[chain context: baseline route was "${baselineRoute}"; candidate route was "${candidateRoute}". Judge whether the candidate's combined output covers the same ground as baseline at comparable quality. Routing path differences are flaggable only if they materially affected output coverage or quality.]`;

  const [sonnet, codex] = await Promise.all([
    runJudge({
      judge: "sonnet",
      agentRole: "chain",
      shape,
      baselineOutput: baselineText,
      candidateOutput: candidateText,
      prompt: augmentedPrompt,
    }),
    runJudge({
      judge: "codex",
      agentRole: "chain",
      shape,
      baselineOutput: baselineText,
      candidateOutput: candidateText,
      prompt: augmentedPrompt,
    }),
  ]);
  const judgeCostUsd =
    (typeof sonnet.costUsd === "number" ? sonnet.costUsd : 0) +
    (typeof codex.costUsd === "number" ? codex.costUsd : 0);
  const poll = aggregatePoll([sonnet, codex]);
  // Synthesize a single "chain" step so downstream rendering still has
  // something to display; per-step detail isn't available in this mode.
  const synthStep: ChainStepVerdict = {
    step: 0,
    agent: "chain",
    is_gate: false,
    poll,
  };
  return {
    steps: [synthStep],
    final: poll.final,
    judging_mode: "outcome",
    weakest_step:
      poll.final === "regress" || poll.final === "unclear" || poll.final === "disagreement"
        ? { step: 0, agent: "chain", reason: poll.evidence_summary || poll.final }
        : undefined,
    evidence_summary: `outcome-mode (route diverged: baseline ${baselineRoute} vs candidate ${candidateRoute}); ${poll.evidence_summary}`,
    judge_cost_usd: round4(judgeCostUsd),
  };
}

export async function judgeChainRun(opts: JudgeChainRunOpts): Promise<ChainRunVerdict> {
  const { baseline, candidate } = opts;
  const runJudge = opts.runJudge ?? defaultRunJudge;

  // 1. Deterministic safety check first — overrides everything else.
  const bypass = detectGateBypass(baseline, candidate);
  if (bypass) {
    return {
      steps: [],
      final: "regress",
      judging_mode: "gate_bypass",
      weakest_step: { step: -1, agent: bypass.missing[0], reason: `gate ${bypass.missing[0]} did not fire` },
      evidence_summary: bypass.reason,
      judge_cost_usd: 0,
    };
  }

  // 2. Routes align → per-step PoLL judging (lossless diagnostic).
  // 3. Routes diverge but no gate bypass → outcome-mode judging (let the
  //    LLM decide whether the path difference mattered).
  return routesAlign(baseline, candidate)
    ? judgePerStep(opts, runJudge)
    : judgeOutcome(opts, runJudge);
}

/**
 * Convert a ChainRunVerdict into the PollResult shape that aggregatePassK
 * consumes. Per-step detail lives on ChainRunVerdict.steps[] for forensic
 * rendering; the Pass^k layer doesn't need it.
 */
export function chainVerdictToPollResult(verdict: ChainRunVerdict): PollResult {
  return {
    judges: [],
    final: verdict.final,
    disagreement: verdict.final === "disagreement",
    evidence_summary: verdict.evidence_summary,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
