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

import { writeFileSync, renameSync } from "fs";
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

  for (let i = 0; i < NUM_RUNS_PER_SEED; i++) {
    const agentResult = await runAgent({
      runtime,
      agentName: agentRole,
      prompt,
      channelId: TIER2_CHANNEL_ID,
    });

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
  };
}

async function main(): Promise<void> {
  const seeds = loadSeeds();
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
  }

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

  const report: RunReport = {
    run_at: new Date().toISOString(),
    rubric_version: 2,
    harness_version: 1,
    total_seeds: seeds.length,
    evaluated_seeds: evaluated.length,
    num_runs_per_seed: NUM_RUNS_PER_SEED,
    outcome,
    seeds: results,
  };

  emitReport(report);
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
