// Chain-aware baseline-capture + replay helpers. Extracted so the logic can be
// unit-tested without triggering CLI side effects. pin-capture.ts (capture
// path) and chain-replay.ts (replay path) are the production callers.

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import {
  executeChainCore,
  NullSink,
  type AgentExecutor,
  type ChainEntry,
  type ExecuteAgentArgs,
  type HandoffResult,
} from "../../handoff-router.js";
import {
  HeadlessAgentExecutor,
  runAgent,
  type Runtime,
  type SpawnAgentResult,
} from "./spawn-helper.js";
import type { Baseline, ChainBaselineEntry, Seed } from "./seed-loader.js";

/**
 * Build a capture-time context block for chain steps past the initial agent.
 *
 * In production, `buildProjectContext` reads recent Discord messages from the
 * channel and injects them. During capture, the channel is fictitious — there
 * is no Discord history, only the chain log accumulating step by step. This
 * helper mirrors `buildProjectContext`'s chain-context branch but skips the
 * Discord fetch.
 */
export function buildCaptureContext(
  seed: Pick<Seed, "id" | "shape" | "expected_agents">,
  toAgent: string,
  chainContext?: { completedPhases: ChainEntry[]; currentTask: string },
): string {
  const lines: string[] = [
    `[Project: ${seed.id} (regression-replay capture)]`,
    `Description: chain capture for shape ${seed.shape}`,
    `Participating agents: ${seed.expected_agents.join(", ")}`,
    `You are the ${toAgent} agent.`,
    "",
  ];
  if (chainContext && chainContext.completedPhases.length > 0) {
    lines.push("--- Completed phases ---");
    for (const entry of chainContext.completedPhases) {
      const truncated = entry.response.length > 300
        ? entry.response.slice(0, 300) + "..."
        : entry.response;
      lines.push(`[${entry.agent}]: ${truncated}`);
    }
    lines.push("--- End ---");
    lines.push("");
  }
  lines.push(
    `Respond as the ${toAgent} agent. When you need another agent's expertise, use [HANDOFF:agent_name] followed by what you need them to do.`,
    `Available agents: ${seed.expected_agents.join(", ")}`,
    `Complete your own work first before handing off.`,
  );
  return lines.join("\n");
}

/**
 * Wraps an AgentExecutor to record per-step wall-clock duration AND the full
 * untruncated response text. The chain primitive truncates ChainEntry
 * responses to 2000 chars (handoff-router.ts:833,895) for debrief efficiency
 * — fine for production, but the regression-replay judge needs full text.
 * We capture both here in invocation order; consumer maps them onto
 * ChainBaselineEntry by step index.
 */
export interface RecordedStep {
  agent: string;
  fullResponse: string;
  duration_ms: number;
}

export class TimingExecutor implements AgentExecutor {
  readonly steps: RecordedStep[] = [];
  constructor(private readonly inner: AgentExecutor) {}
  async execute(args: ExecuteAgentArgs): Promise<HandoffResult | null> {
    const startedAt = Date.now();
    const result = await this.inner.execute(args);
    if (result) {
      this.steps.push({
        agent: result.agentName,
        fullResponse: result.response,
        duration_ms: Date.now() - startedAt,
      });
    }
    return result;
  }
}

export interface ChainCapture {
  initialAgent: string;
  initialResponse: string;
  initialDurationMs: number;
  chainEntries: ChainEntry[];
  recordedSteps: RecordedStep[];
  // Per-step costs in invocation order matching recordedSteps[]. Initial
  // agent cost is not in this array; it lives on initialAgentCostUsd.
  // Codex steps stay 0 because codex-runner doesn't surface cost yet.
  recordedStepCostsUsd: number[];
  initialAgentCostUsd: number;
}

export async function captureChainBaseline(
  seed: Seed,
  prompt: string,
  runtime: Runtime,
  channelId: string,
  opts?: { logPrefix?: string },
): Promise<ChainCapture | null> {
  const logPrefix = opts?.logPrefix ?? "[pin-capture]";
  const initialAgent = seed.expected_agents[0];
  console.error(`${logPrefix} Chain shape detected (${seed.expected_agents.length} expected agents). Driving end-to-end.`);
  console.error(`${logPrefix} Initial agent: ${runtime}/${initialAgent}`);

  const initialStart = Date.now();
  const initialResult = await runAgent({
    runtime,
    agentName: initialAgent,
    prompt,
    channelId,
  });
  const initialDurationMs = Date.now() - initialStart;

  if (!initialResult.ok || !initialResult.responseText) {
    console.error(`${logPrefix} FAIL: initial agent ${initialAgent} returned no response: ${initialResult.error ?? "(unknown)"}`);
    return null;
  }
  console.error(`${logPrefix} Initial response: ${initialResult.responseText.length} chars, ${initialDurationMs}ms`);

  const recordedStepCostsUsd: number[] = [];
  const headless = new HeadlessAgentExecutor({
    channelId,
    contextBuilder: async (toAgent, chainContext) =>
      buildCaptureContext(seed, toAgent, chainContext),
    onAgentResult: (_agent, result) => {
      recordedStepCostsUsd.push(typeof result.costUsd === "number" ? result.costUsd : 0);
    },
  });
  const timing = new TimingExecutor(headless);

  const chainResult = await executeChainCore({
    channelId,
    sink: new NullSink(),
    executor: timing,
    initialAgent,
    initialResponse: initialResult.responseText,
    originAgent: initialAgent,
  });

  return {
    initialAgent,
    initialResponse: initialResult.responseText,
    initialDurationMs,
    chainEntries: chainResult.entries,
    recordedSteps: timing.steps,
    recordedStepCostsUsd,
    initialAgentCostUsd: typeof initialResult.costUsd === "number" ? initialResult.costUsd : 0,
  };
}

/**
 * Map a ChainCapture onto the ChainBaselineEntry[] persisted in the baseline
 * file. The initial agent's full response comes from the runAgent result;
 * subsequent steps align 1:1 with TimingExecutor.steps in invocation order
 * (the chain loop calls execute() once per step). Stepping through the
 * recorded array by index — not matching by name — handles chains that
 * invoke the same agent twice.
 */
export function buildChainResponses(
  capture: ChainCapture,
  gateAgents: ReadonlySet<string>,
): ChainBaselineEntry[] {
  let recordedIdx = 0;
  return capture.chainEntries.map((entry, idx): ChainBaselineEntry => {
    if (idx === 0) {
      return {
        agent: entry.agent,
        response: capture.initialResponse,
        duration_ms: capture.initialDurationMs,
        step: idx,
        is_gate: false,
      };
    }
    const recorded = capture.recordedSteps[recordedIdx++];
    return {
      agent: entry.agent,
      response: recorded?.fullResponse ?? entry.response,
      duration_ms: recorded?.duration_ms ?? 0,
      step: idx,
      is_gate: gateAgents.has(entry.agent),
    };
  });
}

export const POST_CHAIN_GATE_AGENTS: ReadonlySet<string> = new Set(["reviewer", "tester"]);

// ─── Replay Driver ─────────────────────────────────────────────────────
//
// Runs a chain seed N times against the headless executor and persists
// each run's per-step output for forensic inspection. Intentionally does
// NOT judge — judging belongs to A1.3 (chain-judge + tier-2 dispatch).

export interface ChainReplayRun {
  /** 0-based index within the replay batch. */
  run_index: number;
  status: "ok" | "agent_error";
  /** Per-step responses captured by the chain log + TimingExecutor. */
  chain_responses: ChainBaselineEntry[];
  /** Path relative to REPLAY_ROOT, e.g. "runs/candidates/2026-04-29-shape-04-run-1-chain.json". */
  candidate_path: string;
  duration_ms: number;
  /** Sum of initial agent + per-step costs (Claude only; codex steps contribute 0). */
  agent_cost_usd: number;
  error?: string;
}

export interface ChainReplayResult {
  seed_id: string;
  shape: string;
  baseline_path: string;
  num_runs: number;
  runs: ChainReplayRun[];
  total_duration_ms: number;
  total_agent_cost_usd: number;
}

export interface ReplayChainOpts {
  seed: Seed;
  baseline: Baseline;
  numRuns: number;
  channelId: string;
  /** Absolute directory where per-run candidate files are written. */
  candidatesDir: string;
  /** Used to compose a forensic-friendly filename; defaults to today. */
  capturedDate?: string;
}

export function persistChainCandidate(
  candidatesDir: string,
  candidatesRelRoot: string,
  seedId: string,
  runIdx: number,
  date: string,
  chainResponses: ChainBaselineEntry[],
): string {
  if (!existsSync(candidatesDir)) mkdirSync(candidatesDir, { recursive: true });
  const filename = `${date}-${seedId}-run-${runIdx + 1}-chain.json`;
  const fullPath = join(candidatesDir, filename);
  writeFileSync(fullPath, JSON.stringify(chainResponses, null, 2), "utf-8");
  return `${candidatesRelRoot}/${filename}`;
}

export async function replayChain(opts: ReplayChainOpts): Promise<ChainReplayResult> {
  const { seed, baseline, numRuns, channelId, candidatesDir } = opts;
  const date = opts.capturedDate ?? new Date().toISOString().slice(0, 10);
  // The candidates dir is conventionally <REPLAY_ROOT>/runs/candidates;
  // record the relative root form on each run for the scorecard.
  const candidatesRelRoot = "runs/candidates";

  const runtime = (seed.runtime as Runtime) || "claude";
  const prompt = baseline.resolved_prompt;
  const baselinePath = seed.current_pin?.baseline_path ?? "(unknown)";

  const runs: ChainReplayRun[] = [];
  const batchStart = Date.now();
  let totalAgentCostUsd = 0;

  for (let i = 0; i < numRuns; i++) {
    const runStart = Date.now();
    const capture = await captureChainBaseline(seed, prompt, runtime, channelId, {
      logPrefix: `[chain-replay run ${i + 1}/${numRuns}]`,
    });
    const elapsed = Date.now() - runStart;

    if (!capture) {
      runs.push({
        run_index: i,
        status: "agent_error",
        chain_responses: [],
        candidate_path: "",
        duration_ms: elapsed,
        agent_cost_usd: 0,
        error: "initial agent returned no response",
      });
      continue;
    }

    const chainResponses = buildChainResponses(capture, POST_CHAIN_GATE_AGENTS);
    let candidatePath = "";
    try {
      candidatePath = persistChainCandidate(
        candidatesDir,
        candidatesRelRoot,
        seed.id,
        i,
        date,
        chainResponses,
      );
    } catch (e) {
      console.error(`[chain-replay] WARN: failed to persist candidate for run ${i + 1}: ${(e as Error).message}`);
    }

    const stepCostSum = capture.recordedStepCostsUsd.reduce((s, c) => s + c, 0);
    const runCost = capture.initialAgentCostUsd + stepCostSum;
    totalAgentCostUsd += runCost;

    runs.push({
      run_index: i,
      status: "ok",
      chain_responses: chainResponses,
      candidate_path: candidatePath,
      duration_ms: elapsed,
      agent_cost_usd: round4(runCost),
    });
  }

  return {
    seed_id: seed.id,
    shape: seed.shape,
    baseline_path: baselinePath,
    num_runs: numRuns,
    runs,
    total_duration_ms: Date.now() - batchStart,
    total_agent_cost_usd: round4(totalAgentCostUsd),
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
