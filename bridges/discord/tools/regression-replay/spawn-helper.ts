// Programmatic agent spawn helper for tier-2 replay and judging.
//
// Wraps claude-runner.py / codex-runner.py via subprocess so we can run a
// single agent invocation end-to-end and capture the response text. Reuses
// the same buildClaudeConfig / buildCodexConfig that the bot uses, so the
// spawn behaves like a real Discord task spawn would.

import { spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { getAdapter } from "../../runtime-adapter.js";
import {
  parseHandoff,
  buildHandoffPrompt,
  resolveHandoffRuntime,
  type AgentExecutor,
  type ChainEntry,
  type ExecuteAgentArgs,
  type HandoffResult,
} from "../../handoff-router.js";

const HARNESS_ROOT = process.env.HARNESS_ROOT ?? process.cwd();
const TEMP_DIR = join(HARNESS_ROOT, "bridges", "discord", ".tmp");

export type Runtime = "claude" | "codex";

const RUNNER_PATHS: Record<Runtime, string> = {
  claude: join(HARNESS_ROOT, "bridges", "discord", "claude-runner.py"),
  codex: join(HARNESS_ROOT, "bridges", "discord", "codex-runner.py"),
};

const validatedRunners = new Set<Runtime>();

// Verify the runner script exists before we hand it to python3. Without this,
// a misconfigured HARNESS_ROOT or a moved runner surfaces as opaque python
// exit code 2 with stderr buried in SpawnAgentResult.error — across a 10-seed
// replay run, that's a long debugging detour for a config issue.
function validateRunnerPath(runtime: Runtime): void {
  if (validatedRunners.has(runtime)) return;
  const path = RUNNER_PATHS[runtime];
  if (!existsSync(path)) {
    throw new Error(
      `regression-replay: ${runtime}-runner.py not found at ${path}. ` +
        `HARNESS_ROOT=${HARNESS_ROOT}. ` +
        `Either set HARNESS_ROOT to the AI-Harness repo root, or restore the runner.`,
    );
  }
  validatedRunners.add(runtime);
}

export interface SpawnAgentOptions {
  runtime: Runtime;
  agentName: string;
  prompt: string;
  channelId: string;
  // Hard upper bound — the runner has its own retry loop; this is the
  // outer wall-clock cap. Default 5 min for replay.
  timeoutMs?: number;
}

export interface SpawnAgentResult {
  ok: boolean;
  responseText: string | null;
  durationMs: number;
  rawOutputPath?: string;
  error?: string;
  // Cost in USD if the runner reported it. claude-runner output has
  // `total_cost_usd` in the inner result; codex-runner does not currently
  // surface cost directly so this stays undefined for codex.
  costUsd?: number;
}

function extractClaudeCostFromInner(inner: string): number | undefined {
  // The inner stdout is typically a single JSON line for `--output-format json`.
  // Look for total_cost_usd in the parsed structure first, then regex fallback.
  try {
    const parsed = JSON.parse(inner);
    if (typeof parsed?.total_cost_usd === "number") return parsed.total_cost_usd;
  } catch {}
  const m = inner.match(/"total_cost_usd"\s*:\s*([0-9.eE+\-]+)/);
  return m ? parseFloat(m[1]) : undefined;
}

function uniqueRequestId(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function spawnAndWait(
  pythonArgs: string[],
  env: Record<string, string>,
  cwd: string,
  outputFile: string,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("python3", pythonArgs, {
      cwd,
      env,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    // Drain stdout to prevent buffer fill, but don't store.
    proc.stdout?.on("data", () => {});

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {}
      resolve({
        ok: false,
        error: `runner exceeded timeout ${timeoutMs}ms`,
      });
    }, timeoutMs);

    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && existsSync(outputFile)) {
        resolve({ ok: true });
      } else {
        resolve({
          ok: false,
          error: `runner exit ${code}; stderr: ${stderr.slice(-300)}`,
        });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `spawn error: ${err.message}` });
    });
  });
}

export async function runAgent(
  opts: SpawnAgentOptions,
): Promise<SpawnAgentResult> {
  const startedAt = Date.now();
  const { runtime, agentName, prompt, channelId } = opts;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  validateRunnerPath(runtime);

  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
  const requestId = uniqueRequestId(`${runtime}-replay`);
  const outputFile = join(TEMP_DIR, `replay-${requestId}.json`);

  const adapter = getAdapter(runtime);
  const promptFilePath =
    runtime === "codex" ? join(TEMP_DIR, `prompt-${requestId}.txt`) : undefined;

  try {
    const spawnArgs = await adapter.buildSpawnArgs({
      channelId,
      prompt,
      agentName,
      sessionKey: `tier2-replay:${requestId}`,
      taskId: requestId,
      outputFile,
      skipSessionResume: true,
      promptFilePath,
    });
    const result = await spawnAndWait(
      spawnArgs.pythonArgs,
      spawnArgs.env,
      spawnArgs.cwd,
      outputFile,
      timeoutMs,
    );
    if (spawnArgs.promptFilePath) {
      try { unlinkSync(spawnArgs.promptFilePath); } catch {}
    }
    if (!result.ok) {
      return {
        ok: false,
        responseText: null,
        durationMs: Date.now() - startedAt,
        error: result.error,
      };
    }

    const raw = readFileSync(outputFile, "utf-8");
    let envelope: any;
    try {
      envelope = JSON.parse(raw);
    } catch (e) {
      return {
        ok: false,
        responseText: null,
        durationMs: Date.now() - startedAt,
        error: `runner output not JSON: ${(e as Error).message}`,
      };
    }

    const responseText = adapter.extractResponse(envelope);
    // Cost surfacing: Claude reports total_cost_usd in the inner stdout;
    // Codex doesn't emit it directly, so this stays undefined for Codex.
    const costUsd =
      runtime === "claude" && typeof envelope?.stdout === "string"
        ? extractClaudeCostFromInner(envelope.stdout)
        : undefined;

    return {
      ok: responseText != null,
      responseText,
      durationMs: Date.now() - startedAt,
      rawOutputPath: outputFile,
      error: responseText == null ? "extractResponse returned null" : undefined,
      costUsd,
    };
  } catch (err) {
    return {
      ok: false,
      responseText: null,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function cleanupRawOutput(path: string | undefined): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {}
}

/**
 * AgentExecutor implementation for headless replay.
 *
 * Builds the per-step prompt via buildHandoffPrompt (the same helper the
 * production path uses), spawns the agent via runAgent, and returns a
 * HandoffResult shaped like executeHandoff's return value.
 *
 * `contextBuilder` is injected by the caller because in production the
 * per-step context comes from buildProjectContext (which fetches Discord
 * message history). Replay tooling supplies its own context source —
 * pinned fixtures, replay timeline, or a static stub.
 *
 * worktreePath is currently ignored — runAgent doesn't propagate it to
 * the runner. Replay runs are read-only and shouldn't mutate state.
 */
export class HeadlessAgentExecutor implements AgentExecutor {
  constructor(
    private readonly opts: {
      channelId: string;
      contextBuilder: (
        toAgent: string,
        chainContext?: { completedPhases: ChainEntry[]; currentTask: string },
      ) => Promise<string>;
      timeoutMs?: number;
    },
  ) {}

  async execute(args: ExecuteAgentArgs): Promise<HandoffResult | null> {
    const context = await this.opts.contextBuilder(args.toAgent, args.chainContext);
    const prompt = buildHandoffPrompt(context, args.fromAgent, args.handoffMessage);
    const runtime = resolveHandoffRuntime(this.opts.channelId, args.toAgent);

    const result = await runAgent({
      runtime,
      agentName: args.toAgent,
      prompt,
      channelId: this.opts.channelId,
      timeoutMs: this.opts.timeoutMs,
    });

    if (!result.ok || !result.responseText) {
      return null;
    }

    return {
      agentName: args.toAgent,
      response: result.responseText,
      nextHandoff: parseHandoff(result.responseText),
    };
  }
}
