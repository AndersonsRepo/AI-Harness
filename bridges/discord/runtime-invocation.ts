import { spawn } from "child_process";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { isDeepStrictEqual } from "util";
import {
  buildAgentContext,
  formatAgentContextShadowLog,
  type AgentContext,
  type AgentContextWorkflow,
} from "./agent-context.js";
import {
  formatModelPolicyShadowLog,
  resolveModelPolicyShadowComparison,
} from "./agent-profile.js";
import { getChannelConfig } from "./channel-config-store.js";
import type { AgentRuntime } from "./agent-loader.js";
import { HARNESS_ROOT } from "./claude-config.js";
import { FileWatcher, trackWatcher, untrackWatcher } from "./file-watcher.js";
import {
  finalizeInstance,
  getCompletedSummary,
  processMonitorEvent,
  registerInstance,
  updateInstancePid,
} from "./instance-monitor.js";
import {
  getAdapter,
  type BuildSpawnInput,
  type ParsedEnvelope,
  type RenderSpawnMeta,
  type RuntimeAdapter,
  type SpawnArgs,
} from "./runtime-adapter.js";
import { killProcessGroup } from "./process-reaper.js";
import { isAutonomousPaused } from "./autorun-mode.js";
import { StreamPoller } from "./stream-poller.js";
import type { TelemetrySummary } from "./task-telemetry.js";

const TEMP_DIR = join(HARNESS_ROOT, "bridges", "discord", ".tmp");
const STREAM_DIR = join(TEMP_DIR, "streams");

let spawnProcess = spawn;

export function setRuntimeInvocationSpawnProcessForTests(
  impl: typeof spawn | null,
): void {
  spawnProcess = impl || spawn;
}

// Reaping the spawned process group on timeout is the forward-fix for orphan
// accumulation (ERR-orphaned-agent-spawns-survive-timeout). Injectable so the
// timeout-kill path is testable without signalling a real process.
let killSpawnGroup = killProcessGroup;

export function setRuntimeKillForTests(
  impl: typeof killProcessGroup | null,
): void {
  killSpawnGroup = impl || killProcessGroup;
}

export interface RuntimeInvocationInput {
  channelId: string;
  /** Human-readable channel name → HARNESS_CHANNEL_NAME in the spawn env. The
   *  subagent path leaves this unset; the chat path (spawnTask) supplies it. */
  channelName?: string | null;
  prompt: string;
  agentName: string | null;
  runtime: AgentRuntime;
  sessionKey: string | null;
  taskId?: string;
  taskIdPrefix?: string;
  runnerTaskId?: string;
  outputPrefix?: string;
  timeoutMs?: number;
  streamDir?: string;
  worktreePath?: string | null;
  skipSessionResume?: boolean;
  isContinuation?: boolean;
  extraSystemPrompts?: string[];
  requireResponse?: boolean;
  workflowKind?: AgentContextWorkflow["kind"];
}

interface RuntimeInvocationBase {
  taskId: string;
  pid: number;
  outputFile: string;
  streamDir: string;
  promptFile: string | null;
  telemetry: TelemetrySummary | null;
}

type RuntimeInvocationPayload =
  | {
      ok: true;
      envelope: ParsedEnvelope;
      responseText: string | null;
      sessionId: string | null;
    }
  | {
      ok: false;
      reason: "exit-nonzero";
      envelope: ParsedEnvelope;
      errorMessage: string;
      returncode: number;
    }
  | {
      ok: false;
      reason: "no-response";
      envelope: ParsedEnvelope;
      sessionId: string | null;
    }
  | {
      ok: false;
      reason: "timeout";
    }
  | {
      ok: false;
      reason: "spawn-error";
      errorMessage: string;
    }
  | {
      ok: false;
      reason: "parse-error";
      errorMessage: string;
      raw?: string;
    };

export type RuntimeInvocationResult = RuntimeInvocationBase & RuntimeInvocationPayload;

export interface RuntimeInvocationHandle {
  taskId: string;
  pid: number;
  outputFile: string;
  streamDir: string;
  promptFile: string | null;
  result: Promise<RuntimeInvocationResult>;
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function safeUnlink(path: string | null | undefined): void {
  if (!path) return;
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {}
}

function logModelPolicyShadow(input: RuntimeInvocationInput): void {
  try {
    const channelModel = getChannelConfig(input.channelId)?.model;
    const comparison = resolveModelPolicyShadowComparison({
      agentName: input.agentName,
      runtime: input.runtime,
      prompt: input.prompt,
      channelModel,
    });
    console.log(formatModelPolicyShadowLog(comparison));
  } catch (err: any) {
    console.warn(`[MODEL_POLICY_SHADOW] failed: ${err.message || String(err)}`);
  }
}

/**
 * Build the durable AgentContext for one invocation. This is the single source
 * the rendered path (adapter.renderContext) consumes and the shadow log
 * describes, so the two can never drift. `workflow.taskId` mirrors the taskId
 * the legacy buildSpawnArgs path receives (`input.runnerTaskId || taskId`) —
 * that value seeds the per-spawn MCP config filename, so it must match for the
 * rendered and legacy paths to be byte-identical.
 */
function buildInvocationContext(
  input: RuntimeInvocationInput,
  taskId: string,
): AgentContext {
  return buildAgentContext({
    channelId: input.channelId,
    channelName: input.channelName,
    agentName: input.agentName,
    prompt: input.prompt,
    sessionKey: input.sessionKey,
    runtime: input.runtime,
    workflow: {
      kind: input.workflowKind ?? "runtime-invocation",
      taskId: input.runnerTaskId || taskId,
      worktreePath: input.worktreePath,
      skipSessionResume: input.skipSessionResume,
      isContinuation: input.isContinuation,
    },
    extraSystemPrompts: input.extraSystemPrompts,
  });
}

function logAgentContextShadow(
  input: RuntimeInvocationInput,
  taskId: string,
): void {
  try {
    console.log(formatAgentContextShadowLog(buildInvocationContext(input, taskId)));
  } catch (err: any) {
    console.warn(`[AGENT_CONTEXT_SHADOW] failed: ${err.message || String(err)}`);
  }
}

/**
 * HARNESS_RENDER_CONTEXT gates the renderContext() migration (runtime-abstraction
 * plan, Phase D+). It is the reversal switch — every flip is one env change away
 * from legacy.
 *
 *   off | unset (default) — legacy buildSpawnArgs only; byte-for-byte today.
 *   shadow                — legacy is still USED, but renderContext is also
 *                           built and deep-compared; any divergence is logged
 *                           ([RENDER_PARITY]) without changing the spawn. Run
 *                           this first in a target channel to catch drift the
 *                           static parity tests can't see (notably the
 *                           project-channel agent-name fallback) BEFORE flipping.
 *   <kind>[,<kind>...]    — workflow kinds rendered live: subagent | parallel |
 *                           handoff | chat. Phase D canaries `subagent` only;
 *                           parallel/handoff are deferred (Phase E).
 *   all                   — render every workflow.
 */
function renderContextSelection(): Set<string> {
  const raw = (process.env.HARNESS_RENDER_CONTEXT || "").trim().toLowerCase();
  if (!raw || raw === "off") return new Set();
  return new Set(raw.split(/[\s,]+/).filter(Boolean));
}

function buildLegacySpawnInput(
  input: RuntimeInvocationInput,
  taskId: string,
  spawn: RenderSpawnMeta,
): BuildSpawnInput {
  return {
    channelId: input.channelId,
    channelName: input.channelName ?? null,
    prompt: input.prompt,
    agentName: input.agentName,
    sessionKey: input.sessionKey,
    taskId: input.runnerTaskId || taskId,
    outputFile: spawn.outputFile,
    streamDir: spawn.streamDir,
    worktreePath: input.worktreePath,
    skipSessionResume: input.skipSessionResume,
    isContinuation: input.isContinuation,
    extraSystemPrompts: input.extraSystemPrompts,
    timeoutSecs: spawn.timeoutSecs,
    promptFilePath: spawn.promptFilePath,
  };
}

function logRenderParity(
  taskId: string,
  workflowKind: string,
  legacy: SpawnArgs,
  rendered: SpawnArgs,
): void {
  if (isDeepStrictEqual(legacy, rendered)) {
    console.log(`[RENDER_PARITY] match taskId=${taskId} workflow=${workflowKind}`);
    return;
  }
  console.warn(
    `[RENDER_PARITY] MISMATCH taskId=${taskId} workflow=${workflowKind} — ` +
      `staying on legacy path. legacy=${JSON.stringify(legacy)} ` +
      `rendered=${JSON.stringify(rendered)}`,
  );
}

/**
 * Decide how this invocation's spawn args are produced, honoring
 * HARNESS_RENDER_CONTEXT. Default (and any value that does not select this
 * workflow) → legacy buildSpawnArgs, unchanged. When the flag selects this
 * workflow kind (or `all`) and the adapter implements renderContext, the
 * rendered path is used. `shadow` builds both and diff-logs WITHOUT flipping.
 *
 * The rendered and legacy outputs are proven byte-identical for general-chat
 * shapes by tests/runtime-render-parity.test.ts, so the args-level behavior is
 * unchanged on the flip; only how the args are assembled differs.
 */
export async function resolveSpawnArgs(
  adapter: RuntimeAdapter,
  input: RuntimeInvocationInput,
  taskId: string,
  spawn: RenderSpawnMeta,
): Promise<SpawnArgs> {
  const legacyInput = buildLegacySpawnInput(input, taskId, spawn);

  // Future runtimes may not implement renderContext — always legacy for them.
  if (!adapter.renderContext) {
    return adapter.buildSpawnArgs(legacyInput);
  }

  const selection = renderContextSelection();
  const workflowKind = input.workflowKind ?? "runtime-invocation";

  if (selection.has("all") || selection.has(workflowKind)) {
    return adapter.renderContext(buildInvocationContext(input, taskId), spawn);
  }

  if (selection.has("shadow")) {
    // Render FIRST so the legacy build's prompt-file write wins (Codex writes
    // the composed prompt to the shared promptFilePath). This keeps shadow mode
    // strictly observational — it never alters the actual spawn, even on a
    // mismatch.
    let rendered: SpawnArgs | null = null;
    try {
      rendered = await adapter.renderContext(buildInvocationContext(input, taskId), spawn);
    } catch (err: any) {
      console.warn(
        `[RENDER_PARITY] shadow render failed taskId=${taskId} ` +
          `workflow=${workflowKind}: ${err.message || String(err)}`,
      );
    }
    const legacy = await adapter.buildSpawnArgs(legacyInput);
    if (rendered) logRenderParity(taskId, workflowKind, legacy, rendered);
    return legacy;
  }

  return adapter.buildSpawnArgs(legacyInput);
}

/**
 * Run one process-backed LLM invocation and own the shared lifecycle:
 * temp files, runtime adapter config, process spawn, Monitor registration,
 * live stream polling, output watching, result extraction, and cleanup.
 *
 * This module intentionally does not post to Discord, mutate task queues,
 * parse handoff directives, persist sessions, or decide workflow policy.
 */
export async function startRuntimeInvocation(
  input: RuntimeInvocationInput,
): Promise<RuntimeInvocationHandle> {
  try { mkdirSync(TEMP_DIR, { recursive: true }); } catch {}
  try { mkdirSync(STREAM_DIR, { recursive: true }); } catch {}

  const suffix = uniqueSuffix();
  const taskId =
    input.taskId ??
    `${input.taskIdPrefix || "runtime"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const outputPrefix = input.outputPrefix || input.taskIdPrefix || "runtime";
  const outputFile = join(TEMP_DIR, `${outputPrefix}-${suffix}.json`);
  const streamDir = input.streamDir || join(STREAM_DIR, `${outputPrefix}-${suffix}`);
  const timeoutMs = input.timeoutMs ?? 600_000;
  const adapter = getAdapter(input.runtime);
  const promptFilePath =
    input.runtime === "codex" || input.runtime === "ollama"
      ? join(TEMP_DIR, `${outputPrefix}-${suffix}.prompt.txt`)
      : undefined;

  // Autorun kill-switch (control panel). subagent/handoff/parallel all funnel
  // through here and are autonomous, so they are gated when autonomous AI is
  // paused. Returns a terminal failure so callers stop cleanly (no retry storm).
  // Never gates general chat — that path does not use startRuntimeInvocation.
  if (isAutonomousPaused()) {
    const result: RuntimeInvocationResult = {
      ok: false,
      reason: "spawn-error",
      errorMessage: "AI autorun paused via #control-panel — autonomous spawns are gated. Resume there.",
      taskId,
      pid: 0,
      outputFile,
      streamDir,
      promptFile: promptFilePath ?? null,
      telemetry: null,
    };
    return {
      taskId,
      pid: 0,
      outputFile,
      streamDir,
      promptFile: promptFilePath ?? null,
      result: Promise.resolve(result),
    };
  }

  registerInstance({
    taskId,
    channelId: input.channelId,
    agent: input.agentName || "default",
    runtime: input.runtime,
    prompt: input.prompt,
    pid: 0,
  });
  logModelPolicyShadow(input);
  logAgentContextShadow(input, taskId);

  const spawnMeta: RenderSpawnMeta = {
    outputFile,
    streamDir,
    timeoutSecs: Math.max(1, Math.floor(timeoutMs / 1000)),
    promptFilePath,
  };

  let spawnArgs;
  try {
    spawnArgs = await resolveSpawnArgs(adapter, input, taskId, spawnMeta);
  } catch (err: any) {
    safeUnlink(promptFilePath);
    const telemetry = getCompletedSummary(taskId);
    finalizeInstance(taskId, "failed");
    const result: RuntimeInvocationResult = {
      ok: false,
      reason: "spawn-error",
      errorMessage: err.message || String(err),
      taskId,
      pid: 0,
      outputFile,
      streamDir,
      promptFile: promptFilePath ?? null,
      telemetry,
    };
    return {
      taskId,
      pid: 0,
      outputFile,
      streamDir,
      promptFile: promptFilePath ?? null,
      result: Promise.resolve(result),
    };
  }
  const promptFile = spawnArgs.promptFilePath;

  let handlePid = 0;
  const result = new Promise<RuntimeInvocationResult>((resolve) => {
    let settled = false;
    let pid = handlePid;
    let streamPoller: StreamPoller | null = null;

    const base = (telemetry: TelemetrySummary | null): RuntimeInvocationBase => ({
      taskId,
      pid,
      outputFile,
      streamDir,
      promptFile,
      telemetry,
    });

    const finish = (
      result: RuntimeInvocationPayload,
      status: "completed" | "failed",
      envelope?: ParsedEnvelope,
    ): void => {
      if (settled) return;
      settled = true;
      streamPoller?.stop();

      if (envelope) {
        try {
          adapter.recordResult(taskId, envelope);
        } catch (err: any) {
          console.error(`[RUNTIME] Failed to record telemetry for ${taskId}: ${err.message}`);
        }
      }

      const telemetry = getCompletedSummary(taskId);
      finalizeInstance(taskId, status);
      resolve({ ...base(telemetry), ...result } as RuntimeInvocationResult);
    };

    try {
      const childProc = spawnProcess("python3", spawnArgs.pythonArgs, {
        cwd: spawnArgs.cwd,
        env: spawnArgs.env,
        detached: true,
        stdio: "ignore",
      });
      childProc.unref();
      pid = childProc.pid ?? 0;
      handlePid = pid;
      updateInstancePid(taskId, pid);
    } catch (err: any) {
      safeUnlink(promptFile);
      safeUnlink(outputFile);
      finish(
        {
          ok: false,
          reason: "spawn-error",
          errorMessage: err.message || String(err),
        },
        "failed",
      );
      return;
    }

    if (adapter.capabilities.streamingTelemetry) {
      streamPoller = new StreamPoller(streamDir, () => {}, {
        monitorCallback: (event) => processMonitorEvent(taskId, event),
      });
      streamPoller.start();
    }

    const watcher = new FileWatcher({
      filePath: outputFile,
      onFile: (content: string) => {
        untrackWatcher(watcher);
        safeUnlink(promptFile);
        safeUnlink(outputFile);

        try {
          const envelope = JSON.parse(content) as ParsedEnvelope;
          const returncode =
            typeof envelope.returncode === "number" ? envelope.returncode : 0;

          if (returncode !== 0) {
            const stderr = typeof envelope.stderr === "string" ? envelope.stderr : "";
            finish(
              {
                ok: false,
                reason: "exit-nonzero",
                envelope,
                errorMessage: stderr.trim() || `Agent exited with code ${returncode}`,
                returncode,
              },
              "failed",
              envelope,
            );
            return;
          }

          const responseText = adapter.extractResponse(envelope);
          const sessionId = adapter.extractSessionId(envelope);

          if (input.requireResponse && !responseText) {
            finish(
              {
                ok: false,
                reason: "no-response",
                envelope,
                sessionId: sessionId ?? null,
              },
              "failed",
              envelope,
            );
            return;
          }

          finish(
            {
              ok: true,
              envelope,
              responseText,
              sessionId: sessionId ?? null,
            },
            "completed",
            envelope,
          );
        } catch (err: any) {
          console.error(`[RUNTIME] Error reading output for ${taskId}: ${err.message}`);
          finish(
            {
              ok: false,
              reason: "parse-error",
              errorMessage: err.message,
              raw: content,
            },
            "failed",
          );
        }
      },
      onTimeout: () => {
        untrackWatcher(watcher);
        // Kill the wedged child's process group. The spawn is detached (pgid ==
        // child pid), so this reaps the runner AND its child MCP servers. Without
        // this, a hung codex/claude turn survives as an immortal orphan and
        // accumulates across bot restarts (ERR-orphaned-agent-spawns-survive-timeout).
        try {
          killSpawnGroup(pid, "SIGTERM");
        } catch (err: any) {
          console.warn(`[RUNTIME] Failed to kill timed-out spawn ${taskId} (pid ${pid}): ${err?.message || String(err)}`);
        }
        safeUnlink(promptFile);
        safeUnlink(outputFile);
        finish({ ok: false, reason: "timeout" }, "failed");
      },
      timeoutMs,
      fallbackPollMs: 2000,
      retryReadMs: 100,
    });
    trackWatcher(watcher);
    watcher.start();
  });

  return {
    taskId,
    pid: handlePid,
    outputFile,
    streamDir,
    promptFile,
    result,
  };
}

export async function runRuntimeInvocation(
  input: RuntimeInvocationInput,
): Promise<RuntimeInvocationResult> {
  const handle = await startRuntimeInvocation(input);
  return handle.result;
}
