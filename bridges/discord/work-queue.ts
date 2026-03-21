/**
 * Autonomous Work Queue
 *
 * Self-directed task queue that agents and heartbeats can enqueue work into.
 * The dispatcher tick runs periodically, checks gates, resolves dependencies,
 * and spawns tasks through the existing task-runner pipeline.
 *
 * Priority levels:
 *   90+ = urgent (user-requested, error recovery)
 *   50  = normal (heartbeat-generated, scheduled work)
 *   20  = low (background maintenance, learning extraction)
 *
 * Gates:
 *   - active-hours: only dispatch during configured hours
 *   - dependency: blocked until depends_on item completes
 *   - cooldown: respect per-source rate limits
 *   - capacity: defer if too many tasks running globally
 *
 * Sources: heartbeat, code-review, session-debrief, manual, self-improvement, agent, ideation
 *
 * Ideation flow:
 *   proposed → (user approves) → approved → pending → running → completed
 *   proposed → (user rejects) → cancelled
 */

import { getDb } from "./db.js";
import {
  submitTask,
  spawnTask,
  getTask,
  getGlobalRunningCount,
  type TaskRecord,
} from "./task-runner.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface WorkItem {
  id: string;
  source: string;
  source_id: string | null;
  channel_id: string;
  prompt: string;
  agent: string | null;
  priority: number;
  status: string;
  gate_reason: string | null;
  depends_on: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  task_id: string | null;
  attempt: number;
  max_attempts: number;
  last_error: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueOptions {
  source: string;
  sourceId?: string;
  channelId: string;
  prompt: string;
  agent?: string;
  priority?: number;
  dependsOn?: string;
  scheduledAt?: string;
  metadata?: Record<string, any>;
  maxAttempts?: number;
}

export type GateCheckResult = { pass: true } | { pass: false; reason: string };

// ─── Configuration ──────────────────────────────────────────────────────

/** Max concurrent work-queue-spawned tasks (separate from user-initiated tasks) */
let maxConcurrentWork = 3;

/** Active hours (24h format). Null = always active. */
let activeHoursStart = 7; // 7 AM
let activeHoursEnd = 23;  // 11 PM

/** Per-source cooldowns in ms */
const sourceCooldowns: Record<string, number> = {
  "code-review": 30 * 60 * 1000,        // 30 min between code reviews
  "session-debrief": 15 * 60 * 1000,     // 15 min between debriefs
  "self-improvement": 60 * 60 * 1000,    // 1h between self-improvement tasks
  "ideation-gen": 6 * 60 * 60 * 1000,    // 6h between ideation runs
};

/** Dispatch tick interval */
const DISPATCH_INTERVAL_MS = 30_000; // 30 seconds

let dispatchTimer: ReturnType<typeof setInterval> | null = null;
let dispatchCallback: ((item: WorkItem, taskId: string) => Promise<void>) | null = null;

/**
 * Pre-dispatch interceptor. If set, called before normal dispatch.
 * Return true if the interceptor handled the item (skip normal dispatch).
 */
let preDispatchInterceptor: ((item: WorkItem) => Promise<boolean>) | null = null;

// ─── ID Generation ──────────────────────────────────────────────────────

function generateWorkId(): string {
  return `wq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── CRUD ───────────────────────────────────────────────────────────────

export function enqueue(opts: EnqueueOptions): string {
  const db = getDb();
  const id = generateWorkId();
  const now = new Date().toISOString();

  // Check for duplicate: same source + sourceId still pending/gated/running
  if (opts.sourceId) {
    const existing = db.prepare(
      "SELECT id FROM work_queue WHERE source = ? AND source_id = ? AND status IN ('pending', 'gated', 'running')"
    ).get(opts.source, opts.sourceId) as { id: string } | undefined;
    if (existing) {
      return existing.id; // Deduplicate — return existing item
    }
  }

  // Check for any active item from the same source (prevent overlapping iterations)
  if (opts.sourceId && opts.metadata) {
    const project = (opts.metadata as any).project;
    if (project) {
      const activeItem = db.prepare(
        "SELECT id FROM work_queue WHERE source = ? AND status = 'running' AND metadata LIKE ?"
      ).get(opts.source, `%"project":"${project}"%`) as { id: string } | undefined;
      if (activeItem) {
        console.log(`[WORK-QUEUE] Skipped enqueue — ${project} already has running item ${activeItem.id}`);
        return activeItem.id;
      }
    }
  }

  // Determine initial status
  let status: "pending" | "gated" = "pending";
  let gateReason: string | null = null;

  // Check if it should be gated
  if (opts.scheduledAt && new Date(opts.scheduledAt) > new Date()) {
    status = "gated";
    gateReason = `scheduled:${opts.scheduledAt}`;
  }
  if (opts.dependsOn) {
    const dep = getWorkItem(opts.dependsOn);
    if (dep && dep.status !== "completed") {
      status = "gated";
      gateReason = `dependency:${opts.dependsOn}`;
    }
  }

  db.prepare(`
    INSERT INTO work_queue (id, source, source_id, channel_id, prompt, agent, priority, status, gate_reason, depends_on, scheduled_at, max_attempts, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.source,
    opts.sourceId || null,
    opts.channelId,
    opts.prompt,
    opts.agent || null,
    opts.priority ?? 50,
    status,
    gateReason,
    opts.dependsOn || null,
    opts.scheduledAt || null,
    opts.maxAttempts ?? 3,
    opts.metadata ? JSON.stringify(opts.metadata) : null,
    now,
    now
  );

  console.log(`[WORK-QUEUE] Enqueued ${id} (source=${opts.source}, priority=${opts.priority ?? 50}, status=${status})`);
  return id;
}

export function getWorkItem(id: string): WorkItem | null {
  return getDb().prepare("SELECT * FROM work_queue WHERE id = ?").get(id) as WorkItem | null;
}

export function updateWorkItem(id: string, updates: Partial<WorkItem>): void {
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
  db.prepare(`UPDATE work_queue SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function cancelWorkItem(id: string): boolean {
  const item = getWorkItem(id);
  if (!item || item.status === "completed" || item.status === "cancelled") return false;
  updateWorkItem(id, { status: "cancelled" });
  console.log(`[WORK-QUEUE] Cancelled ${id}`);
  return true;
}

// ─── Proposal / Approval ────────────────────────────────────────────────

/** Create a proposed work item (requires user approval before execution) */
export function propose(opts: Omit<EnqueueOptions, "source"> & {
  title: string;
  rationale: string;
  estimatedEffort?: string;
  category?: "portfolio" | "revenue" | "infrastructure" | "learning";
}): string {
  const db = getDb();
  const id = generateWorkId();
  const now = new Date().toISOString();

  // Dedup by title similarity — don't re-propose the same idea
  if (opts.sourceId) {
    const existing = db.prepare(
      "SELECT id FROM work_queue WHERE source = 'ideation' AND source_id = ? AND status IN ('proposed', 'approved', 'pending', 'running')"
    ).get(opts.sourceId) as { id: string } | undefined;
    if (existing) return existing.id;
  }

  const metadata = {
    ...opts.metadata,
    title: opts.title,
    rationale: opts.rationale,
    estimatedEffort: opts.estimatedEffort || "unknown",
    category: opts.category || "portfolio",
  };

  db.prepare(`
    INSERT INTO work_queue (id, source, source_id, channel_id, prompt, agent, priority, status, gate_reason, depends_on, scheduled_at, max_attempts, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', 'awaiting-approval', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    "ideation",
    opts.sourceId || `idea:${Date.now()}`,
    opts.channelId,
    opts.prompt,
    opts.agent || null,
    opts.priority ?? 50,
    opts.dependsOn || null,
    opts.scheduledAt || null,
    opts.maxAttempts ?? 3,
    JSON.stringify(metadata),
    now,
    now
  );

  console.log(`[WORK-QUEUE] Proposed ${id}: "${opts.title}" (${opts.category || "portfolio"})`);
  return id;
}

/** Approve a proposed idea — moves it to pending for dispatch */
export function approveProposal(id: string): boolean {
  const item = getWorkItem(id);
  if (!item || item.status !== "proposed") return false;
  updateWorkItem(id, { status: "pending", gate_reason: null });
  console.log(`[WORK-QUEUE] Approved proposal ${id}`);
  return true;
}

/** Reject a proposed idea */
export function rejectProposal(id: string): boolean {
  const item = getWorkItem(id);
  if (!item || item.status !== "proposed") return false;
  updateWorkItem(id, { status: "cancelled", gate_reason: "rejected-by-user" });
  console.log(`[WORK-QUEUE] Rejected proposal ${id}`);
  return true;
}

/** Get all proposed (awaiting approval) items */
export function getProposedWork(): WorkItem[] {
  return getDb().prepare(
    "SELECT * FROM work_queue WHERE status = 'proposed' ORDER BY priority DESC, created_at ASC"
  ).all() as WorkItem[];
}

/** Parse metadata JSON safely */
export function parseMetadata(item: WorkItem): Record<string, any> {
  try {
    return item.metadata ? JSON.parse(item.metadata) : {};
  } catch {
    return {};
  }
}

// ─── Query ──────────────────────────────────────────────────────────────

export function getPendingWork(): WorkItem[] {
  return getDb().prepare(
    "SELECT * FROM work_queue WHERE status = 'pending' ORDER BY priority DESC, created_at ASC"
  ).all() as WorkItem[];
}

export function getGatedWork(): WorkItem[] {
  return getDb().prepare(
    "SELECT * FROM work_queue WHERE status = 'gated' ORDER BY priority DESC, created_at ASC"
  ).all() as WorkItem[];
}

export function getRunningWork(): WorkItem[] {
  return getDb().prepare(
    "SELECT * FROM work_queue WHERE status = 'running' ORDER BY started_at ASC"
  ).all() as WorkItem[];
}

export function getWorkBySource(source: string, limit = 20): WorkItem[] {
  return getDb().prepare(
    "SELECT * FROM work_queue WHERE source = ? ORDER BY created_at DESC LIMIT ?"
  ).all(source, limit) as WorkItem[];
}

export function getWorkStats(): {
  proposed: number;
  approved: number;
  pending: number;
  gated: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
} {
  const db = getDb();
  const rows = db.prepare(
    "SELECT status, COUNT(*) as c FROM work_queue GROUP BY status"
  ).all() as { status: string; c: number }[];

  const stats = { proposed: 0, approved: 0, pending: 0, gated: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const row of rows) {
    if (row.status in stats) {
      (stats as any)[row.status] = row.c;
    }
  }
  return stats;
}

export function getRecentWork(limit = 20): WorkItem[] {
  return getDb().prepare(
    "SELECT * FROM work_queue ORDER BY created_at DESC LIMIT ?"
  ).all(limit) as WorkItem[];
}

// ─── Gate Logic ─────────────────────────────────────────────────────────

function checkActiveHours(): GateCheckResult {
  const hour = new Date().getHours();
  if (hour >= activeHoursStart && hour < activeHoursEnd) {
    return { pass: true };
  }
  return { pass: false, reason: `outside-active-hours:${activeHoursStart}-${activeHoursEnd}` };
}

function checkDependency(item: WorkItem): GateCheckResult {
  if (!item.depends_on) return { pass: true };
  const dep = getWorkItem(item.depends_on);
  if (!dep) return { pass: true }; // Dependency deleted — allow
  if (dep.status === "completed") return { pass: true };
  if (dep.status === "failed" || dep.status === "cancelled") {
    return { pass: false, reason: `dependency-failed:${dep.id}` };
  }
  return { pass: false, reason: `dependency-pending:${dep.id}` };
}

function checkSchedule(item: WorkItem): GateCheckResult {
  if (!item.scheduled_at) return { pass: true };
  if (new Date(item.scheduled_at) <= new Date()) return { pass: true };
  return { pass: false, reason: `scheduled:${item.scheduled_at}` };
}

function checkSourceCooldown(item: WorkItem): GateCheckResult {
  const cooldownMs = sourceCooldowns[item.source];
  if (!cooldownMs) return { pass: true };

  const db = getDb();
  const lastCompleted = db.prepare(
    "SELECT completed_at FROM work_queue WHERE source = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1"
  ).get(item.source) as { completed_at: string } | undefined;

  if (!lastCompleted) return { pass: true };

  const elapsed = Date.now() - new Date(lastCompleted.completed_at).getTime();
  if (elapsed >= cooldownMs) return { pass: true };

  const remainingSec = Math.ceil((cooldownMs - elapsed) / 1000);
  return { pass: false, reason: `cooldown:${item.source}:${remainingSec}s` };
}

function checkCapacity(): GateCheckResult {
  const runningWork = getRunningWork().length;
  if (runningWork < maxConcurrentWork) return { pass: true };
  return { pass: false, reason: `capacity:${runningWork}/${maxConcurrentWork}` };
}

/** Run all gate checks for a work item. Returns first failure or pass. */
function checkGates(item: WorkItem): GateCheckResult {
  // Priority 90+ items bypass active hours (urgent work)
  if (item.priority < 90) {
    const hours = checkActiveHours();
    if (!hours.pass) return hours;
  }

  const schedule = checkSchedule(item);
  if (!schedule.pass) return schedule;

  const dep = checkDependency(item);
  if (!dep.pass) return dep;

  const cooldown = checkSourceCooldown(item);
  if (!cooldown.pass) return cooldown;

  const capacity = checkCapacity();
  if (!capacity.pass) return capacity;

  return { pass: true };
}

// ─── Gate Promotion ─────────────────────────────────────────────────────

/** Re-evaluate gated items — promote to pending if gates now pass */
function promoteGatedItems(): number {
  const gated = getGatedWork();
  let promoted = 0;

  for (const item of gated) {
    // Check if dependency failed → cancel
    if (item.depends_on) {
      const dep = getWorkItem(item.depends_on);
      if (dep && (dep.status === "failed" || dep.status === "cancelled")) {
        updateWorkItem(item.id, { status: "cancelled", gate_reason: `dependency-failed:${dep.id}` });
        console.log(`[WORK-QUEUE] Cancelled ${item.id} — dependency ${dep.id} ${dep.status}`);
        continue;
      }
    }

    // Check schedule gate
    const schedule = checkSchedule(item);
    if (!schedule.pass) continue;

    // Check dependency gate
    const depCheck = checkDependency(item);
    if (!depCheck.pass) continue;

    // Promote to pending
    updateWorkItem(item.id, { status: "pending", gate_reason: null });
    promoted++;
    console.log(`[WORK-QUEUE] Promoted ${item.id} from gated to pending`);
  }

  return promoted;
}

// ─── Dispatch ───────────────────────────────────────────────────────────

/** Pick the next eligible work item and spawn it through task-runner */
async function dispatchNext(): Promise<boolean> {
  const pending = getPendingWork();
  if (pending.length === 0) return false;

  for (const item of pending) {
    const gate = checkGates(item);
    if (!gate.pass) {
      // Move back to gated if it was pending but now blocked
      if (item.status === "pending") {
        updateWorkItem(item.id, { status: "gated", gate_reason: gate.reason });
      }
      continue;
    }

    // All gates pass — dispatch this item
    try {
      // Check pre-dispatch interceptor (for parallel spawns, etc.)
      if (preDispatchInterceptor) {
        const handled = await preDispatchInterceptor(item);
        if (handled) {
          console.log(`[WORK-QUEUE] ${item.id} handled by interceptor`);
          return true;
        }
      }

      const taskId = submitTask({
        channelId: item.channel_id,
        prompt: item.prompt,
        agent: item.agent || undefined,
        maxSteps: 10,
        maxAttempts: item.max_attempts,
      });

      updateWorkItem(item.id, {
        status: "running",
        task_id: taskId,
        started_at: new Date().toISOString(),
        attempt: item.attempt + 1,
      });

      const spawnResult = await spawnTask(taskId);
      if (!spawnResult) {
        updateWorkItem(item.id, {
          status: "pending",
          task_id: null,
          started_at: null,
          last_error: "Failed to spawn task",
        });
        continue;
      }

      console.log(`[WORK-QUEUE] Dispatched ${item.id} → task ${taskId} (source=${item.source}, priority=${item.priority})`);

      if (dispatchCallback) {
        await dispatchCallback(item, taskId).catch((err) =>
          console.error(`[WORK-QUEUE] Dispatch callback error: ${err.message}`)
        );
      }

      return true;
    } catch (err: any) {
      console.error(`[WORK-QUEUE] Dispatch error for ${item.id}: ${err.message}`);
      updateWorkItem(item.id, { last_error: err.message });
    }
  }

  return false;
}

/** Main dispatch tick — called periodically */
export async function dispatchTick(): Promise<{ promoted: number; dispatched: number }> {
  let promoted = 0;
  let dispatched = 0;

  try {
    // Phase 1: Promote gated items whose gates now pass
    promoted = promoteGatedItems();

    // Phase 2: Sync running items — mark completed/failed based on task-runner status
    syncRunningItems();

    // Phase 3: Dispatch pending items (up to capacity)
    const capacity = maxConcurrentWork - getRunningWork().length;
    for (let i = 0; i < capacity; i++) {
      const didDispatch = await dispatchNext();
      if (didDispatch) dispatched++;
      else break;
    }
  } catch (err: any) {
    console.error(`[WORK-QUEUE] Dispatch tick error: ${err.message}`);
  }

  if (promoted > 0 || dispatched > 0) {
    console.log(`[WORK-QUEUE] Tick: promoted=${promoted}, dispatched=${dispatched}`);
  }

  return { promoted, dispatched };
}

/** Check task-runner for completed/failed tasks and update work items */
function syncRunningItems(): void {
  const running = getRunningWork();
  for (const item of running) {
    if (!item.task_id) {
      // No task ID — shouldn't happen, recover
      updateWorkItem(item.id, { status: "pending", started_at: null });
      continue;
    }

    const task = getTask(item.task_id) as TaskRecord | null;
    if (!task) {
      // Task deleted — mark as failed
      updateWorkItem(item.id, { status: "failed", last_error: "Task record not found" });
      continue;
    }

    if (task.status === "completed") {
      updateWorkItem(item.id, { status: "completed", completed_at: new Date().toISOString() });
      console.log(`[WORK-QUEUE] ${item.id} completed (task ${item.task_id})`);
    } else if (task.status === "dead" || task.status === "failed") {
      // Check retry
      if (item.attempt < item.max_attempts) {
        updateWorkItem(item.id, {
          status: "pending",
          task_id: null,
          started_at: null,
          last_error: task.last_error || "Task failed",
        });
        console.log(`[WORK-QUEUE] ${item.id} failed, will retry (${item.attempt}/${item.max_attempts})`);
      } else {
        updateWorkItem(item.id, {
          status: "failed",
          last_error: task.last_error || "All attempts exhausted",
          completed_at: new Date().toISOString(),
        });
        console.log(`[WORK-QUEUE] ${item.id} permanently failed after ${item.attempt} attempts`);
      }
    }
    // running/waiting_continue/pending — still in progress, leave it
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────

/** Start the dispatch loop */
export function startDispatcher(): void {
  if (dispatchTimer) return;
  dispatchTimer = setInterval(() => {
    dispatchTick().catch((err) =>
      console.error(`[WORK-QUEUE] Tick error: ${err.message}`)
    );
  }, DISPATCH_INTERVAL_MS);
  console.log(`[WORK-QUEUE] Dispatcher started (interval=${DISPATCH_INTERVAL_MS / 1000}s, capacity=${maxConcurrentWork})`);

  // Run first tick immediately
  dispatchTick().catch((err) =>
    console.error(`[WORK-QUEUE] Initial tick error: ${err.message}`)
  );
}

/** Stop the dispatch loop */
export function stopDispatcher(): void {
  if (dispatchTimer) {
    clearInterval(dispatchTimer);
    dispatchTimer = null;
    console.log("[WORK-QUEUE] Dispatcher stopped");
  }
}

/** Set callback for when a work item is dispatched */
export function onWorkDispatched(callback: (item: WorkItem, taskId: string) => Promise<void>): void {
  dispatchCallback = callback;
}

/** Set pre-dispatch interceptor for special items (parallel spawns, etc.) */
export function setPreDispatchInterceptor(handler: (item: WorkItem) => Promise<boolean>): void {
  preDispatchInterceptor = handler;
}

// ─── Configuration ──────────────────────────────────────────────────────

export function setMaxConcurrent(n: number): void {
  maxConcurrentWork = Math.max(1, n);
  console.log(`[WORK-QUEUE] Max concurrent set to ${maxConcurrentWork}`);
}

export function setActiveHours(start: number, end: number): void {
  activeHoursStart = start;
  activeHoursEnd = end;
  console.log(`[WORK-QUEUE] Active hours: ${start}:00-${end}:00`);
}

export function getConfig(): { maxConcurrent: number; activeHoursStart: number; activeHoursEnd: number; dispatchIntervalMs: number } {
  return { maxConcurrent: maxConcurrentWork, activeHoursStart, activeHoursEnd, dispatchIntervalMs: DISPATCH_INTERVAL_MS };
}

// ─── Cleanup ────────────────────────────────────────────────────────────

/** Prune old completed/failed/cancelled items */
export function pruneOldWork(olderThanDays = 7): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(
    "DELETE FROM work_queue WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?"
  ).run(cutoff);
  return result.changes;
}

/** Recover items stuck in running state (e.g., after bot crash) */
export function recoverStuckWork(): number {
  const running = getRunningWork();
  let recovered = 0;

  for (const item of running) {
    if (!item.task_id) {
      updateWorkItem(item.id, { status: "pending", started_at: null });
      recovered++;
      continue;
    }

    const task = getTask(item.task_id) as TaskRecord | null;
    if (!task || task.status === "completed" || task.status === "dead" || task.status === "failed") {
      // Task is done or gone — reset work item for redispatch
      updateWorkItem(item.id, { status: "pending", task_id: null, started_at: null });
      recovered++;
    }
  }

  if (recovered > 0) {
    console.log(`[WORK-QUEUE] Recovered ${recovered} stuck items`);
  }
  return recovered;
}
