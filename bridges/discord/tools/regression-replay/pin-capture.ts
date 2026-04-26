// Capture a pin for a seed. Runs context assembly under the current
// harness with the user-supplied parameters, records the result as the
// new baseline, and updates the seed's current_pin reference.
//
// By default, also runs the agent end-to-end and captures its response
// as part of the baseline (required for tier 2). Pass --no-agent-run to
// capture only the context block (tier 1 only; not recommended).
//
// Usage:
//   HARNESS_ROOT=$(pwd) npx tsx \
//     bridges/discord/tools/regression-replay/pin-capture.ts \
//     <seed-id> [--param key=value ...] [--no-agent-run]
//
// Example:
//   ... pin-capture.ts shape-01 --param topic="distributed systems"

import { assembleContext } from "../../context-assembler.js";
import { extractMetrics } from "./metrics.js";
import {
  loadSeed,
  resolvePrompt,
  saveBaseline,
  updateSeedPin,
  type Baseline,
} from "./seed-loader.js";
import { runAgent, type Runtime } from "./spawn-helper.js";

const TIER1_CHANNEL_ID = "regression-replay-tier1";
const HARNESS_VERSION = 1;
const RUBRIC_VERSION = 2;

function parseArgs(argv: string[]): {
  seedId: string;
  parameters: Record<string, string>;
  runAgentToo: boolean;
} {
  const args = argv.slice(2);
  if (args.length < 1) {
    console.error(
      "Usage: pin-capture <seed-id> [--param key=value ...] [--no-agent-run]",
    );
    process.exit(2);
  }
  const seedId = args[0];
  const parameters: Record<string, string> = {};
  let runAgentToo = true;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--param") {
      const kv = args[++i];
      const eq = kv.indexOf("=");
      if (eq < 0) {
        console.error(`--param requires key=value form, got: ${kv}`);
        process.exit(2);
      }
      parameters[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (args[i] === "--no-agent-run") {
      runAgentToo = false;
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(2);
    }
  }
  return { seedId, parameters, runAgentToo };
}

async function main(): Promise<void> {
  const { seedId, parameters, runAgentToo } = parseArgs(process.argv);
  const seed = loadSeed(seedId);
  if (!seed) {
    console.error(`Seed not found: ${seedId}`);
    process.exit(1);
  }

  // Validate every parameter slot has a value.
  for (const slot of Object.keys(seed.parameter_slots)) {
    if (!(slot in parameters)) {
      console.error(
        `Missing required parameter: ${slot}\nDescription: ${seed.parameter_slots[slot]}`,
      );
      process.exit(2);
    }
  }

  const prompt = resolvePrompt(seed.prompt_template, parameters);
  const agentName = seed.expected_agents[0] ?? "researcher";
  const runtime = (seed.runtime as Runtime) || "claude";

  console.error(`[pin-capture] Seed: ${seedId} (${seed.shape})`);
  console.error(`[pin-capture] Agent: ${agentName} (${runtime})`);
  console.error(`[pin-capture] Resolved prompt: ${prompt.slice(0, 120)}...`);

  const contextBlock = await assembleContext({
    channelId: TIER1_CHANNEL_ID,
    prompt,
    agentName,
    sessionKey: `${TIER1_CHANNEL_ID}:${seedId}`,
    taskId: `pin-capture-${Date.now()}-${seedId}`,
  });

  const metrics = extractMetrics(contextBlock);
  const capturedAt = new Date().toISOString().slice(0, 10);

  let agentResponse: Baseline["agent_response"] = null;
  if (runAgentToo) {
    console.error(`[pin-capture] Running ${runtime}/${agentName} for baseline output...`);
    const result = await runAgent({
      runtime,
      agentName,
      prompt,
      channelId: TIER1_CHANNEL_ID,
    });
    if (result.ok && result.responseText) {
      agentResponse = {
        text: result.responseText,
        duration_ms: result.durationMs,
      };
      console.error(
        `[pin-capture] Agent response captured: ${result.responseText.length} chars, ${result.durationMs}ms`,
      );
    } else {
      console.error(
        `[pin-capture] WARN: agent run failed (${result.error}); proceeding with context-only baseline`,
      );
    }
  } else {
    console.error("[pin-capture] --no-agent-run set; skipping agent run (tier 2 will not work for this pin)");
  }

  const baseline: Baseline = {
    seed_id: seedId,
    captured_at: capturedAt,
    harness_version: HARNESS_VERSION,
    rubric_version: RUBRIC_VERSION,
    parameters,
    resolved_prompt: prompt,
    channel_id: TIER1_CHANNEL_ID,
    agent_name: agentName,
    runtime,
    context_block: contextBlock,
    metrics,
    agent_response: agentResponse,
  };

  const baselinePath = saveBaseline(baseline);
  updateSeedPin(seedId, {
    baseline_path: baselinePath,
    captured_at: capturedAt,
    harness_version: HARNESS_VERSION,
  });

  console.error(`[pin-capture] Saved baseline: ${baselinePath}`);
  console.error(
    `[pin-capture] Retrieved IDs: ${metrics.retrievedIds.length}, context size: ${metrics.contextSize} chars, sections: ${metrics.sectionCount}`,
  );
  console.error(`[pin-capture] Updated seed ${seedId} current_pin reference.`);
}

main().catch((err) => {
  console.error(
    `[pin-capture] FATAL: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
