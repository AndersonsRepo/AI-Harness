/**
 * tmux Parallel Orchestrator
 *
 * Enables the orchestrator agent to spawn multiple agents simultaneously
 * via [PARALLEL:agent1,agent2] directives. Each agent runs in its own
 * tmux window with independent file-based output collection.
 *
 * Flow:
 *   1. Orchestrator outputs [PARALLEL:researcher,builder] with per-agent tasks
 *   2. parseParallelDirective() extracts agents + task descriptions
 *   3. spawnParallelGroup() creates tmux windows, sets up FileWatchers
 *   4. As each agent completes, results are stored in parallel_tasks table
 *   5. When all agents finish, onGroupComplete fires aggregation
 *   6. Aggregated results are fed back to the orchestrator as [PARALLEL_COMPLETE]
 */

import { spawn } from "child_process";
import { join } from "path";
import { mkdirSync } from "fs";
import { getDb } from "./db.js";
import { getProject, resolveProjectWorkdir } from "./project-manager.js";
import { FileWatcher, trackWatcher, untrackWatcher } from "./file-watcher.js";
import { submitTask } from "./task-runner.js";
import { setSession } from "./session-store.js";
import * as tmux from "./tmux-session.js";
import { needsWorktree, createWorktree, mergeWorktree, removeWorktree, getWorktreeForGroup, isGitRepo } from "./worktree-manager.js";
import {
  HARNESS_ROOT,
  extractResponse,
  extractSessionId,
  buildClaudeConfig,
} from "./claude-config.js";

const TEMP_DIR = join(HARNESS_ROOT, "bridges", "discord", ".tmp");
const STREAM_DIR = join(TEMP_DIR, "streams");
const PARALLEL_TIMEOUT_MS = parseInt(process.env.PARALLEL_TIMEOUT_MS || "1800000", 10);

/**
 * Resolve agent label to actual agent name.
 * Supports numbered labels like "builder-1" → "builder" for parallel same-agent groups.
 */
function resolveAgentName(label: string): string {
  return label.replace(/-\d+$/, "");
}

// ─── Types ──────────────────────────────────────────────────────────

export interface ParallelDirective {
  agents: string[];
  tasks: Map<string, string>; // agent label → task description
}

export interface ParallelGroupOptions {
  channelId: string;
  parentTaskId?: string;
  directive: ParallelDirective;
}

export interface ParallelTaskRecord {
  group_id: string;
  task_id: string;
  parent_task_id: string | null;
  channel_id: string;
  agent: string;
  description: string;
  tmux_window: string | null;
  status: string;
  result: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface GroupStatus {
  groupId: string;
  channelId: string;
  tasks: ParallelTaskRecord[];
  allComplete: boolean;
  anyFailed: boolean;
}

// ─── Callbacks ──────────────────────────────────────────────────────

type GroupCompleteCallback = (groupId: string, status: GroupStatus) => Promise<void>;
const groupCompleteCallbacks: GroupCompleteCallback[] = [];

export function onGroupComplete(callback: GroupCompleteCallback): void {
  groupCompleteCallbacks.push(callback);
}

// ─── Parsing ────────────────────────────────────────────────────────

/**
 * Parse a [PARALLEL:agent1,agent2] directive from agent output.
 *
 * Expected format:
 *   [PARALLEL:researcher,builder]
 *   ## researcher
 *   Task description for researcher...
 *
 *   ## builder
 *   Task description for builder...
 */
export function parseParallelDirective(output: string): ParallelDirective | null {
  const match = output.match(/\[PARALLEL:([a-z,_-]+)\]/i);
  if (!match) return null;

  const agents = match[1].split(",").map((a) => a.trim().toLowerCase());
  if (agents.length < 2) {
    console.warn(`[PARALLEL] Need at least 2 agents, got ${agents.length}`);
    return null;
  }

  // Parse per-agent task descriptions
  const tasks = new Map<string, string>();
  for (const agent of agents) {
    // Look for ## agent or ## agentname header
    const headerRegex = new RegExp(`##\\s*${agent}\\s*\\n([\\s\\S]*?)(?=##\\s*\\w|$)`, "i");
    const taskMatch = output.match(headerRegex);
    if (taskMatch && taskMatch[1].trim()) {
      tasks.set(agent, taskMatch[1].trim());
    } else {
      console.warn(`[PARALLEL] No task description found for agent "${agent}"`);
      return null;
    }
  }

  return { agents, tasks };
}

// ─── Group Management ───────────────────────────────────────────────

function generateGroupId(): string {
  return `grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function windowName(agent: string, groupId: string): string {
  const shortId = groupId.split("-").pop() || groupId.slice(-4);
  return `${agent}-${shortId}`;
}

function insertParallelTask(record: Omit<ParallelTaskRecord, "created_at">): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO parallel_tasks (group_id, task_id, parent_task_id, channel_id, agent, description, tmux_window, status, result, error, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.group_id, record.task_id, record.parent_task_id, record.channel_id,
    record.agent, record.description, record.tmux_window, record.status,
    record.result, record.error, record.started_at, record.completed_at,
  );
}

function updateParallelTask(groupId: string, taskId: string, updates: Partial<ParallelTaskRecord>): void {
  const db = getDb();
  const fields: string[] = [];
  const values: any[] = [];
  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }
  values.push(groupId, taskId);
  db.prepare(`UPDATE parallel_tasks SET ${fields.join(", ")} WHERE group_id = ? AND task_id = ?`).run(...values);
}

export function getGroupStatus(groupId: string): GroupStatus | null {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM parallel_tasks WHERE group_id = ?").all(groupId) as ParallelTaskRecord[];
  if (rows.length === 0) return null;

  const terminal = ["completed", "failed", "cancelled"];
  return {
    groupId,
    channelId: rows[0].channel_id,
    tasks: rows,
    allComplete: rows.every((r) => terminal.includes(r.status)),
    anyFailed: rows.some((r) => r.status === "failed"),
  };
}

export function getActiveGroups(): GroupStatus[] {
  const db = getDb();
  const groupIds = db.prepare(
    "SELECT DISTINCT group_id FROM parallel_tasks WHERE status IN ('pending', 'running')"
  ).all() as { group_id: string }[];

  return groupIds
    .map((r) => getGroupStatus(r.group_id))
    .filter((s): s is GroupStatus => s !== null);
}

// ─── Spawning ───────────────────────────────────────────────────────

/**
 * Spawn a parallel group of agents. Each agent gets its own tmux window
 * and claude-runner.py process. Results are collected via FileWatchers.
 */
export async function spawnParallelGroup(opts: ParallelGroupOptions): Promise<string> {
  const groupId = generateGroupId();
  const { channelId, parentTaskId, directive } = opts;

  console.log(`[PARALLEL] Spawning group ${groupId}: ${directive.agents.join(", ")}`);

  try { mkdirSync(TEMP_DIR, { recursive: true }); } catch {}
  try { mkdirSync(STREAM_DIR, { recursive: true }); } catch {}

  // Ensure tmux session exists
  tmux.ensureSession();

  // Create worktree if any agents are writers and project is a git repo
  let worktreePath: string | null = null;
  if (needsWorktree(directive.agents)) {
    const project = getProject(channelId);
    const projectCwd = project ? resolveProjectWorkdir(project.name) : null;
    if (projectCwd && isGitRepo(projectCwd)) {
      const wt = createWorktree(projectCwd, project!.name, groupId, channelId, { groupId });
      if (wt) {
        worktreePath = wt.worktree_path;
        console.log(`[PARALLEL] Worktree created for group ${groupId}: ${worktreePath}`);
      }
    }
  }

  for (const agent of directive.agents) {
    const description = directive.tasks.get(agent)!;
    const taskId = `par-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const winName = windowName(agent, groupId);

    await spawnParallelAgent(groupId, taskId, channelId, agent, description, winName, parentTaskId, worktreePath);
  }

  return groupId;
}

async function spawnParallelAgent(
  groupId: string,
  taskId: string,
  channelId: string,
  agent: string,
  description: string,
  winName: string,
  parentTaskId?: string,
  worktreePath?: string | null,
): Promise<void> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const outputFile = join(TEMP_DIR, `response-${requestId}.json`);
  const streamDir = join(STREAM_DIR, requestId);

  // Resolve numbered labels (e.g., "builder-1" → "builder") for agent personality/tools
  const resolvedAgent = resolveAgentName(agent);

  // Build shared config — no session resume for parallel tasks (fresh context)
  const config = await buildClaudeConfig({
    channelId,
    prompt: description,
    agentName: resolvedAgent,
    sessionKey: `${channelId}:${agent}`,
    taskId,
    skipSessionResume: true,
    worktreePath,
  });

  const pythonArgs = [
    `${HARNESS_ROOT}/bridges/discord/claude-runner.py`,
    outputFile,
    "--stream-dir",
    streamDir,
    ...config.args,
  ];

  const childProc = spawn("python3", pythonArgs, {
    cwd: config.cwd,
    env: config.env,
    detached: true,
    stdio: "ignore",
  });
  childProc.unref();

  const pid = childProc.pid!;

  // Also try to create a tmux window for visibility
  const cmdStr = `python3 ${pythonArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;
  tmux.createWindow(winName, `echo "PID: ${pid} | Agent: ${agent} | Group: ${groupId}" && sleep infinity`);

  // Record in database
  insertParallelTask({
    group_id: groupId, task_id: taskId, parent_task_id: parentTaskId || null,
    channel_id: channelId, agent, description, tmux_window: winName,
    status: "running", result: null, error: null,
    started_at: new Date().toISOString(), completed_at: null,
  });

  console.log(`[PARALLEL] Spawned ${agent} (${taskId}) PID ${pid}, window: ${winName}`);

  // FileWatcher for output
  const watcher = new FileWatcher({
    filePath: outputFile,
    onFile: (content: string) => {
      untrackWatcher(watcher);
      handleParallelOutput(groupId, taskId, agent, winName, content).catch((err) => {
        console.error(`[PARALLEL] Output handler error for ${taskId}: ${err.message}`);
        updateParallelTask(groupId, taskId, {
          status: "failed",
          error: `Output handler crash: ${err.message}`,
          completed_at: new Date().toISOString(),
        });
        checkGroupCompletion(groupId);
      });
    },
    onTimeout: () => {
      untrackWatcher(watcher);
      console.error(`[PARALLEL] Timeout for ${agent} (${taskId})`);
      updateParallelTask(groupId, taskId, {
        status: "failed",
        error: "Timed out",
        completed_at: new Date().toISOString(),
      });
      tmux.killWindow(winName);
      checkGroupCompletion(groupId);
    },
    timeoutMs: PARALLEL_TIMEOUT_MS,
    retryReadMs: 100,
    fallbackPollMs: 3000,
  });
  trackWatcher(watcher);
  watcher.start();
}

// ─── Output Handling ────────────────────────────────────────────────

async function handleParallelOutput(
  groupId: string,
  taskId: string,
  agent: string,
  winName: string,
  rawContent: string,
): Promise<void> {
  let parsed: any;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    updateParallelTask(groupId, taskId, {
      status: "failed",
      error: "Failed to parse output JSON",
      completed_at: new Date().toISOString(),
    });
    tmux.killWindow(winName);
    checkGroupCompletion(groupId);
    return;
  }

  const stdout = parsed.stdout || "";
  const stderr = parsed.stderr || "";
  const returncode = parsed.returncode ?? 1;

  if (returncode !== 0) {
    const errorMsg = stderr.trim() || `Claude exited with code ${returncode}`;
    console.error(`[PARALLEL] ${agent} (${taskId}) failed: ${errorMsg.slice(0, 100)}`);
    updateParallelTask(groupId, taskId, {
      status: "failed",
      error: errorMsg.slice(0, 2000),
      completed_at: new Date().toISOString(),
    });
  } else {
    const responseText = extractResponse(stdout);
    const sessionId = extractSessionId(stdout);

    // Save session for potential follow-up
    if (sessionId) {
      setSession(`${getGroupStatus(groupId)?.channelId}:${agent}`, sessionId);
    }

    // Truncate result for storage (keep full response manageable)
    const truncatedResult = responseText
      ? responseText.slice(0, 4000)
      : "(empty response)";

    console.log(`[PARALLEL] ${agent} (${taskId}) completed: ${truncatedResult.length} chars`);
    updateParallelTask(groupId, taskId, {
      status: "completed",
      result: truncatedResult,
      completed_at: new Date().toISOString(),
    });
  }

  // Clean up tmux window
  tmux.killWindow(winName);

  // Check if the whole group is done
  checkGroupCompletion(groupId);
}

// ─── Group Completion ───────────────────────────────────────────────

function checkGroupCompletion(groupId: string): void {
  const status = getGroupStatus(groupId);
  if (!status || !status.allComplete) return;

  console.log(`[PARALLEL] Group ${groupId} complete — ${status.tasks.length} tasks, ${status.anyFailed ? "with failures" : "all succeeded"}`);

  // Handle worktree merge + cleanup
  const wt = getWorktreeForGroup(groupId);
  if (wt) {
    if (!status.anyFailed) {
      const mergeResult = mergeWorktree(wt.id);
      console.log(`[PARALLEL] Worktree merge for ${groupId}: ${mergeResult.status} — ${mergeResult.details}`);
    }
    removeWorktree(wt.id);
  }

  // Fire callbacks
  for (const cb of groupCompleteCallbacks) {
    cb(groupId, status).catch((err) => {
      console.error(`[PARALLEL] Group complete callback error: ${err.message}`);
    });
  }
}

/**
 * Build the aggregation prompt that feeds parallel results back to the orchestrator.
 */
export function buildAggregationPrompt(status: GroupStatus): string {
  const sections: string[] = [`[PARALLEL_COMPLETE:${status.groupId}]\n`];

  for (const task of status.tasks) {
    const statusLabel = task.status === "completed" ? "completed" : `FAILED: ${task.error || "unknown error"}`;
    sections.push(`## ${task.agent} (${statusLabel})`);
    if (task.result) {
      sections.push(task.result);
    } else if (task.error) {
      sections.push(`No result available. Error: ${task.error}`);
    } else {
      sections.push("No result available.");
    }
    sections.push(""); // blank line separator
  }

  sections.push("Synthesize these results and determine next steps. If more work is needed, use [HANDOFF:agent] for sequential follow-up or [PARALLEL:...] for another parallel batch.");

  return sections.join("\n");
}

// ─── Cancellation ───────────────────────────────────────────────────

/**
 * Cancel all running tasks in a parallel group.
 */
export function cancelGroup(groupId: string): number {
  const status = getGroupStatus(groupId);
  if (!status) return 0;

  let cancelled = 0;
  for (const task of status.tasks) {
    if (task.status === "running" || task.status === "pending") {
      updateParallelTask(groupId, task.task_id, {
        status: "cancelled",
        completed_at: new Date().toISOString(),
      });
      if (task.tmux_window) {
        tmux.killWindow(task.tmux_window);
      }
      cancelled++;
    }
  }

  console.log(`[PARALLEL] Cancelled ${cancelled} task(s) in group ${groupId}`);
  return cancelled;
}

// ─── Cleanup ────────────────────────────────────────────────────────

/**
 * Prune old parallel_tasks records (>7 days).
 */
export function pruneOldGroups(daysOld: number = 7): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare("DELETE FROM parallel_tasks WHERE created_at < ?").run(cutoff);
  return result.changes;
}

/**
 * Get active tmux window names for cleanup.
 */
export function getActiveWindowNames(): Set<string> {
  const names = new Set<string>();
  const activeGroups = getActiveGroups();
  for (const group of activeGroups) {
    for (const task of group.tasks) {
      if (task.tmux_window && (task.status === "running" || task.status === "pending")) {
        names.add(task.tmux_window);
      }
    }
  }
  return names;
}
