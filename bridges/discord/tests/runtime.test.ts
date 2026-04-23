import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "fs";
import { join } from "path";
import type { ChildProcess } from "child_process";
import { getDb } from "../db.js";
import { setChannelConfig } from "../channel-config-store.js";
import {
  submitTask,
  spawnTask,
  getTask,
  onTaskOutput,
  setSpawnProcessForTests,
  resolveTaskRuntime,
} from "../task-runner.js";
import { clearChannelSessions, getSession, setSession } from "../session-store.js";
import { extractCodexResponse, extractCodexSessionId } from "../codex-config.js";

interface SpawnCall {
  command: string;
  args: string[];
}

function cleanupChannel(channelId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM task_queue WHERE channel_id = ?").run(channelId);
  db.prepare("DELETE FROM dead_letter WHERE channel_id = ?").run(channelId);
  db.prepare("DELETE FROM channel_configs WHERE channel_id = ?").run(channelId);
  clearChannelSessions(channelId);
}

function waitForTaskOutput(taskId: string): Promise<{ response: string | null; error: string | null; sessionId: string | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for task ${taskId}`)), 5000);
    onTaskOutput(async (observedTaskId, response, error, sessionId) => {
      if (observedTaskId !== taskId) return;
      clearTimeout(timer);
      resolve({ response, error, sessionId });
    });
  });
}

describe("Task Runner — Mixed Runtime Dispatch", () => {
  const channels = ["runtime-codex-task", "runtime-claude-task", "runtime-override-task", "runtime-session-split"];
  const spawnCalls: SpawnCall[] = [];

  beforeEach(() => {
    spawnCalls.length = 0;
    setSpawnProcessForTests(((command: string, args: readonly string[]) => {
      const callArgs = [...args].map(String);
      spawnCalls.push({ command, args: callArgs });

      const runnerPath = callArgs[0];
      const outputFile = callArgs[1];
      const isCodex = runnerPath.endsWith("codex-runner.py");
      const payload = isCodex
        ? {
            stdout: '{"type":"thread","thread_id":"codex-thread-123"}\n{"type":"message","content":"Codex built it"}\n',
            stderr: "",
            returncode: 0,
            threadId: "codex-thread-123",
            lastMessage: "Codex built it",
          }
        : {
            stdout: '{"type":"assistant","message":{"content":[{"type":"text","text":"Claude completed it"}]}}\n{"type":"result","result":"Claude completed it","session_id":"claude-session-123"}\n',
            stderr: "",
            returncode: 0,
            session_id: "claude-session-123",
          };

      setTimeout(() => {
        writeFileSync(outputFile, JSON.stringify(payload));
      }, 25);

      return {
        pid: isCodex ? 4001 : 4002,
        unref() {},
      } as ChildProcess;
    }) as typeof import("child_process").spawn);
  });

  afterEach(() => {
    setSpawnProcessForTests(null);
    for (const channelId of channels) {
      cleanupChannel(channelId);
    }
  });

  it("routes an explicitly codex task through codex-runner and stores a codex session", async () => {
    const channelId = "runtime-codex-task";
    setSession(channelId, "stale-codex-session", "codex");
    const taskId = submitTask({
      channelId,
      prompt: "Implement the change",
      agent: "builder",
      runtime: "codex",
      sessionKey: channelId,
    });

    const outputPromise = waitForTaskOutput(taskId);
    const spawnResult = await spawnTask(taskId);
    const output = await outputPromise;

    assert.ok(spawnResult);
    assert.equal(spawnResult?.runtime, "codex");
    assert.equal(spawnCalls[0]?.args[0].endsWith("codex-runner.py"), true);
    assert.ok(spawnCalls[0]?.args.includes("--prompt-file"));
    assert.equal(spawnCalls[0]?.args.includes("--session-id"), false);
    assert.equal(output.response, "Codex built it");
    assert.equal(output.sessionId, "codex-thread-123");
    assert.equal(getSession(channelId, "codex"), "codex-thread-123");
    assert.equal(getTask(taskId)?.runtime, "codex");
  });

  it("routes builder tasks to Codex by role policy when there is no override", async () => {
    const channelId = "runtime-claude-task";
    const taskId = submitTask({
      channelId,
      prompt: "Implement this change",
      agent: "builder",
      sessionKey: channelId,
    });

    const outputPromise = waitForTaskOutput(taskId);
    const spawnResult = await spawnTask(taskId);
    const output = await outputPromise;

    assert.ok(spawnResult);
    assert.equal(spawnResult?.runtime, "codex");
    assert.equal(spawnCalls[0]?.args[0].endsWith("codex-runner.py"), true);
    assert.equal(output.response, "Codex built it");
    assert.equal(output.sessionId, "codex-thread-123");
    assert.equal(getSession(channelId, "codex"), "codex-thread-123");
    assert.equal(getTask(taskId)?.runtime, "codex");
  });

  it("keeps reviewer tasks on Claude by role policy when there is no override", async () => {
    const channelId = "runtime-reviewer-task";
    const taskId = submitTask({
      channelId,
      prompt: "Review this change",
      agent: "reviewer",
      sessionKey: channelId,
    });

    const outputPromise = waitForTaskOutput(taskId);
    const spawnResult = await spawnTask(taskId);
    const output = await outputPromise;

    assert.ok(spawnResult);
    assert.equal(spawnResult?.runtime, "claude");
    assert.equal(spawnCalls[0]?.args[0].endsWith("claude-runner.py"), true);
    assert.equal(output.response, "Claude completed it");
    assert.equal(output.sessionId, "claude-session-123");
    assert.equal(getSession(channelId, "claude"), "claude-session-123");
    assert.equal(getTask(taskId)?.runtime, "claude");
  });

  it("channel runtime override takes precedence over agent metadata", () => {
    const channelId = "runtime-override-task";
    setChannelConfig(channelId, { runtime: "codex" });

    const taskId = submitTask({
      channelId,
      prompt: "Use Codex even for builder",
      agent: "builder",
      sessionKey: channelId,
    });

    const task = getTask(taskId);
    assert.ok(task);
    assert.equal(resolveTaskRuntime(task!), "codex");
  });
});

describe("Codex Result Parsing", () => {
  it("extracts Codex response and session id from runner output", () => {
    const payload = {
      stdout: '{"type":"thread","thread_id":"thread-abc"}\n{"type":"message","content":"Final Codex response"}\n',
      stderr: "",
      returncode: 0,
      threadId: "thread-abc",
      lastMessage: "Final Codex response",
    };

    assert.equal(extractCodexResponse(payload), "Final Codex response");
    assert.equal(extractCodexSessionId(payload), "thread-abc");
  });

  it("falls back to nested content arrays when lastMessage is missing", () => {
    const payload = {
      stdout: '{"type":"thread","thread_id":"thread-nested"}\n{"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"Nested Codex response"}]}]}}\n',
      stderr: "",
      returncode: 0,
      threadId: "thread-nested",
      lastMessage: null,
    };

    assert.equal(extractCodexResponse(payload), "Nested Codex response");
    assert.equal(extractCodexSessionId(payload), "thread-nested");
  });

  it("stores Claude and Codex sessions separately for the same logical key", () => {
    const channelId = "runtime-session-split";
    setSession(channelId, "claude-session", "claude");
    setSession(channelId, "codex-thread", "codex");

    assert.equal(getSession(channelId, "claude"), "claude-session");
    assert.equal(getSession(channelId, "codex"), "codex-thread");
  });
});
