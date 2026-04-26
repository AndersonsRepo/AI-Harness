// Tier-1 monitor entry point. For each pinned seed, re-run context
// assembly with the pin's parameters and emit a structural-metrics
// comparison against the baseline. Pure deterministic comparison —
// no LLM judging here. See vault/shared/regression-replay/rubric.md.
//
// Invoked by heartbeat-tasks/scripts/regression-replay-monitor.py.
//
// IPC: context-assembler emits diagnostic logs to stdout during truncation,
// so the report cannot share stdout with assembly. If REPLAY_REPORT_FILE env
// var is set, the JSON envelope is written there atomically. Otherwise it's
// emitted to stdout (suitable for direct human invocation).

import { writeFileSync, renameSync } from "fs";
import { assembleContext } from "../../context-assembler.js";
import {
  compareMetrics,
  extractMetrics,
  overallOutcome,
  type MetricsDelta,
  type StructuralMetrics,
} from "./metrics.js";
import {
  loadSeeds,
  loadBaseline,
  resolvePrompt,
  type Seed,
  type Baseline,
} from "./seed-loader.js";

// Sentinel channel id used for tier-1 replay invocations. Has no project
// or channel-config record, so the assembler returns a "neutral" context
// independent of any active project's volatile state.
const TIER1_CHANNEL_ID = "regression-replay-tier1";
const TIER1_AGENT_DEFAULT = "researcher";

interface SeedResult {
  seed_id: string;
  shape: string;
  status: "ok" | "noted" | "flagged" | "no_pin" | "error";
  pin_captured_at?: string;
  metrics?: StructuralMetrics;
  delta?: MetricsDelta;
  error?: string;
}

interface RunReport {
  run_at: string;
  rubric_version: number;
  harness_version: number;
  total_seeds: number;
  pinned_seeds: number;
  outcome: "ok" | "noted" | "flagged" | "no_pins";
  seeds: SeedResult[];
}

async function evaluateSeed(seed: Seed): Promise<SeedResult> {
  const baseline = loadBaseline(seed.id);
  if (!baseline || !seed.current_pin) {
    return { seed_id: seed.id, shape: seed.shape, status: "no_pin" };
  }

  try {
    const prompt = resolvePrompt(seed.prompt_template, baseline.parameters);
    const agentName = seed.expected_agents[0] ?? TIER1_AGENT_DEFAULT;
    const contextBlock = await assembleContext({
      channelId: TIER1_CHANNEL_ID,
      prompt,
      agentName,
      sessionKey: `${TIER1_CHANNEL_ID}:${seed.id}`,
      taskId: `tier1-${Date.now()}-${seed.id}`,
    });

    const current = extractMetrics(contextBlock);
    const delta = compareMetrics(current, baseline.metrics);
    const status = overallOutcome(delta);

    return {
      seed_id: seed.id,
      shape: seed.shape,
      status,
      pin_captured_at: baseline.captured_at,
      metrics: current,
      delta,
    };
  } catch (err) {
    return {
      seed_id: seed.id,
      shape: seed.shape,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const seeds = loadSeeds();
  const results: SeedResult[] = [];
  for (const seed of seeds) {
    results.push(await evaluateSeed(seed));
  }

  const pinned = results.filter((r) => r.status !== "no_pin");
  const flagged = pinned.some((r) => r.status === "flagged");
  const noted = pinned.some((r) => r.status === "noted");
  const errored = pinned.some((r) => r.status === "error");

  let outcome: RunReport["outcome"] = "no_pins";
  if (pinned.length > 0) {
    if (flagged || errored) outcome = "flagged";
    else if (noted) outcome = "noted";
    else outcome = "ok";
  }

  const report: RunReport = {
    run_at: new Date().toISOString(),
    rubric_version: 2,
    harness_version: 1,
    total_seeds: seeds.length,
    pinned_seeds: pinned.length,
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
    process.stderr.write(`[tier1-monitor] report written to ${out}\n`);
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
