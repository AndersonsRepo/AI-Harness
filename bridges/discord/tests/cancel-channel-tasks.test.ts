// Regression test for cancelChannelTasks SQL parameter binding.
//
// History: task-runner.ts had `db.prepare("SELECT ... WHERE channel_id = ? ...").all()`
// — the `?` placeholder was never bound. Calling /stop in Discord triggered
// a `RangeError: Too few parameter values were provided` which propagated
// uncaught and crashed the bot. launchd then restarted the bot, the
// crash-recovery path retried the stale running task, and the user saw a
// retry-attempt's transient failure (e.g. "Claude exited with code 1")
// instead of the expected stop confirmation.
//
// This test exercises the function with real DB rows so any future
// missing-parameter regression fails loudly here instead of in production.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../db.js";
import { cancelChannelTasks } from "../task-runner.js";

const TEST_CHANNEL = "test-cancel-channel-tasks";

function clear() {
  const db = getDb();
  db.prepare("DELETE FROM task_queue WHERE channel_id = ?").run(TEST_CHANNEL);
}

function insertTask(id: string, status: "pending" | "running" | "waiting_continue" | "completed") {
  const db = getDb();
  db.prepare(`
    INSERT INTO task_queue (id, channel_id, prompt, status, max_steps, max_attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, 10, 3, datetime('now'), datetime('now'))
  `).run(id, TEST_CHANNEL, "test prompt", status);
}

describe("cancelChannelTasks", () => {
  beforeEach(() => clear());
  afterEach(() => clear());

  it("does not throw when no tasks exist for the channel", () => {
    // The pre-fix bug crashed here: SQL bound zero parameters.
    assert.doesNotThrow(() => cancelChannelTasks(TEST_CHANNEL));
    assert.equal(cancelChannelTasks(TEST_CHANNEL), 0);
  });

  it("returns 0 when only completed tasks exist (no cancellable ones)", () => {
    insertTask("test-completed-1", "completed");
    assert.equal(cancelChannelTasks(TEST_CHANNEL), 0);
  });

  it("marks running tasks as failed and returns count", () => {
    insertTask("test-running-1", "running");
    insertTask("test-running-2", "running");
    insertTask("test-pending-1", "pending");
    insertTask("test-completed-1", "completed");

    const cancelled = cancelChannelTasks(TEST_CHANNEL);
    assert.equal(cancelled, 3, "should cancel 2 running + 1 pending = 3 tasks");

    // Verify the affected rows have status='failed' and last_error set.
    const db = getDb();
    const rows = db.prepare(
      "SELECT id, status, last_error FROM task_queue WHERE channel_id = ? ORDER BY id"
    ).all(TEST_CHANNEL) as Array<{ id: string; status: string; last_error: string | null }>;

    const completed = rows.find((r) => r.id === "test-completed-1");
    assert.equal(completed?.status, "completed", "completed task should be untouched");

    const running1 = rows.find((r) => r.id === "test-running-1");
    assert.equal(running1?.status, "failed");
    assert.match(running1?.last_error ?? "", /Cancelled/i);
  });

  it("only touches the specified channel's tasks", () => {
    const otherChannel = "test-cancel-other-channel";
    const db = getDb();
    db.prepare("DELETE FROM task_queue WHERE channel_id = ?").run(otherChannel);
    db.prepare(`
      INSERT INTO task_queue (id, channel_id, prompt, status, max_steps, max_attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, 10, 3, datetime('now'), datetime('now'))
    `).run("other-running-1", otherChannel, "test prompt", "running");

    insertTask("test-running-1", "running");

    const cancelled = cancelChannelTasks(TEST_CHANNEL);
    assert.equal(cancelled, 1, "should only cancel the one task in TEST_CHANNEL");

    // Other channel's task untouched.
    const other = db.prepare(
      "SELECT status FROM task_queue WHERE id = ?"
    ).get("other-running-1") as { status: string } | undefined;
    assert.equal(other?.status, "running", "other channel's task should be untouched");

    // Cleanup the other-channel row.
    db.prepare("DELETE FROM task_queue WHERE channel_id = ?").run(otherChannel);
  });
});
