// Capture a pin for a seed. Runs context assembly under the current
// harness with the user-supplied parameters, records the result as the
// new baseline, and updates the seed's current_pin reference.
//
// Usage:
//   HARNESS_ROOT=$(pwd) npx tsx \
//     bridges/discord/tools/regression-replay/pin-capture.ts \
//     <seed-id> [--param key=value ...]
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

const TIER1_CHANNEL_ID = "regression-replay-tier1";
const HARNESS_VERSION = 1;
const RUBRIC_VERSION = 2;

function parseArgs(argv: string[]): {
  seedId: string;
  parameters: Record<string, string>;
} {
  const args = argv.slice(2);
  if (args.length < 1) {
    console.error(
      "Usage: pin-capture <seed-id> [--param key=value ...]",
    );
    process.exit(2);
  }
  const seedId = args[0];
  const parameters: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--param") {
      const kv = args[++i];
      const eq = kv.indexOf("=");
      if (eq < 0) {
        console.error(`--param requires key=value form, got: ${kv}`);
        process.exit(2);
      }
      parameters[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(2);
    }
  }
  return { seedId, parameters };
}

async function main(): Promise<void> {
  const { seedId, parameters } = parseArgs(process.argv);
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

  console.error(`[pin-capture] Seed: ${seedId} (${seed.shape})`);
  console.error(`[pin-capture] Agent: ${agentName}`);
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

  const baseline: Baseline = {
    seed_id: seedId,
    captured_at: capturedAt,
    harness_version: HARNESS_VERSION,
    rubric_version: RUBRIC_VERSION,
    parameters,
    resolved_prompt: prompt,
    channel_id: TIER1_CHANNEL_ID,
    agent_name: agentName,
    context_block: contextBlock,
    metrics,
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
