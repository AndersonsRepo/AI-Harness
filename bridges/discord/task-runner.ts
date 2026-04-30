import { spawn } from "child_process";
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getDb } from "./db.js";
import { setSession, validateSession } from "./session-store.js";
import { getChannelConfig } from "./channel-config-store.js";
import { FileWatcher, trackWatcher, untrackWatcher } from "./file-watcher.js";
import { isHoldingContinuation, getInterventionNote, clearInterventionNote, registerInstance, recordCodexResult } from "./instance-monitor.js";
import { proc } from "./platform.js";
import { resolveRuntimePolicy } from "./role-policy.js";
import {
  HARNESS_ROOT,
  extractResponse as sharedExtractResponse,
  extractSessionId as sharedExtractSessionId,
  buildClaudeConfig,
  classifyClaudeError,
} from "./claude-config.js";
import {
  buildCodexConfig,
  extractCodexResponse,
  extractCodexSessionId,
} from "./codex-config.js";
import type { AgentRuntime } from "./agent-loader.js";

const TEMP_DIR = join(HARNESS_ROOT, "bridges", "discord", ".tmp");
const STREAM_DIR = join(TEMP_DIR, "streams");
const PROMPT_DIR = join(TEMP_DIR, "prompts");

// Retry backoff: 5s, 25s, 125s (exponential base-5)
const RETRY_BACKOFF_BASE = 5;

// ─── Model Failover / Cooldown ───────────────────────────────────────
// Track consecutive API failures across all tasks. When Claude is repeatedly
// unavailable, pause new task submission and notify Discord.

// ─── Per-Task Backoff (no global cooldown) ──────────────────────────
// Individual tasks handle their own retry backoff via claude-runner.py.
// We track consecutive API failures for observability only — no system-wide pause.

let consecutiveApiFailures = 0;

function isTransientApiError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return ["429", "rate limit", "503", "502", "500", "overloaded", "connection", "econnreset"].some(
    (s) => lower.includes(s)
  );
}

function recordApiSuccess(): void {
  if (consecutiveApiFailures > 0) {
    console.log(`[API] Recovered after ${consecutiveApiFailures} consecutive failures`);
  }
  consecutiveApiFailures = 0;
}

function recordApiFailure(): { shouldCooldown: boolean } {
  consecutiveApiFailures++;
  if (consecutiveApiFailures >= 5) {
    console.warn(`[API] ${consecutiveApiFailures} consecutive failures — tasks will retry individually`);
  }
  return { shouldCooldown: false }; // never block globally
}

export function isInCooldown(): boolean {
  return false; // no global cooldown
}

export function getCooldownStatus(): { inCooldown: boolean; failureCount: number; expiresAt: number } {
  return { inCooldown: false, failureCount: consecutiveApiFailures, expiresAt: 0 };
}

// ─── Loop Detection ──────────────────────────────────────────────────
// Track recent tool calls per task to detect stuck agents repeating the same actions.
const LOOP_HISTORY_SIZE = 30;
const LOOP_WARNING_THRESHOLD = 4;  // warn after 4 repeats of same tool+args pattern
const taskToolHistory = new Map<string, string[]>();

function checkForLoops(taskId: string, stdout: string): string | null {
  // Extract tool_use events from stream-json output
  const toolCalls: string[] = [];
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type === "tool_use" || event.type === "tool_result") {
        // Create a signature from tool name + truncated input
        const sig = `${event.name || event.tool || "unknown"}:${JSON.stringify(event.input || "").slice(0, 100)}`;
        toolCalls.push(sig);
      }
    } catch {}
  }

  if (toolCalls.length === 0) return null;

  // Append to history
  const history = taskToolHistory.get(taskId) || [];
  history.push(...toolCalls);
  // Keep only last N entries
  if (history.length > LOOP_HISTORY_SIZE) {
    history.splice(0, history.length - LOOP_HISTORY_SIZE);
  }
  taskToolHistory.set(taskId, history);

  // Check for repeated patterns
  const counts = new Map<string, number>();
  for (const sig of history) {
    counts.set(sig, (counts.get(sig) || 0) + 1);
  }

  for (const [sig, count] of counts) {
    if (count >= LOOP_WARNING_THRESHOLD) {
      return `Loop detected: "${sig.slice(0, 80)}" repeated ${count} times in last ${history.length} tool calls`;
    }
  }

  return null;
}

function clearLoopHistory(taskId: string): void {
  taskToolHistory.delete(taskId);
}

let spawnProcess = spawn;

export function setSpawnProcessForTests(
  impl: typeof spawn | null,
): void {
  spawnProcess = impl || spawn;
}

export interface TaskConfig {
  channelId: string;
  prompt: string;
  agent?: string;
  runtime?: AgentRuntime;
  sessionKey?: string;
  maxSteps?: number;
  maxAttempts?: number;
}

export interface TaskRecord {
  id: string;
  channel_id: string;
  prompt: string;
  agent: string | null;
  runtime: AgentRuntime | null;
  session_key: string | null;
  status: string;
  step_count: number;
  max_steps: number;
  attempt: number;
  max_attempts: number;
  last_error: string | null;
  output_file: string | null;
  pid: number | null;
  created_at: string;
  updated_at: string;
  next_retry_at: string | null;
}

export interface DeadLetterRecord {
  id: string;
  task_id: string;
  channel_id: string;
  prompt: string;
  agent: string | null;
  runtime: AgentRuntime | null;
  error: string;
  attempts: number;
  created_at: string;
}

export type TaskOutputHandler = (
  taskId: string,
  response: string | null,
  error: string | null,
  sessionId: string | null,
  raw: string
) => Promise<void>;

export type TaskDeadLetterHandler = (
  record: DeadLetterRecord
) => Promise<void>;

let outputHandler: TaskOutputHandler | null = null;
let deadLetterHandler: TaskDeadLetterHandler | null = null;

// Track stream dirs per task for continuation steps
const taskStreamDirs = new Map<string, string>();
const taskPromptFiles = new Map<string, string>();

export function onTaskOutput(handler: TaskOutputHandler): void {
  outputHandler = handler;
}

export function onTaskDeadLetter(handler: TaskDeadLetterHandler): void {
  deadLetterHandler = handler;
}

function generateId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Extract helpers (delegating to claude-config.ts) ---

export const extractResponse = sharedExtractResponse;
export const extractSessionId = sharedExtractSessionId;

export function resolveTaskRuntime(task: Pick<TaskRecord, "runtime" | "agent" | "channel_id">): AgentRuntime {
  return resolveRuntimePolicy({
    channelId: task.channel_id,
    agentName: task.agent,
    explicitRuntime: task.runtime,
  }).selectedRuntime;
}

/** Detect if Claude needs another step */
export function needsContinuation(response: string): boolean {
  if (response.trimEnd().endsWith("[CONTINUE]")) return true;
  // Check for common "I'll continue" patterns at the end
  const lastLines = response.slice(-200).toLowerCase();
  if (lastLines.match(/i('ll| will) continue\b/) && !lastLines.includes("[CONTINUE]")) return false; // Only explicit marker triggers
  return false;
}

// --- Task CRUD ---

export function submitTask(config: TaskConfig): string {
  const db = getDb();
  const id = generateId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO task_queue (id, channel_id, prompt, agent, runtime, session_key, status, max_steps, max_attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(
    id,
    config.channelId,
    config.prompt,
    config.agent || null,
    config.runtime || null,
    config.sessionKey || null,
    config.maxSteps ?? 10,
    config.maxAttempts ?? 3,
    now,
    now
  );

  return id;
}

export function getTask(id: string): TaskRecord | null {
  const db = getDb();
  return db.prepare("SELECT * FROM task_queue WHERE id = ?").get(id) as TaskRecord | null;
}

export function getRunningTasks(): TaskRecord[] {
  const db = getDb();
  return db.prepare("SELECT * FROM task_queue WHERE status IN ('running', 'waiting_continue')").all() as TaskRecord[];
}

export function getPendingTasks(): TaskRecord[] {
  const db = getDb();
  return db.prepare("SELECT * FROM task_queue WHERE status = 'pending' ORDER BY created_at ASC").all() as TaskRecord[];
}

export function getRunningCountForChannel(channelId: string): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as c FROM task_queue WHERE channel_id = ? AND status IN ('running', 'waiting_continue')").get(channelId) as { c: number };
  return row.c;
}

export function getGlobalRunningCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as c FROM task_queue WHERE status IN ('running', 'waiting_continue')").get() as { c: number };
  return row.c;
}

export function getTaskPidForChannel(channelId: string): number | null {
  const db = getDb();
  const row = db.prepare("SELECT pid FROM task_queue WHERE channel_id = ? AND status = 'running' ORDER BY updated_at DESC LIMIT 1").get(channelId) as { pid: number | null } | undefined;
  return row?.pid ?? null;
}

function updateTask(id: string, updates: Partial<TaskRecord>): void {
  const db = getDb();
  const fields: string[] = [];
  const values: any[] = [];
  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }
  fields.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE task_queue SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

// --- Spawn & execute ---

export async function spawnTask(taskId: string, opts?: { reuseStreamDir?: string; worktreePath?: string }): Promise<{ pid: number; outputFile: string; streamDir: string; runtime: AgentRuntime } | null> {
  const task = getTask(taskId);
  if (!task) return null;

  // Check cooldown — don't spawn if Claude API is repeatedly failing
  if (isInCooldown()) {
    console.warn(`[TASK] ${taskId} skipped — API cooldown active (${consecutiveApiFailures} failures)`);
    updateTask(taskId, { status: "pending", last_error: "API cooldown — will retry when service recovers" });
    return null;
  }

  try { mkdirSync(TEMP_DIR, { recursive: true }); } catch {}
  try { mkdirSync(STREAM_DIR, { recursive: true }); } catch {}
  try { mkdirSync(PROMPT_DIR, { recursive: true }); } catch {}

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const outputFile = join(TEMP_DIR, `response-${requestId}.json`);
  // Reuse the same stream dir for continuation steps so the StreamPoller keeps working
  const streamDir = opts?.reuseStreamDir || join(STREAM_DIR, requestId);

  // Build intervention notes for extra system prompts
  const extraSystemPrompts: string[] = [];
  const interventionNote = getInterventionNote(task.id);
  if (interventionNote) {
    extraSystemPrompts.push(`\n[OPERATOR GUIDANCE]: ${interventionNote}`);
    clearInterventionNote(task.id);
    console.log(`[TASK] ${task.id} injected intervention note: ${interventionNote.slice(0, 80)}`);
  }

  // Build shared config
  const channelConfig = getChannelConfig(task.channel_id);
  const agentName = task.agent || channelConfig?.agent;
  const runtime = resolveTaskRuntime(task);
  const isContinuation = runtime === "claude" && task.step_count > 0;

  let pythonArgs: string[];
  let childCwd: string;
  let childEnv: Record<string, string>;

  if (runtime === "codex") {
    const config = await buildCodexConfig({
      channelId: task.channel_id,
      prompt: task.prompt,
      agentName,
      sessionKey: task.session_key || task.channel_id,
      taskId: task.id,
      extraSystemPrompts,
      worktreePath: opts?.worktreePath,
      outputFile,
      streamDir,
    });

    const promptFile = join(PROMPT_DIR, `prompt-${requestId}.txt`);
    writeFileSync(promptFile, config.prompt, "utf-8");
    taskPromptFiles.set(taskId, promptFile);

    pythonArgs = [
      `${HARNESS_ROOT}/bridges/discord/codex-runner.py`,
      outputFile,
      "--stream-dir",
      streamDir,
      "--prompt-file",
      promptFile,
      ...config.runnerArgs,
    ];
    childCwd = config.cwd;
    childEnv = config.env;
  } else {
    const config = await buildClaudeConfig({
      channelId: task.channel_id,
      prompt: task.prompt,
      agentName,
      sessionKey: task.session_key || task.channel_id,
      taskId: task.id,
      isContinuation,
      extraSystemPrompts,
      worktreePath: opts?.worktreePath,
    });

    pythonArgs = [
      `${HARNESS_ROOT}/bridges/discord/claude-runner.py`,
      outputFile,
      "--stream-dir",
      streamDir,
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

  const pid = childProc.pid!;

  updateTask(taskId, {
    status: "running",
    runtime,
    output_file: outputFile,
    pid,
    step_count: task.step_count + 1,
  });

  console.log(`[TASK] Spawned ${taskId} step ${task.step_count + 1}, PID ${pid}, agent: ${agentName || "default"}, runtime: ${runtime}`);

  // Set up FileWatcher for the output file
  const watcher = new FileWatcher({
    filePath: outputFile,
    onFile: (content: string) => {
      untrackWatcher(watcher);
      handleTaskOutput(taskId, content).catch((err) => {
        console.error(`[TASK] Output handler error for ${taskId}: ${err.message}`);
        // Ensure task doesn't hang in 'running' state if handleTaskOutput itself throws
        updateTask(taskId, { status: "failed", last_error: `Output handler crash: ${err.message}` });
        handleFailure(taskId, `Output handler crash: ${err.message}`).catch((e) =>
          console.error(`[TASK] Recovery also failed for ${taskId}: ${e.message}`)
        );
      });
    },
    fallbackPollMs: 2000,
    retryReadMs: 100,
  });
  trackWatcher(watcher);
  watcher.start();

  // Track stream dir for continuation steps
  taskStreamDirs.set(taskId, streamDir);

  return { pid, outputFile, streamDir, runtime };
}

async function handleTaskOutput(taskId: string, raw: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) return;
  const runtime = resolveTaskRuntime(task);

  try {
    // Clean up output file
    if (task.output_file && existsSync(task.output_file)) {
      unlinkSync(task.output_file);
    }
    const promptFile = taskPromptFiles.get(taskId);
    if (promptFile && existsSync(promptFile)) {
      unlinkSync(promptFile);
      taskPromptFiles.delete(taskId);
    }

    const result = JSON.parse(raw);
    const { stdout, stderr, returncode } = result;

    console.log(`[TASK] ${taskId} runtime: ${runtime}, returncode: ${returncode}, stdout length: ${(stdout || "").length}`);
    if (stderr) console.error(`[TASK STDERR] ${stderr.slice(0, 500)}`);

    // Check for stale session error
    if (
      runtime === "claude" &&
      returncode !== 0 &&
      task.attempt === 0 &&
      stderr?.includes("session") &&
      (stderr?.includes("not found") || stderr?.includes("expired"))
    ) {
      console.log(`[TASK] ${taskId} stale session detected, clearing and retrying`);
      const sessionKey = task.session_key || task.channel_id;
      validateSession(sessionKey, "claude");
      clearLoopHistory(taskId);
      // Immediate retry (counts as attempt 1)
      updateTask(taskId, { attempt: 1, status: "pending", last_error: "Stale session - retrying" });
      await spawnTask(taskId);
      return;
    }

    if (returncode !== 0) {
      const runtimeLabel = runtime === "codex" ? "Codex" : "Claude";
      let errorMsg = stderr?.trim() || `${runtimeLabel} exited with code ${returncode}`;
      let permanent = false;

      if (runtime === "claude") {
        const classified = classifyClaudeError(stdout || "", stderr || "", returncode);
        if (classified) {
          errorMsg = classified.message;
          permanent = !classified.retryable;
          console.log(`[TASK] ${taskId} classified: retryable=${classified.retryable} raw=${classified.raw.slice(0, 120)}`);
        }
      }

      // Track API failures for observability
      if (runtime === "claude" && isTransientApiError(errorMsg)) {
        recordApiFailure();
      }
      await handleFailure(taskId, errorMsg, permanent);
      // Notify handler of the error
      if (outputHandler) {
        await outputHandler(taskId, null, errorMsg, null, raw);
      }
      return;
    }

    // Successful response — reset API failure counter
    if (runtime === "claude") {
      recordApiSuccess();
    }

    // Codex stdout is the JSONL event stream. Claude streams events to
    // chunk files in streamDir which the StreamPoller already feeds into
    // processMonitorEvent; Codex doesn't (codex-runner.py's --stream-dir
    // is accept-only-for-compat per its docstring). Without this, every
    // Codex spawn records `total_tools = 0` regardless of MCP/Bash usage.
    if (runtime === "codex" && typeof stdout === "string") {
      recordCodexResult(taskId, stdout);
    }

    const responseText = runtime === "codex"
      ? extractCodexResponse(result)
      : extractResponse(stdout);
    const sessionId = runtime === "codex"
      ? extractCodexSessionId(result)
      : extractSessionId(stdout);

    console.log(`[TASK] ${taskId} extractResponse: ${responseText ? responseText.length + ' chars' : 'NULL'}, sessionId: ${sessionId || 'null'}`);

    // Loop detection — check for repeated tool call patterns
    const loopWarning = runtime === "claude" ? checkForLoops(taskId, stdout) : null;
    if (loopWarning) {
      console.warn(`[TASK] ${taskId} ${loopWarning}`);
      // Kill the task if looping — don't allow continuation
      updateTask(taskId, { status: "completed", last_error: loopWarning });
      clearLoopHistory(taskId);
      taskStreamDirs.delete(taskId);
      if (outputHandler) {
        const warningText = responseText
          ? `${responseText}\n\n⚠️ Task stopped: ${loopWarning}`
          : `⚠️ Task stopped: ${loopWarning}`;
        await outputHandler(taskId, warningText, null, sessionId, raw);
      }
      return;
    }

    // Save session
    if (sessionId) {
      const sessionKey = task.session_key || task.channel_id;
      setSession(sessionKey, sessionId, runtime);
    }

    // Check for continuation
    if (
      runtime === "claude" &&
      responseText &&
      needsContinuation(responseText) &&
      task.step_count < task.max_steps
    ) {
      console.log(`[TASK] ${taskId} needs continuation (step ${task.step_count}/${task.max_steps})`);
      updateTask(taskId, { status: "waiting_continue" });

      // Notify handler of intermediate output
      if (outputHandler) {
        await outputHandler(taskId, responseText, null, sessionId, raw);
      }

      // Check if monitor is holding continuation (pause intervention)
      if (isHoldingContinuation(taskId)) {
        console.log(`[TASK] ${taskId} continuation held by monitor — waiting for resume`);
        return;
      }

      // Spawn next step — reuse stream dir so StreamPoller keeps working
      const existingStreamDir = taskStreamDirs.get(taskId);
      await spawnTask(taskId, existingStreamDir ? { reuseStreamDir: existingStreamDir } : undefined);
      return;
    }

    // Task completed
    updateTask(taskId, { status: "completed" });
    taskStreamDirs.delete(taskId);
    clearLoopHistory(taskId);
    console.log(`[TASK] ${taskId} completed after ${task.step_count} steps`);

    if (outputHandler) {
      await outputHandler(taskId, responseText, null, sessionId, raw);
    }
  } catch (err: any) {
    console.error(`[TASK] ${taskId} output processing error: ${err.message}`);
    const promptFile = taskPromptFiles.get(taskId);
    if (promptFile && existsSync(promptFile)) {
      unlinkSync(promptFile);
      taskPromptFiles.delete(taskId);
    }
    await handleFailure(taskId, err.message);
    if (outputHandler) {
      await outputHandler(taskId, null, err.message, null, raw);
    }
  }
}

async function handleFailure(taskId: string, error: string, permanent: boolean = false): Promise<void> {
  const task = getTask(taskId);
  if (!task) return;

  const nextAttempt = task.attempt + 1;

  if (permanent || nextAttempt >= task.max_attempts) {
    if (permanent) {
      console.log(`[TASK] ${taskId} permanent failure, skipping retries: ${error.slice(0, 80)}`);
    } else {
      console.log(`[TASK] ${taskId} exhausted all ${task.max_attempts} attempts, moving to dead letter`);
    }
    updateTask(taskId, { status: "dead", last_error: error });
    taskStreamDirs.delete(taskId);
    taskPromptFiles.delete(taskId);
    clearLoopHistory(taskId);

    const db = getDb();
    const dlId = `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`
      INSERT INTO dead_letter (id, task_id, channel_id, prompt, agent, runtime, error, attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(dlId, taskId, task.channel_id, task.prompt, task.agent, task.runtime, error, nextAttempt);

    if (deadLetterHandler) {
      const dlRecord: DeadLetterRecord = {
        id: dlId,
        task_id: taskId,
        channel_id: task.channel_id,
        prompt: task.prompt,
        agent: task.agent,
        runtime: task.runtime,
        error,
        attempts: nextAttempt,
        created_at: new Date().toISOString(),
      };
      await deadLetterHandler(dlRecord);
    }
    return;
  }

  // Schedule retry with exponential backoff
  const backoffSeconds = Math.pow(RETRY_BACKOFF_BASE, nextAttempt);
  const nextRetryAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();

  console.log(`[TASK] ${taskId} failed attempt ${nextAttempt}/${task.max_attempts}, retry in ${backoffSeconds}s`);

  updateTask(taskId, {
    status: "failed",
    attempt: nextAttempt,
    last_error: error,
    next_retry_at: nextRetryAt,
  });

  // Schedule the retry
  setTimeout(() => {
    const current = getTask(taskId);
    if (current && current.status === "failed") {
      updateTask(taskId, { status: "pending", step_count: 0 });
      spawnTask(taskId).catch((err) =>
        console.error(`[TASK] Retry spawn failed for ${taskId}: ${err.message}`)
      );
    }
  }, backoffSeconds * 1000);
}

// --- Dead letter management ---

export function listDeadLetters(channelId?: string): DeadLetterRecord[] {
  const db = getDb();
  if (channelId) {
    return db.prepare("SELECT * FROM dead_letter WHERE channel_id = ? ORDER BY created_at DESC").all(channelId) as DeadLetterRecord[];
  }
  return db.prepare("SELECT * FROM dead_letter ORDER BY created_at DESC").all() as DeadLetterRecord[];
}

export function retryDeadLetter(deadLetterId: string): string | null {
  const db = getDb();
  const dl = db.prepare("SELECT * FROM dead_letter WHERE id = ?").get(deadLetterId) as DeadLetterRecord | null;
  if (!dl) return null;

  // Create a new task from the dead letter
  const newTaskId = submitTask({
    channelId: dl.channel_id,
    prompt: dl.prompt,
    agent: dl.agent || undefined,
    runtime: dl.runtime || undefined,
  });

  // Remove from dead letter
  db.prepare("DELETE FROM dead_letter WHERE id = ?").run(deadLetterId);

  return newTaskId;
}

export function pruneDeadLetters(olderThanDays: number = 7): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare("DELETE FROM dead_letter WHERE created_at < ?").run(cutoff);
  return result.changes;
}

// --- Crash recovery ---

export function recoverCrashedTasks(): number {
  const db = getDb();
  const stuckTasks = db.prepare(
    "SELECT * FROM task_queue WHERE status IN ('running', 'waiting_continue')"
  ).all() as TaskRecord[];

  let recovered = 0;
  for (const task of stuckTasks) {
    if (task.pid) {
      if (proc.isAlive(task.pid)) {
        // Process is alive — re-attach watcher
        if (task.output_file) {
          const watcher = new FileWatcher({
            filePath: task.output_file,
            onFile: (content: string) => {
              untrackWatcher(watcher);
              handleTaskOutput(task.id, content).catch((err) =>
                console.error(`[TASK] Recovery output error for ${task.id}: ${err.message}`)
              );
            },
            fallbackPollMs: 2000,
            retryReadMs: 100,
          });
          trackWatcher(watcher);
          watcher.start();

          // Register recovered task with monitor (stub — no historical tool calls)
          registerInstance({
            taskId: task.id,
            channelId: task.channel_id,
            agent: task.agent || "default",
            prompt: task.prompt || "(recovered)",
            pid: task.pid!,
            runtime: resolveTaskRuntime(task),
          });

          console.log(`[TASK] Re-attached watcher for alive task ${task.id} (PID ${task.pid})`);
        }
        continue;
      }
    }

    // Process is dead — trigger retry
    console.log(`[TASK] Recovering crashed task ${task.id}`);
    updateTask(task.id, { status: "failed", last_error: "Process crashed (recovery)" });
    handleFailure(task.id, "Process crashed during previous run").catch((err) =>
      console.error(`[TASK] Recovery failure handler error: ${err.message}`)
    );
    recovered++;
  }

  return recovered;
}

// --- Cancel ---

export function cancelTask(taskId: string): boolean {
  const task = getTask(taskId);
  if (!task || (task.status !== "running" && task.status !== "pending" && task.status !== "waiting_continue")) {
    return false;
  }

  if (task.pid) {
    proc.terminate(task.pid);
  }

  const promptFile = taskPromptFiles.get(taskId);
  if (promptFile && existsSync(promptFile)) {
    try { unlinkSync(promptFile); } catch {}
  }
  taskPromptFiles.delete(taskId);

  // Atomic update: set failed + prevent retry in a single statement
  getDb().prepare(
    "UPDATE task_queue SET status = 'failed', last_error = 'Cancelled by user', max_attempts = attempt, updated_at = ? WHERE id = ?"
  ).run(new Date().toISOString(), taskId);
  return true;
}

export function cancelChannelTasks(channelId: string): number {
  const db = getDb();
  // The `?` placeholder must be bound — passing channelId here. Missing
  // this arg threw `RangeError: Too few parameter values were provided`
  // and crashed the bot on every /stop, which is why /stop appeared to
  // "produce" Claude-exited-with-code-1 messages: the crash → launchd
  // restart → crash-recovery code retried the stale running task, and
  // the retry's transient failure was what the user saw.
  const tasks = db.prepare(
    "SELECT * FROM task_queue WHERE channel_id = ? AND status IN ('running', 'pending', 'waiting_continue')"
  ).all(channelId) as TaskRecord[];

  let cancelled = 0;
  for (const task of tasks) {
    if (cancelTask(task.id)) cancelled++;
  }
  return cancelled;
}
