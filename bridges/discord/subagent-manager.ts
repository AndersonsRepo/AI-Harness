import * as registry from "./process-registry.js";
import {
  postStart,
  postUpdate,
  postComplete,
  postError,
} from "./activity-stream.js";
import { getChannelConfig } from "./channel-config-store.js";
import type { AgentRuntime } from "./agent-loader.js";
import { proc } from "./platform.js";
import { resolveRuntimePolicy } from "./role-policy.js";
import {
  classifyRuntimeFailureForFailover,
  runtimeFailoverMessage,
} from "./runtime-failover.js";
import {
  setRuntimeInvocationSpawnProcessForTests,
  startRuntimeInvocation,
  type RuntimeInvocationResult,
} from "./runtime-invocation.js";

const SUBAGENT_TIMEOUT = parseInt(process.env.SUBAGENT_TIMEOUT || "300", 10);

export interface SpawnOptions {
  channelId: string;
  description: string;
  agent?: string;
}

let notifyCallback: ((entry: registry.SubagentEntry, result: string) => void) | null = null;

export function onSubagentComplete(
  cb: (entry: registry.SubagentEntry, result: string) => void
): void {
  notifyCallback = cb;
}

export function setSubagentSpawnProcessForTests(
  impl: Parameters<typeof setRuntimeInvocationSpawnProcessForTests>[0],
): void {
  setRuntimeInvocationSpawnProcessForTests(impl);
}

export async function spawnSubagent(options: SpawnOptions): Promise<registry.SubagentEntry | null> {
  const id = `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // Build shared config
  const channelConfig = getChannelConfig(options.channelId);
  const agentName = options.agent || channelConfig?.agent;
  const runtime: AgentRuntime = resolveRuntimePolicy({
    channelId: options.channelId,
    agentName,
  }).selectedRuntime;

  const baseEntry: registry.SubagentEntry = {
    id,
    parentChannelId: options.channelId,
    description: options.description,
    agent: agentName,
    runtime,
    outputFile: "",
    pid: 0,
    status: "running",
    startedAt: new Date().toISOString(),
  };

  const entry = await startSubagentRuntime(baseEntry, runtime, { register: true });

  // Post to activity stream (async, don't block)
  postStart(entry).then((msgId) => {
    if (msgId) {
      registry.update(id, { streamMessageId: msgId });
    }
  });

  console.log(`[SUBAGENT] Spawned ${id}: "${options.description}" (PID ${entry.pid})`);
  return entry;
}

async function startSubagentRuntime(
  entry: registry.SubagentEntry,
  runtime: AgentRuntime,
  opts: { register: boolean },
): Promise<registry.SubagentEntry> {
  const invocation = await startRuntimeInvocation({
    channelId: entry.parentChannelId,
    prompt: entry.description,
    agentName: entry.agent ?? null,
    runtime,
    sessionKey: entry.parentChannelId,
    taskId: `subagent-${entry.id}-${Date.now()}`,
    outputPrefix: `subagent-${entry.id}-${runtime}`,
    timeoutMs: SUBAGENT_TIMEOUT * 1000,
    skipSessionResume: true,
    workflowKind: "subagent",
  });

  const runningEntry: registry.SubagentEntry = {
    ...entry,
    runtime,
    outputFile: invocation.outputFile,
    pid: invocation.pid,
    status: "running",
  };

  if (opts.register) {
    registry.register(runningEntry);
  } else {
    registry.update(entry.id, {
      runtime,
      outputFile: invocation.outputFile,
      pid: runningEntry.pid,
      status: "running",
    });
  }

  invocation.result
    .then((result) => handleSubagentResult(runningEntry, result))
    .catch((err) =>
        console.error(`[SUBAGENT] Output handler error for ${entry.id}: ${err.message}`)
    );

  return runningEntry;
}

async function handleSubagentResult(entry: registry.SubagentEntry, result: RuntimeInvocationResult): Promise<void> {
  try {
    if (!result.ok) {
      const errorMsg =
        "errorMessage" in result
          ? result.errorMessage
          : result.reason === "timeout"
            ? `Timed out after ${SUBAGENT_TIMEOUT}s`
            : result.reason;
      const failover = result.reason === "exit-nonzero"
        ? classifyRuntimeFailureForFailover({
            channelId: entry.parentChannelId,
            agentName: entry.agent,
            explicitRuntime: entry.runtime,
            failedRuntime: entry.runtime || "claude",
            stdout: result.envelope.stdout,
            stderr: result.envelope.stderr,
            returncode: result.returncode,
          })
        : null;
      if (failover?.shouldFailover && failover.nextRuntime) {
        const message = runtimeFailoverMessage(entry.runtime || "claude", failover.nextRuntime);
        console.log(`[SUBAGENT] ${entry.id} ${message}`);
        await postUpdate(entry, `${message}: ${failover.reason.slice(0, 500)}`).catch(() => {});
        await startSubagentRuntime(entry, failover.nextRuntime, { register: false });
        return;
      }

      console.log(`[SUBAGENT] ${entry.id} failed: ${errorMsg.slice(0, 200)}`);
      registry.update(entry.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
      });
      await postError(entry, errorMsg);
      if (notifyCallback) {
        notifyCallback(
          { ...entry, status: "failed" },
          `Failed: ${errorMsg}`
        );
      }
    } else {
      const responseText = result.responseText || "No response parsed";
      registry.update(entry.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      await postComplete(entry, responseText);
      if (notifyCallback) {
        notifyCallback({ ...entry, status: "completed" }, responseText);
      }
    }
  } catch (err: any) {
    console.error(`[SUBAGENT] Error processing ${entry.id}: ${err.message}`);
  }
}

// startPolling and stopPolling are now no-ops — kept for backward compatibility
// FileWatcher handles per-subagent output detection
export function startPolling(): void {
  console.log("[SUBAGENT] Using event-driven file watching (FileWatcher per subagent)");
}

export function stopPolling(): void {
  // No-op — watchers are cleaned up individually or via stopAllWatchers()
}

export function cancelSubagent(id: string): boolean {
  const entry = registry.get(id);
  if (!entry || entry.status !== "running") return false;

  proc.terminate(entry.pid);

  registry.update(id, {
    status: "cancelled",
    completedAt: new Date().toISOString(),
  });

  postError(entry, "Cancelled by user").catch(() => {});
  console.log(`[SUBAGENT] Cancelled ${id}`);
  return true;
}
