import { spawn } from "child_process";
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import * as registry from "./process-registry.js";
import {
  postStart,
  postUpdate,
  postComplete,
  postError,
} from "./activity-stream.js";
import { getChannelConfig } from "./channel-config-store.js";
import type { AgentRuntime } from "./agent-loader.js";
import { FileWatcher, trackWatcher, untrackWatcher } from "./file-watcher.js";
import { proc } from "./platform.js";
import {
  HARNESS_ROOT,
  extractResponse,
  buildClaudeConfig,
} from "./claude-config.js";
import { buildCodexConfig, extractCodexResponse } from "./codex-config.js";
import { resolveRuntimePolicy } from "./role-policy.js";

const TEMP_DIR = join(HARNESS_ROOT, "bridges", "discord", ".tmp");
const SUBAGENT_TIMEOUT = parseInt(process.env.SUBAGENT_TIMEOUT || "300", 10);
let spawnProcess = spawn;

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
  impl: typeof spawn | null,
): void {
  spawnProcess = impl || spawn;
}

export async function spawnSubagent(options: SpawnOptions): Promise<registry.SubagentEntry | null> {
  const id = `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const outputFile = join(TEMP_DIR, `subagent-${id}.json`);
  let promptFile: string | null = null;

  try {
    mkdirSync(TEMP_DIR, { recursive: true });
  } catch {}

  // Build shared config
  const channelConfig = getChannelConfig(options.channelId);
  const agentName = options.agent || channelConfig?.agent;
  const runtime: AgentRuntime = resolveRuntimePolicy({
    channelId: options.channelId,
    agentName,
  }).selectedRuntime;
  let pythonArgs: string[];
  let childCwd: string;
  let childEnv: Record<string, string>;

  if (runtime === "codex") {
    const config = await buildCodexConfig({
      channelId: options.channelId,
      prompt: options.description,
      agentName,
      sessionKey: options.channelId,
      taskId: `subagent-${Date.now()}`,
      skipSessionResume: true,
    });

    promptFile = join(TEMP_DIR, `subagent-${id}.prompt.txt`);
    writeFileSync(promptFile, config.prompt, "utf-8");

    pythonArgs = [
      `${HARNESS_ROOT}/bridges/discord/codex-runner.py`,
      outputFile,
      "--timeout",
      String(SUBAGENT_TIMEOUT),
      "--prompt-file",
      promptFile,
      ...config.runnerArgs,
    ];
    childCwd = config.cwd;
    childEnv = config.env;
  } else {
    const config = await buildClaudeConfig({
      channelId: options.channelId,
      prompt: options.description,
      agentName,
      sessionKey: options.channelId,
      taskId: `subagent-${Date.now()}`,
      skipSessionResume: true,
    });

    pythonArgs = [
      `${HARNESS_ROOT}/bridges/discord/claude-runner.py`,
      outputFile,
      "--timeout",
      String(SUBAGENT_TIMEOUT),
      ...config.args,
    ];
    childCwd = config.cwd;
    childEnv = config.env;
  }

  const childProc = spawnProcess("python3", pythonArgs, {
    cwd: childCwd,
    env: childEnv,
    detached: true,
    stdio: "ignore",
  });
  childProc.unref();

  const entry: registry.SubagentEntry = {
    id,
    parentChannelId: options.channelId,
    description: options.description,
    agent: agentName,
    runtime,
    outputFile,
    pid: childProc.pid!,
    status: "running",
    startedAt: new Date().toISOString(),
  };

  registry.register(entry);

  // Post to activity stream (async, don't block)
  postStart(entry).then((msgId) => {
    if (msgId) {
      registry.update(id, { streamMessageId: msgId });
    }
  });

  // Set up FileWatcher instead of polling
  const watcher = new FileWatcher({
    filePath: outputFile,
    onFile: (content: string) => {
      untrackWatcher(watcher);
      if (promptFile && existsSync(promptFile)) {
        unlinkSync(promptFile);
      }
      handleSubagentOutput(entry, content).catch((err) =>
        console.error(`[SUBAGENT] Output handler error for ${id}: ${err.message}`)
      );
    },
    onTimeout: () => {
      untrackWatcher(watcher);
      if (promptFile && existsSync(promptFile)) {
        unlinkSync(promptFile);
      }
      console.log(`[SUBAGENT] ${id} timed out after ${SUBAGENT_TIMEOUT}s`);
      registry.update(id, {
        status: "failed",
        completedAt: new Date().toISOString(),
      });
      postError(entry, `Timed out after ${SUBAGENT_TIMEOUT}s`).catch(() => {});
      if (notifyCallback) {
        notifyCallback({ ...entry, status: "failed" }, `Timed out after ${SUBAGENT_TIMEOUT}s`);
      }
    },
    timeoutMs: SUBAGENT_TIMEOUT * 1000,
    fallbackPollMs: 3000,
    retryReadMs: 100,
  });
  trackWatcher(watcher);
  watcher.start();

  console.log(`[SUBAGENT] Spawned ${id}: "${options.description}" (PID ${childProc.pid})`);
  return entry;
}

async function handleSubagentOutput(entry: registry.SubagentEntry, content: string): Promise<void> {
  try {
    // Clean up the output file
    if (existsSync(entry.outputFile)) {
      unlinkSync(entry.outputFile);
    }

    const result = JSON.parse(content);
    const { stdout, stderr, returncode } = result;

    if (returncode !== 0) {
      const errorMsg = stderr?.trim() || `Exited with code ${returncode}`;
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
      const responseText = entry.runtime === "codex"
        ? extractCodexResponse(result) || "No response parsed"
        : extractResponse(stdout) || "No response parsed";
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
