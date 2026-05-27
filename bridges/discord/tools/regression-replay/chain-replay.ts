// Chain replay CLI. For chain seeds (expected_agents.length > 1), drives the
// chain N times against the headless executor and emits a JSON replay result.
// Per-run candidate output is persisted to vault/shared/regression-replay/runs/
// candidates/ for forensic inspection.
//
// This is the driver only — no judging. Tier-2 weekly monitoring + PoLL +
// Pass^k aggregation for chain seeds is wired separately (A1.3).
//
// Usage:
//   HARNESS_ROOT=$(pwd) npx tsx \
//     bridges/discord/tools/regression-replay/chain-replay.ts \
//     <seed-id> [--runs N]
//
// The result JSON is written to REPLAY_REPORT_FILE if set, else stdout.

import { join } from "path";
import { writeFileSync, renameSync } from "fs";
import { loadSeed, loadBaseline, getReplayRoot } from "./seed-loader.js";
import { replayChain, type ChainReplayResult } from "./chain-baseline.js";

const TIER2_CHANNEL_ID = "regression-replay-tier2";
const DEFAULT_RUNS = parseInt(process.env.REPLAY_NUM_RUNS ?? "3", 10);

function parseArgs(argv: string[]): { seedId: string; numRuns: number } {
  const args = argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: chain-replay <seed-id> [--runs N]");
    process.exit(2);
  }
  const seedId = args[0];
  let numRuns = DEFAULT_RUNS;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--runs" && i + 1 < args.length) {
      numRuns = parseInt(args[++i], 10);
      if (!Number.isFinite(numRuns) || numRuns < 1) {
        console.error(`--runs must be a positive integer, got: ${args[i]}`);
        process.exit(2);
      }
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(2);
    }
  }
  return { seedId, numRuns };
}

function emitResult(result: ChainReplayResult | { error: string }): void {
  const json = JSON.stringify(result, null, 2);
  const out = process.env.REPLAY_REPORT_FILE;
  if (out) {
    const tmp = `${out}.tmp`;
    writeFileSync(tmp, json + "\n", "utf-8");
    renameSync(tmp, out);
    console.error(`[chain-replay] result written to ${out}`);
  } else {
    process.stdout.write(json + "\n");
  }
}

async function main(): Promise<void> {
  const { seedId, numRuns } = parseArgs(process.argv);
  const seed = loadSeed(seedId);
  if (!seed) {
    emitResult({ error: `Seed not found: ${seedId}` });
    process.exit(1);
  }
  if (seed.expected_agents.length < 2) {
    emitResult({
      error: `Seed ${seedId} is single-agent (expected_agents.length=${seed.expected_agents.length}). Use tier2-monitor for single-agent replay.`,
    });
    process.exit(1);
  }
  const baseline = loadBaseline(seedId);
  if (!baseline) {
    emitResult({ error: `Seed ${seedId} has no current pin / baseline` });
    process.exit(1);
  }
  if (!baseline.chain_responses || baseline.chain_responses.length === 0) {
    emitResult({
      error: `Seed ${seedId} baseline lacks chain_responses — re-run pin-capture`,
    });
    process.exit(1);
  }

  const candidatesDir = join(getReplayRoot(), "runs", "candidates");
  console.error(`[chain-replay] Seed: ${seedId} (${seed.shape}), runs: ${numRuns}`);
  console.error(`[chain-replay] Baseline chain depth: ${baseline.chain_responses.length} steps`);

  const result = await replayChain({
    seed,
    baseline,
    numRuns,
    channelId: TIER2_CHANNEL_ID,
    candidatesDir,
  });

  console.error(
    `[chain-replay] Done: ${result.runs.length} runs, ${result.runs.filter((r) => r.status === "ok").length} ok, ` +
      `total $${result.total_agent_cost_usd}, ${(result.total_duration_ms / 1000).toFixed(1)}s`,
  );
  emitResult(result);
}

main().catch((err) => {
  emitResult({ error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
