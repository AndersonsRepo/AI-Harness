// Tier-2 monitor entry point. For each pinned seed:
//   1. Run the agent N times (default N=3) at T=0 with the seed's resolved prompt
//   2. For each run: judge candidate vs baseline using PoLL (Sonnet + Codex)
//   3. Aggregate per-run PoLL verdicts into Pass^k final
// Emit a JSON envelope with per-seed results.
//
// Cost: ~30 agent runs + ~60 judge calls per weekly invocation across 10 seeds.
// Heavy. Designed to run once per week, not on every commit.
//
// Invoked by heartbeat-tasks/scripts/regression-replay-weekly.py.
// IPC: writes JSON to REPLAY_REPORT_FILE (env var), same pattern as tier 1.

import { writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { runAgent } from "./spawn-helper.js";
import { runJudge } from "./judge.js";
import { aggregatePoll, type PollResult } from "./poll-aggregator.js";
import { aggregatePassK, type PassKResult } from "./passk-aggregator.js";
import {
  loadSeeds,
  loadBaseline,
  resolvePrompt,
  type Seed,
  type Baseline,
} from "./seed-loader.js";

const HARNESS_ROOT = process.env.HARNESS_ROOT ?? process.cwd();
const REPLAY_ROOT = join(HARNESS_ROOT, "vault", "shared", "regression-replay");
const CANDIDATES_DIR = join(REPLAY_ROOT, "runs", "candidates");

const TIER2_CHANNEL_ID = "regression-replay-tier2";
const NUM_RUNS_PER_SEED = parseInt(
  process.env.REPLAY_NUM_RUNS ?? "3",
  10,
);

interface SeedResult {
  seed_id: string;
  shape: string;
  status:
    | "pass"
    | "regress"
    | "flaky_unclear"
    | "flaky_regression"
    | "judge_failure"
    | "no_pin"
    | "no_baseline_output"
    | "agent_error"
    | "skipped";
  passk?: PassKResult;
  per_run_polls?: PollResult[];
  errors?: string[];
  total_duration_ms?: number;
  // Paths to candidate output files relative to REPLAY_ROOT (one per run, in order).
  // Allows forensic inspection of what the agent actually said vs the baseline.
  candidate_paths?: string[];
  // Cost breakdown for this seed across all runs and judges.
  cost?: {
    agent_cost_usd: number;
    judge_cost_usd: number;
    total_usd: number;
  };
}

interface RunReport {
  run_at: string;
  rubric_version: number;
  harness_version: number;
  total_seeds: number;
  evaluated_seeds: number;
  num_runs_per_seed: number;
  outcome:
    | "ok"
    | "regress"
    | "flaky"
    | "disagreement"
    | "no_pins"
    | "judge_failure";
  seeds: SeedResult[];
  seed_filter: string[] | null;
  // True when the report was emitted before the run completed (incremental
  // checkpoint). Python wrapper renders with a "partial run" warning.
  partial: boolean;
  selected_seed_count: number;
  total_cost_usd: number;
}

function persistCandidate(
  seedId: string,
  runIndex: number,
  text: string,
): string {
  if (!existsSync(CANDIDATES_DIR)) {
    mkdirSync(CANDIDATES_DIR, { recursive: true });
  }
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${date}-${seedId}-run-${runIndex + 1}.txt`;
  const fullPath = join(CANDIDATES_DIR, filename);
  writeFileSync(fullPath, text, "utf-8");
  // Return path relative to REPLAY_ROOT for the scorecard.
  return `runs/candidates/${filename}`;
}

async function evaluateSeed(seed: Seed): Promise<SeedResult> {
  const baseline = loadBaseline(seed.id);
  if (!baseline || !seed.current_pin) {
    return { seed_id: seed.id, shape: seed.shape, status: "no_pin" };
  }
  if (!baseline.agent_response) {
    return {
      seed_id: seed.id,
      shape: seed.shape,
      status: "no_baseline_output",
      errors: ["baseline lacks agent_response — re-run pin-capture without --no-agent-run"],
    };
  }

  const startedAt = Date.now();
  const prompt = resolvePrompt(seed.prompt_template, baseline.parameters);
  const agentRole = seed.expected_agents[0] ?? "researcher";
  const runtime = (seed.runtime as "claude" | "codex") || "claude";
  const errors: string[] = [];
  const perRunPolls: PollResult[] = [];
  const candidatePaths: string[] = [];
  let agentCostUsd = 0;
  let judgeCostUsd = 0;

  for (let i = 0; i < NUM_RUNS_PER_SEED; i++) {
    const agentResult = await runAgent({
      runtime,
      agentName: agentRole,
      prompt,
      channelId: TIER2_CHANNEL_ID,
    });
    if (typeof agentResult.costUsd === "number") {
      agentCostUsd += agentResult.costUsd;
    }

    if (!agentResult.ok || !agentResult.responseText) {
      errors.push(
        `run ${i + 1}: agent failed (${agentResult.error ?? "no response"})`,
      );
      // Still record a placeholder PoLL result so Pass^k aggregation sees N runs.
      perRunPolls.push({
        judges: [],
        final: "judge_failure",
        disagreement: false,
        evidence_summary: `agent run failed: ${agentResult.error ?? "no response"}`,
      });
      continue;
    }

    // Persist candidate text for forensic inspection. Even pass-verdict runs
    // are kept — useful for tracking output drift over time. A separate
    // retention job can rotate these later.
    try {
      const candidatePath = persistCandidate(
        seed.id,
        i,
        agentResult.responseText,
      );
      candidatePaths.push(candidatePath);
    } catch (e) {
      errors.push(
        `run ${i + 1}: failed to persist candidate (${(e as Error).message})`,
      );
    }

    // PoLL judging — Sonnet + Codex, in parallel.
    const [sonnetVerdict, codexVerdict] = await Promise.all([
      runJudge({
        judge: "sonnet",
        agentRole,
        shape: seed.shape,
        baselineOutput: baseline.agent_response.text,
        candidateOutput: agentResult.responseText,
        prompt,
      }),
      runJudge({
        judge: "codex",
        agentRole,
        shape: seed.shape,
        baselineOutput: baseline.agent_response.text,
        candidateOutput: agentResult.responseText,
        prompt,
      }),
    ]);
    if (typeof sonnetVerdict.costUsd === "number") {
      judgeCostUsd += sonnetVerdict.costUsd;
    }
    if (typeof codexVerdict.costUsd === "number") {
      judgeCostUsd += codexVerdict.costUsd;
    }

    const poll = aggregatePoll([sonnetVerdict, codexVerdict]);
    perRunPolls.push(poll);
  }

  const passk = aggregatePassK(perRunPolls);
  const status = passk.final;

  return {
    seed_id: seed.id,
    shape: seed.shape,
    status,
    passk,
    per_run_polls: perRunPolls,
    errors: errors.length > 0 ? errors : undefined,
    total_duration_ms: Date.now() - startedAt,
    candidate_paths: candidatePaths.length > 0 ? candidatePaths : undefined,
    cost: {
      agent_cost_usd: round4(agentCostUsd),
      judge_cost_usd: round4(judgeCostUsd),
      total_usd: round4(agentCostUsd + judgeCostUsd),
    },
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function parseSeedFilter(argv: string[]): string[] | null {
  // --seed shape-01,shape-03  → restrict run to those seeds
  // --seed shape-01           → single seed
  // (none)                    → all seeds
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--seed" && i + 1 < argv.length) {
      return argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return null;
}

async function main(): Promise<void> {
  const allSeeds = loadSeeds();
  const filter = parseSeedFilter(process.argv);
  const seeds = filter
    ? allSeeds.filter((s) => filter.includes(s.id))
    : allSeeds;

  if (filter && seeds.length === 0) {
    process.stderr.write(
      `[tier2-monitor] --seed filter '${filter.join(",")}' matched no seeds\n`,
    );
  }
  if (filter) {
    process.stderr.write(
      `[tier2-monitor] running ${seeds.length} of ${allSeeds.length} seeds (filter: ${filter.join(",")})\n`,
    );
  }

  const results: SeedResult[] = [];

  for (const seed of seeds) {
    process.stderr.write(
      `[tier2-monitor] evaluating ${seed.id} (${seed.shape})...\n`,
    );
    const result = await evaluateSeed(seed);
    process.stderr.write(
      `[tier2-monitor] ${seed.id} → ${result.status}` +
        (result.passk ? ` (pass^${NUM_RUNS_PER_SEED} ${result.passk.pass_count}/${result.passk.total_runs})` : "") +
        "\n",
    );
    results.push(result);
    // Incremental checkpoint: write the report after each seed so a crash
    // mid-run still leaves usable signal on disk. The partial flag tells the
    // Python wrapper that not every seed has completed yet.
    emitReport(
      buildReport(allSeeds, seeds, results, /*partial=*/ true, filter),
    );
  }

  emitReport(buildReport(allSeeds, seeds, results, /*partial=*/ false, filter));
}

function buildReport(
  allSeeds: Seed[],
  selected: Seed[],
  results: SeedResult[],
  partial: boolean,
  filter: string[] | null,
): RunReport {
  const evaluated = results.filter(
    (r) =>
      r.status !== "no_pin" &&
      r.status !== "no_baseline_output" &&
      r.status !== "skipped",
  );
  const anyRegress = evaluated.some(
    (r) => r.status === "regress" || r.status === "flaky_regression",
  );
  const anyFlaky = evaluated.some(
    (r) => r.status === "flaky_unclear" || r.status === "flaky_regression",
  );
  const anyDisagreement = evaluated.some((r) =>
    r.per_run_polls?.some((p) => p.disagreement),
  );
  const anyJudgeFailure = evaluated.some((r) => r.status === "judge_failure");

  let outcome: RunReport["outcome"] = "no_pins";
  if (evaluated.length > 0) {
    if (anyRegress) outcome = "regress";
    else if (anyFlaky) outcome = "flaky";
    else if (anyDisagreement) outcome = "disagreement";
    else if (anyJudgeFailure) outcome = "judge_failure";
    else outcome = "ok";
  }

  const totalCost = evaluated.reduce(
    (acc, r) => acc + (r.cost?.total_usd ?? 0),
    0,
  );

  return {
    run_at: new Date().toISOString(),
    rubric_version: 2,
    harness_version: 1,
    total_seeds: allSeeds.length,
    evaluated_seeds: evaluated.length,
    num_runs_per_seed: NUM_RUNS_PER_SEED,
    outcome,
    seeds: results,
    seed_filter: filter,
    partial,
    selected_seed_count: selected.length,
    total_cost_usd: round4(totalCost),
  };
}

function emitReport(report: unknown): void {
  const json = JSON.stringify(report, null, 2);
  const out = process.env.REPLAY_REPORT_FILE;
  if (out) {
    const tmp = `${out}.tmp`;
    writeFileSync(tmp, json + "\n", "utf-8");
    renameSync(tmp, out);
    process.stderr.write(`[tier2-monitor] report written to ${out}\n`);
  } else {
    process.stdout.write(json + "\n");
  }
}

main().catch((err) => {
  emitReport({
    run_at: new Date().toISOString(),
    outcome: "error",
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
