import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "fs";
import type { ChildProcess } from "child_process";
import { getDb } from "../db.js";
import { setChannelConfig } from "../channel-config-store.js";
import { getSession, clearChannelSessions } from "../session-store.js";
import { getGroupStatus, setParallelSpawnProcessForTests, spawnParallelGroup, type ParallelDirective } from "../tmux-orchestrator.js";

interface SpawnCall {
  command: string;
  args: string[];
}

function cleanupChannel(channelId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM channel_configs WHERE channel_id = ?").run(channelId);
  db.prepare("DELETE FROM parallel_tasks WHERE channel_id = ?").run(channelId);
  clearChannelSessions(channelId);
}

async function waitForGroupCompletion(groupId: string, timeoutMs: number = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = getGroupStatus(groupId);
    if (status?.allComplete) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for group ${groupId}`);
}

describe("tmux Orchestrator — Mixed Runtime Dispatch", () => {
  const channelId = "parallel-runtime-channel";
  const spawnCalls: SpawnCall[] = [];

  beforeEach(() => {
    spawnCalls.length = 0;
    setParallelSpawnProcessForTests(((command: string, args: readonly string[]) => {
      const callArgs = [...args].map(String);
      spawnCalls.push({ command, args: callArgs });

      const outputFile = callArgs[1];
      const isCodex = callArgs[0]?.endsWith("codex-runner.py");
      const payload = isCodex
        ? {
            stdout: '{"type":"thread","thread_id":"parallel-codex-thread"}\n{"type":"message","content":"Parallel Codex result"}\n',
            stderr: "",
            returncode: 0,
            threadId: "parallel-codex-thread",
            lastMessage: "Parallel Codex result",
          }
        : {
            stdout: '{"type":"assistant","message":{"content":[{"type":"text","text":"Parallel Claude result"}]}}\n{"type":"result","result":"Parallel Claude result","session_id":"parallel-claude-session"}\n',
            stderr: "",
            returncode: 0,
            session_id: "parallel-claude-session",
          };

      setTimeout(() => {
        writeFileSync(outputFile, JSON.stringify(payload));
      }, 25);

      return {
        pid: isCodex ? 4501 : 4502,
        unref() {},
      } as ChildProcess;
    }) as typeof import("child_process").spawn);
  });

  afterEach(() => {
    setParallelSpawnProcessForTests(null);
    cleanupChannel(channelId);
  });

  it("routes parallel builder work through Codex role policy and persists runtime/session metadata", async () => {
    const directive: ParallelDirective = {
      agents: ["builder"],
      tasks: new Map([["builder", "Implement the change in parallel"]]),
    };

    const groupId = await spawnParallelGroup({
      channelId,
      directive,
    });

    const status = await waitForGroupCompletion(groupId);
    assert.ok(status);
    const db = getDb();
    const telemetry = db.prepare("SELECT status, agent FROM task_telemetry WHERE task_id = ?").get(status!.tasks[0]!.task_id) as { status: string; agent: string } | undefined;
    assert.equal(spawnCalls[0]?.args[0].endsWith("codex-runner.py"), true);
    assert.ok(spawnCalls[0]?.args.includes("--prompt-file"));
    assert.equal(status?.tasks[0]?.runtime, "codex");
    assert.equal(status?.tasks[0]?.status, "completed");
    assert.equal(getSession(`${channelId}:builder`, "codex"), "parallel-codex-thread");
    assert.equal(telemetry?.status, "completed");
    assert.equal(telemetry?.agent, "builder");
  });

  it("honors channel runtime override for reviewer parallel work", async () => {
    setChannelConfig(channelId, { runtime: "codex" });
    const directive: ParallelDirective = {
      agents: ["reviewer"],
      tasks: new Map([["reviewer", "Review the parallel change"]]),
    };

    const groupId = await spawnParallelGroup({
      channelId,
      directive,
    });

    const status = await waitForGroupCompletion(groupId);
    assert.ok(status);
    assert.equal(spawnCalls[0]?.args[0].endsWith("codex-runner.py"), true);
    assert.equal(status?.tasks[0]?.runtime, "codex");
  });
});

// TODO-7: tmux-orchestrator's StreamPoller is dead-wired for Codex (codex-runner
// accepts --stream-dir but writes nothing). Telemetry is now replayed post-hoc
// via adapter.recordResult() in handleParallelOutput. This test proves Codex
// parallel spawns get non-zero tool-call telemetry — previously total_tools
// was 0 because the StreamPoller fired no events.
describe("tmux Orchestrator — Codex post-hoc telemetry replay", () => {
  const channelId = "parallel-codex-telemetry";

  beforeEach(() => {
    cleanupChannel(channelId);
    setParallelSpawnProcessForTests(((command: string, args: readonly string[]) => {
      const callArgs = [...args].map(String);
      const outputFile = callArgs[1];
      // Emit two item.completed tool events so total_tools should land at 2.
      const stdout = [
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", command: "ls /tmp" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "mcp_tool_call",
            server: "vault",
            tool: "vault_read",
            arguments: { path: "x.md" },
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Codex parallel done" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 1000, output_tokens: 200, cached_input_tokens: 500 },
        }),
      ].join("\n");

      const payload = {
        stdout,
        stderr: "",
        returncode: 0,
        threadId: "telemetry-thread",
        lastMessage: "Codex parallel done",
      };
      setTimeout(() => writeFileSync(outputFile, JSON.stringify(payload)), 25);
      return { pid: 5500, unref() {} } as ChildProcess;
    }) as typeof import("child_process").spawn);
  });

  afterEach(() => {
    setParallelSpawnProcessForTests(null);
    cleanupChannel(channelId);
  });

  it("populates task_telemetry.total_tools from item.completed events post-hoc", async () => {
    const directive: ParallelDirective = {
      agents: ["builder"],
      tasks: new Map([["builder", "Codex parallel work"]]),
    };

    const groupId = await spawnParallelGroup({ channelId, directive });
    const status = await waitForGroupCompletion(groupId);
    assert.ok(status);
    const taskId = status!.tasks[0]!.task_id;
    assert.equal(status!.tasks[0]!.runtime, "codex");

    const db = getDb();
    const row = db.prepare(
      "SELECT total_tools, est_input_tokens, est_output_tokens FROM task_telemetry WHERE task_id = ?",
    ).get(taskId) as
      | { total_tools: number; est_input_tokens: number; est_output_tokens: number }
      | undefined;

    assert.ok(row, "task_telemetry row should exist");
    assert.equal(row!.total_tools, 2, "two item.completed tool events should be replayed");
    assert.equal(row!.est_input_tokens, 1000, "turn.completed.usage should set token counts");
    assert.equal(row!.est_output_tokens, 200);
  });
});
