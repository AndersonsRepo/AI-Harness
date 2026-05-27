// Unit test for the mid-session stuck-task reaper's decision function.
//
// Covers the gotcha promoted to CLAUDE.md (ERR-20260425-063): a runner that
// dies without writing its output envelope leaves its task_queue row stuck
// status='running' with a dead PID, holding a concurrency slot forever.
// reapStuckTasks() reclaims it; isStuckOrphan() is the pure predicate it uses.
//
// We test isStuckOrphan directly (no DB, no spawning) so the four guard
// conditions — liveness, grace window, output-file race, in-flight handler —
// are each locked independently. PID 999999 is above the macOS/Linux default
// pid_max and is therefore reliably dead; process.pid is reliably alive.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isStuckOrphan, REAPER_GRACE_MS, type TaskRecord } from "../task-runner.js";

const DEAD_PID = 999999; // above default pid_max → guaranteed not alive
const ALIVE_PID = process.pid; // this test process

function makeTask(over: Partial<TaskRecord>): TaskRecord {
  // Default: a row that SHOULD be reaped (dead pid, old, no output file).
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
  return {
    id: "reaper-test-task",
    channel_id: "test",
    channel_name: null,
    prompt: "x",
    agent: null,
    runtime: null,
    session_key: null,
    status: "running",
    step_count: 1,
    max_steps: 10,
    attempt: 0,
    max_attempts: 3,
    last_error: null,
    output_file: null,
    pid: DEAD_PID,
    created_at: old,
    updated_at: old,
    next_retry_at: null,
    ...over,
  };
}

describe("isStuckOrphan", () => {
  const now = Date.now();

  it("reaps a dead-PID row with no output, past the grace window", () => {
    assert.equal(isStuckOrphan(makeTask({}), now), true);
  });

  it("leaves a row whose process is still alive", () => {
    assert.equal(isStuckOrphan(makeTask({ pid: ALIVE_PID }), now), false);
  });

  it("leaves a freshly-updated row (inside the grace window)", () => {
    const fresh = new Date(now - (REAPER_GRACE_MS - 5_000)).toISOString();
    assert.equal(isStuckOrphan(makeTask({ updated_at: fresh }), now), false);
  });

  it("leaves a row whose output envelope is already on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "reaper-test-"));
    const outputFile = join(dir, "response.json");
    writeFileSync(outputFile, "{}");
    try {
      // Dead pid + old, but the envelope exists → FileWatcher will deliver it.
      assert.equal(isStuckOrphan(makeTask({ output_file: outputFile }), now), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a row with a null pid (never spawned / already cleared)", () => {
    assert.equal(isStuckOrphan(makeTask({ pid: null }), now), false);
  });

  it("leaves a waiting_continue row whose process is alive", () => {
    assert.equal(
      isStuckOrphan(makeTask({ status: "waiting_continue", pid: ALIVE_PID }), now),
      false,
    );
  });
});
