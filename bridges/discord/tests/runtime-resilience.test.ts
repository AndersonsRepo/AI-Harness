/**
 * Runtime Resilience — Adapter-Level Hooks
 *
 * Covers the four task-runner resilience features now wired through
 * RuntimeAdapter capability flags (TODO-6):
 *   - parseToolCallSignatures() drives loop detection
 *   - isStaleSessionError() drives stale-session retry
 *   - capabilities.continuation drives [CONTINUE] bounded-step
 *   - capabilities.transientErrorRetry drives the API failure tracker
 *
 * The first two are pure adapter functions; we test them directly. The
 * latter two are exercised end-to-end via the existing task-runner spawn
 * harness so we cover the call-site wiring.
 *
 * Run: HARNESS_ROOT=$PWD npx --prefix bridges/discord tsx --test \
 *      bridges/discord/tests/runtime-resilience.test.ts
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "fs";
import type { ChildProcess } from "child_process";

import { getDb } from "../db.js";
import { clearChannelSessions, getSession, setSession } from "../session-store.js";
import {
  submitTask,
  spawnTask,
  getTask,
  onTaskOutput,
  setSpawnProcessForTests,
} from "../task-runner.js";
import { getAdapter } from "../runtime-adapter.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function cleanupChannel(channelId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM task_queue WHERE channel_id = ?").run(channelId);
  db.prepare("DELETE FROM dead_letter WHERE channel_id = ?").run(channelId);
  db.prepare("DELETE FROM channel_configs WHERE channel_id = ?").run(channelId);
  clearChannelSessions(channelId);
}

function waitForTaskOutput(
  taskId: string,
): Promise<{ response: string | null; error: string | null; sessionId: string | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for task ${taskId}`)),
      5000,
    );
    onTaskOutput(async (observedTaskId, response, error, sessionId) => {
      if (observedTaskId !== taskId) return;
      clearTimeout(timer);
      resolve({ response, error, sessionId });
    });
  });
}

// ─── parseToolCallSignatures ─────────────────────────────────────────

describe("RuntimeAdapter.parseToolCallSignatures — Codex", () => {
  const codex = getAdapter("codex");

  it("returns one signature per item.completed tool event", () => {
    const stdout = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "mcp_tool_call", server: "vault", tool: "vault_read", arguments: { path: "a.md" } },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "ls -la" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "done" },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
    ].join("\n");

    const sigs = codex.parseToolCallSignatures({ stdout });
    assert.equal(sigs.length, 2, "agent_message + turn.completed should not produce signatures");
    assert.match(sigs[0]!, /^mcp__vault__vault_read:/);
    assert.match(sigs[1]!, /^Bash:/);
  });

  it("collapses repeated calls into matching signatures", () => {
    const sameCall = JSON.stringify({
      type: "item.completed",
      item: { type: "mcp_tool_call", server: "vault", tool: "vault_read", arguments: { path: "a.md" } },
    });
    const stdout = [sameCall, sameCall, sameCall].join("\n");
    const sigs = codex.parseToolCallSignatures({ stdout });
    assert.equal(sigs.length, 3);
    assert.equal(new Set(sigs).size, 1, "identical events must produce identical signatures");
  });

  it("tolerates malformed JSONL lines", () => {
    const stdout = [
      "not json",
      "",
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "echo hi" },
      }),
    ].join("\n");
    const sigs = codex.parseToolCallSignatures({ stdout });
    assert.equal(sigs.length, 1);
    assert.match(sigs[0]!, /^Bash:/);
  });

  it("returns empty for empty stdout", () => {
    assert.deepEqual(codex.parseToolCallSignatures({ stdout: "" }), []);
    assert.deepEqual(codex.parseToolCallSignatures({} as any), []);
  });
});

describe("RuntimeAdapter.parseToolCallSignatures — Claude", () => {
  const claude = getAdapter("claude");

  it("extracts tool_use blocks nested in assistant messages", () => {
    const stdout = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "thinking..." },
          { type: "tool_use", name: "Read", input: { file_path: "/x.ts" } },
        ],
      },
    });
    const sigs = claude.parseToolCallSignatures({ stdout });
    assert.equal(sigs.length, 1);
    assert.match(sigs[0]!, /^Read:/);
  });

  it("preserves legacy top-level tool_use shape", () => {
    const stdout = JSON.stringify({ type: "tool_use", name: "Grep", input: { pattern: "foo" } });
    const sigs = claude.parseToolCallSignatures({ stdout });
    assert.equal(sigs.length, 1);
    assert.match(sigs[0]!, /^Grep:/);
  });
});

// ─── isStaleSessionError ─────────────────────────────────────────────

describe("RuntimeAdapter.isStaleSessionError — Codex", () => {
  const codex = getAdapter("codex");

  it("matches thread/session/conversation crossed with not-found verbs", () => {
    const cases: string[] = [
      "Error: thread abc-123 not found",
      "conversation does not exist",
      "no such session",
      "session unknown",
      "Invalid thread id",
      "Session has expired",
    ];
    for (const stderr of cases) {
      assert.equal(
        codex.isStaleSessionError({ stdout: "", stderr, returncode: 1 }),
        true,
        `expected stale-session match: "${stderr}"`,
      );
    }
  });

  it("does not match unrelated stderr", () => {
    const cases: string[] = [
      "",
      "Codex exited with code 1",
      "rate limit exceeded",
      "Error: connection refused",
    ];
    for (const stderr of cases) {
      assert.equal(
        codex.isStaleSessionError({ stdout: "", stderr, returncode: 1 }),
        false,
        `expected no match: "${stderr}"`,
      );
    }
  });
});

describe("RuntimeAdapter.isStaleSessionError — Claude", () => {
  const claude = getAdapter("claude");

  it("matches Claude's session-not-found / expired wording", () => {
    assert.equal(
      claude.isStaleSessionError({ stdout: "", stderr: "session abc not found", returncode: 1 }),
      true,
    );
    assert.equal(
      claude.isStaleSessionError({ stdout: "", stderr: "session expired", returncode: 1 }),
      true,
    );
  });

  it("does not match unrelated stderr", () => {
    assert.equal(
      claude.isStaleSessionError({ stdout: "", stderr: "rate limit", returncode: 1 }),
      false,
    );
  });
});

// ─── capability flags ────────────────────────────────────────────────

describe("RuntimeAdapter capabilities", () => {
  it("Codex now reports continuation + loopDetection capable", () => {
    const caps = getAdapter("codex").capabilities;
    assert.equal(caps.continuation, true);
    assert.equal(caps.loopDetection, true);
    assert.equal(caps.transientErrorRetry, true);
    assert.equal(caps.sessionResume, true);
  });

  it("Claude reports all four capabilities", () => {
    const caps = getAdapter("claude").capabilities;
    assert.equal(caps.continuation, true);
    assert.equal(caps.loopDetection, true);
    assert.equal(caps.transientErrorRetry, true);
    assert.equal(caps.sessionResume, true);
  });
});

// ─── End-to-end: stale-session retry under Codex ─────────────────────

describe("Task Runner — Codex stale-session retry", () => {
  const channelId = "resilience-codex-stale";

  beforeEach(() => {
    cleanupChannel(channelId);
  });

  afterEach(() => {
    setSpawnProcessForTests(null);
    cleanupChannel(channelId);
  });

  it("clears the stored Codex thread id and retries cold on stale-session stderr", async () => {
    setSession(channelId, "stale-codex-thread", "codex");

    let spawnCount = 0;
    const sessionIdsSeen: (string | undefined)[] = [];

    setSpawnProcessForTests(((command: string, args: readonly string[]) => {
      spawnCount++;
      const callArgs = [...args].map(String);
      const outputFile = callArgs[1];
      const sidIdx = callArgs.indexOf("--session-id");
      sessionIdsSeen.push(sidIdx >= 0 ? callArgs[sidIdx + 1] : undefined);

      const isFirstAttempt = spawnCount === 1;
      const payload = isFirstAttempt
        ? {
            stdout: "",
            stderr: "Error: thread stale-codex-thread not found",
            returncode: 1,
            threadId: null,
            lastMessage: null,
          }
        : {
            stdout: '{"type":"thread","thread_id":"fresh-thread-456"}\n',
            stderr: "",
            returncode: 0,
            threadId: "fresh-thread-456",
            lastMessage: "Recovered cold",
          };

      setTimeout(() => writeFileSync(outputFile, JSON.stringify(payload)), 25);
      return { pid: 5000 + spawnCount, unref() {} } as ChildProcess;
    }) as typeof import("child_process").spawn);

    const taskId = submitTask({
      channelId,
      prompt: "do work",
      agent: "builder",
      runtime: "codex",
      sessionKey: channelId,
    });

    const outputPromise = waitForTaskOutput(taskId);
    await spawnTask(taskId);
    const out = await outputPromise;

    assert.equal(spawnCount, 2, "expected one retry after stale-session detection");
    assert.equal(sessionIdsSeen[0], "stale-codex-thread");
    assert.equal(sessionIdsSeen[1], undefined, "second spawn should omit --session-id (cold start)");
    assert.equal(out.response, "Recovered cold");
    assert.equal(getSession(channelId, "codex"), "fresh-thread-456");
    assert.equal(getTask(taskId)?.attempt, 1);
  });
});

// ─── End-to-end: [CONTINUE] under Codex ──────────────────────────────

describe("Task Runner — Codex [CONTINUE] bounded-step", () => {
  const channelId = "resilience-codex-continue";

  beforeEach(() => {
    cleanupChannel(channelId);
  });

  afterEach(() => {
    setSpawnProcessForTests(null);
    cleanupChannel(channelId);
  });

  it("spawns step 2 when Codex output ends with [CONTINUE]", async () => {
    let spawnCount = 0;

    setSpawnProcessForTests(((command: string, args: readonly string[]) => {
      spawnCount++;
      const callArgs = [...args].map(String);
      const outputFile = callArgs[1];

      const payload = spawnCount === 1
        ? {
            stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"step 1 done [CONTINUE]"}}\n',
            stderr: "",
            returncode: 0,
            threadId: "thread-cont-1",
            lastMessage: "step 1 done [CONTINUE]",
          }
        : {
            stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"all done"}}\n',
            stderr: "",
            returncode: 0,
            threadId: "thread-cont-1",
            lastMessage: "all done",
          };

      setTimeout(() => writeFileSync(outputFile, JSON.stringify(payload)), 25);
      return { pid: 6000 + spawnCount, unref() {} } as ChildProcess;
    }) as typeof import("child_process").spawn);

    const taskId = submitTask({
      channelId,
      prompt: "multi-step task",
      agent: "builder",
      runtime: "codex",
      sessionKey: channelId,
      maxSteps: 3,
    });

    // Need to capture the *final* output (after step 2 completes), so install
    // the handler manually rather than via waitForTaskOutput which resolves
    // on the first call.
    const finalOutput = await new Promise<{ response: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      onTaskOutput(async (observedTaskId, response) => {
        if (observedTaskId !== taskId) return;
        // Step 1 emits an intermediate output; only the final response lacks
        // the [CONTINUE] marker.
        if (response && !response.includes("[CONTINUE]")) {
          clearTimeout(timer);
          resolve({ response });
        }
      });
      spawnTask(taskId).catch(reject);
    });

    assert.equal(spawnCount, 2, "expected step 2 to be spawned after [CONTINUE]");
    assert.equal(finalOutput.response, "all done");
    assert.equal(getTask(taskId)?.status, "completed");
    assert.equal(getTask(taskId)?.step_count, 2);
  });
});

// ─── End-to-end: loop detection under Codex ──────────────────────────

describe("Task Runner — Codex loop detection", () => {
  const channelId = "resilience-codex-loop";

  beforeEach(() => {
    cleanupChannel(channelId);
  });

  afterEach(() => {
    setSpawnProcessForTests(null);
    cleanupChannel(channelId);
  });

  it("kills task when same Bash command repeats past threshold", async () => {
    // Generate 5× identical command_execution events — over the threshold of 4.
    const sameCall = JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "ls /tmp" },
    });
    const stdout = Array.from({ length: 5 }, () => sameCall).join("\n");

    setSpawnProcessForTests(((command: string, args: readonly string[]) => {
      const callArgs = [...args].map(String);
      const outputFile = callArgs[1];
      const payload = {
        stdout,
        stderr: "",
        returncode: 0,
        threadId: "loop-thread",
        lastMessage: "looped",
      };
      setTimeout(() => writeFileSync(outputFile, JSON.stringify(payload)), 25);
      return { pid: 7001, unref() {} } as ChildProcess;
    }) as typeof import("child_process").spawn);

    const taskId = submitTask({
      channelId,
      prompt: "infinite ls",
      agent: "builder",
      runtime: "codex",
      sessionKey: channelId,
    });

    const outputPromise = waitForTaskOutput(taskId);
    await spawnTask(taskId);
    const out = await outputPromise;

    assert.ok(out.response?.includes("Task stopped"), "expected loop-detected stop notice");
    assert.ok(out.response?.includes("Loop detected"), "loop warning text should be present");
    assert.equal(getTask(taskId)?.status, "completed");
  });
});
