import { spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { getDb } from "./db.js";
import { getSession, setSession, validateSession } from "./session-store.js";
import { getChannelConfig } from "./channel-config-store.js";
import { getProject, resolveProjectWorkdir } from "./project-manager.js";
import { getProjectSessionKey } from "./handoff-router.js";
import { FileWatcher, trackWatcher, untrackWatcher } from "./file-watcher.js";
import { assembleContext } from "./context-assembler.js";
import { readAgentPrompt, getToolRestrictionArgs } from "./agent-loader.js";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const TEMP_DIR = join(HARNESS_ROOT, "bridges", "discord", ".tmp");
const STREAM_DIR = join(TEMP_DIR, "streams");

// Global safety guardrails
const GLOBAL_DISALLOWED_TOOLS = [
  "Bash(rm -rf:*)",
  "Bash(git push --force:*)",
  "Bash(git reset --hard:*)",
  "Bash(DROP:*)",
  "Bash(DELETE FROM:*)",
  "Bash(kill -9:*)",
].join(",");

// Retry backoff: 5s, 25s, 125s (exponential base-5)
const RETRY_BACKOFF_BASE = 5;

export interface TaskConfig {
  channelId: string;
  prompt: string;
  agent?: string;
  sessionKey?: string;
  maxSteps?: number;
  maxAttempts?: number;
}

export interface TaskRecord {
  id: string;
  channel_id: string;
  prompt: string;
  agent: string | null;
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

export function onTaskOutput(handler: TaskOutputHandler): void {
  outputHandler = handler;
}

export function onTaskDeadLetter(handler: TaskDeadLetterHandler): void {
  deadLetterHandler = handler;
}

function generateId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Extract helpers (shared with bot.ts) ---

export function extractResponse(output: string): string | null {
  try {
    const jsonStart = output.indexOf('{"type"');
    if (jsonStart !== -1) {
      const jsonEnd = output.lastIndexOf("}") + 1;
      const parsed = JSON.parse(output.slice(jsonStart, jsonEnd));
      if (parsed.is_error) return `Error: ${parsed.result || "Unknown error"}`;
      const text = parsed.result || parsed.text || parsed.content;
      return text ? text.trim() : null;
    }
  } catch {}
  const match = output.match(/"result"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (match) {
    return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
  }
  return null;
}

export function extractSessionId(output: string): string | null {
  const match = output.match(/"session_id"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
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
    INSERT INTO task_queue (id, channel_id, prompt, agent, session_key, status, max_steps, max_attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(
    id,
    config.channelId,
    config.prompt,
    config.agent || null,
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

export async function spawnTask(taskId: string): Promise<{ pid: number; outputFile: string; streamDir: string } | null> {
  const task = getTask(taskId);
  if (!task) return null;

  try { mkdirSync(TEMP_DIR, { recursive: true }); } catch {}
  try { mkdirSync(STREAM_DIR, { recursive: true }); } catch {}

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const outputFile = join(TEMP_DIR, `response-${requestId}.json`);
  const streamDir = join(STREAM_DIR, requestId);

  // Build claude command args
  const args = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];

  // Channel config
  const channelConfig = getChannelConfig(task.channel_id);

  // Agent personality
  const agentName = task.agent || channelConfig?.agent;
  if (agentName) {
    const agentPrompt = readAgentPrompt(agentName);
    if (agentPrompt) {
      args.push("--append-system-prompt", agentPrompt);
    }
  }

  // Context injection (deterministic daemon)
  const context = await assembleContext({
    channelId: task.channel_id,
    prompt: task.prompt,
    agentName: agentName || "default",
    sessionKey: task.session_key || task.channel_id,
    taskId: task.id,
  });
  if (context) {
    args.push("--append-system-prompt", context);
  }

  // Permission mode
  if (channelConfig?.permissionMode) {
    args.push("--permission-mode", channelConfig.permissionMode);
  }

  // Model override
  if (channelConfig?.model) {
    args.push("--model", channelConfig.model);
  }

  // Safety guardrails
  args.push("--disallowedTools", GLOBAL_DISALLOWED_TOOLS);

  // Agent-specific tool restrictions (deterministic, enforced at CLI level)
  if (agentName) {
    const restrictionArgs = getToolRestrictionArgs(agentName);
    args.push(...restrictionArgs);
  }

  // Channel-specific allowed tools
  if (channelConfig?.allowedTools?.length) {
    args.push("--allowedTools", channelConfig.allowedTools.join(","));
  }

  // Channel-specific disallowed tools
  if (channelConfig?.disallowedTools?.length) {
    args.push("--disallowedTools", channelConfig.disallowedTools.join(","));
  }

  // Session resume
  const sessionKey = task.session_key || task.channel_id;
  const existingSession = getSession(sessionKey);

  // For continuation steps, always resume
  if (task.step_count > 0 && existingSession) {
    args.push("--resume", existingSession);
    // Continuation prompt
    args.push("--", "Continue where you left off. If you are done, do not include [CONTINUE].");
  } else if (existingSession) {
    args.push("--resume", existingSession);
    args.push("--", task.prompt);
  } else {
    args.push("--", task.prompt);
  }

  const pythonArgs = [
    `${HARNESS_ROOT}/bridges/discord/claude-runner.py`,
    outputFile,
    "--stream-dir",
    streamDir,
    ...args,
  ];

  // Resolve project working directory (passed via env to claude-runner.py)
  const project = getProject(task.channel_id);
  const projectCwd = project ? resolveProjectWorkdir(project.name) : null;

  const proc = spawn("python3", pythonArgs, {
    cwd: HARNESS_ROOT,
    env: {
      ...process.env,
      HARNESS_ROOT,
      ...(projectCwd ? { PROJECT_CWD: projectCwd } : {}),
    },
    detached: true,
    stdio: "ignore",
  });
  proc.unref();

  const pid = proc.pid!;

  updateTask(taskId, {
    status: "running",
    output_file: outputFile,
    pid,
    step_count: task.step_count + 1,
  });

  console.log(`[TASK] Spawned ${taskId} step ${task.step_count + 1}, PID ${pid}, agent: ${agentName || "default"}`);

  // Set up FileWatcher for the output file
  const watcher = new FileWatcher({
    filePath: outputFile,
    onFile: (content: string) => {
      untrackWatcher(watcher);
      handleTaskOutput(taskId, content).catch((err) =>
        console.error(`[TASK] Output handler error for ${taskId}: ${err.message}`)
      );
    },
    fallbackPollMs: 2000,
    retryReadMs: 100,
  });
  trackWatcher(watcher);
  watcher.start();

  return { pid, outputFile, streamDir };
}

async function handleTaskOutput(taskId: string, raw: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) return;

  try {
    // Clean up output file
    if (task.output_file && existsSync(task.output_file)) {
      unlinkSync(task.output_file);
    }

    const result = JSON.parse(raw);
    const { stdout, stderr, returncode } = result;

    console.log(`[TASK] ${taskId} returncode: ${returncode}, stdout length: ${(stdout || "").length}`);
    if (stderr) console.error(`[TASK STDERR] ${stderr.slice(0, 500)}`);

    // Check for stale session error
    if (
      returncode !== 0 &&
      task.attempt === 0 &&
      stderr?.includes("session") &&
      (stderr?.includes("not found") || stderr?.includes("expired"))
    ) {
      console.log(`[TASK] ${taskId} stale session detected, clearing and retrying`);
      const sessionKey = task.session_key || task.channel_id;
      validateSession(sessionKey);
      // Immediate retry (counts as attempt 1)
      updateTask(taskId, { attempt: 1, status: "pending", last_error: "Stale session - retrying" });
      await spawnTask(taskId);
      return;
    }

    if (returncode !== 0) {
      const errorMsg = stderr?.trim() || `Claude exited with code ${returncode}`;
      await handleFailure(taskId, errorMsg);
      // Notify handler of the error
      if (outputHandler) {
        await outputHandler(taskId, null, errorMsg, null, raw);
      }
      return;
    }

    const responseText = extractResponse(stdout);
    const sessionId = extractSessionId(stdout);

    // Save session
    if (sessionId) {
      const sessionKey = task.session_key || task.channel_id;
      setSession(sessionKey, sessionId);
    }

    // Check for continuation
    if (responseText && needsContinuation(responseText) && task.step_count < task.max_steps) {
      console.log(`[TASK] ${taskId} needs continuation (step ${task.step_count}/${task.max_steps})`);
      updateTask(taskId, { status: "waiting_continue" });

      // Notify handler of intermediate output
      if (outputHandler) {
        await outputHandler(taskId, responseText, null, sessionId, raw);
      }

      // Spawn next step
      await spawnTask(taskId);
      return;
    }

    // Task completed
    updateTask(taskId, { status: "completed" });
    console.log(`[TASK] ${taskId} completed after ${task.step_count} steps`);

    if (outputHandler) {
      await outputHandler(taskId, responseText, null, sessionId, raw);
    }
  } catch (err: any) {
    console.error(`[TASK] ${taskId} output processing error: ${err.message}`);
    await handleFailure(taskId, err.message);
    if (outputHandler) {
      await outputHandler(taskId, null, err.message, null, raw);
    }
  }
}

async function handleFailure(taskId: string, error: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) return;

  const nextAttempt = task.attempt + 1;

  if (nextAttempt >= task.max_attempts) {
    // Move to dead letter
    console.log(`[TASK] ${taskId} exhausted all ${task.max_attempts} attempts, moving to dead letter`);
    updateTask(taskId, { status: "dead", last_error: error });

    const db = getDb();
    const dlId = `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`
      INSERT INTO dead_letter (id, task_id, channel_id, prompt, agent, error, attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(dlId, taskId, task.channel_id, task.prompt, task.agent, error, nextAttempt);

    if (deadLetterHandler) {
      const dlRecord: DeadLetterRecord = {
        id: dlId,
        task_id: taskId,
        channel_id: task.channel_id,
        prompt: task.prompt,
        agent: task.agent,
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
  setTimeout(async () => {
    const current = getTask(taskId);
    if (current && current.status === "failed") {
      updateTask(taskId, { status: "pending", step_count: 0 });
      await spawnTask(taskId);
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
      try {
        process.kill(task.pid, 0); // Check if alive
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
          console.log(`[TASK] Re-attached watcher for alive task ${task.id} (PID ${task.pid})`);
        }
        continue;
      } catch {
        // Process is dead
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
    try {
      process.kill(task.pid, "SIGTERM");
    } catch {}
  }

  updateTask(taskId, { status: "failed", last_error: "Cancelled by user" });
  // Set max_attempts to prevent retry
  getDb().prepare("UPDATE task_queue SET max_attempts = attempt WHERE id = ?").run(taskId);
  return true;
}

export function cancelChannelTasks(channelId: string): number {
  const db = getDb();
  const tasks = db.prepare(
    "SELECT * FROM task_queue WHERE channel_id = ? AND status IN ('running', 'pending', 'waiting_continue')"
  ).all() as TaskRecord[];

  let cancelled = 0;
  for (const task of tasks) {
    if (cancelTask(task.id)) cancelled++;
  }
  return cancelled;
}
