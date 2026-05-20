import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "fs";
import type { ChildProcess } from "child_process";
import { getDb } from "../db.js";
import { setChannelConfig } from "../channel-config-store.js";
import { get } from "../process-registry.js";
import { setSubagentSpawnProcessForTests, spawnSubagent } from "../subagent-manager.js";

interface SpawnCall {
  command: string;
  args: string[];
}

function cleanupChannel(channelId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM channel_configs WHERE channel_id = ?").run(channelId);
  db.prepare("DELETE FROM subagents WHERE parent_channel_id = ?").run(channelId);
}

async function waitForSubagentStatus(id: string, status: string, timeoutMs: number = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const stored = get(id);
    if (stored?.status === status) return stored;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for subagent ${id} to reach ${status}`);
}

describe("Subagent Manager — Mixed Runtime Dispatch", () => {
  const channelId = "subagent-runtime-codex";
  const spawnCalls: SpawnCall[] = [];

  beforeEach(() => {
    spawnCalls.length = 0;
    setSubagentSpawnProcessForTests(((command: string, args: readonly string[]) => {
      const callArgs = [...args].map(String);
      spawnCalls.push({ command, args: callArgs });

      const outputFile = callArgs[1];
      setTimeout(() => {
        writeFileSync(outputFile, JSON.stringify({
          stdout: '{"type":"thread","thread_id":"subagent-thread-123"}\n{"type":"message","content":"Codex subagent complete"}\n',
          stderr: "",
          returncode: 0,
          threadId: "subagent-thread-123",
          lastMessage: "Codex subagent complete",
        }));
      }, 25);

      return {
        pid: 4401,
        unref() {},
      } as ChildProcess;
    }) as typeof import("child_process").spawn);
  });

  afterEach(() => {
    setSubagentSpawnProcessForTests(null);
    cleanupChannel(channelId);
  });

  it("routes subagents through the explicit channel runtime and persists runtime metadata", async () => {
    setChannelConfig(channelId, { runtime: "codex", agent: "reviewer" });

    const entry = await spawnSubagent({
      channelId,
      description: "Verify the builder output",
    });

    assert.ok(entry);
    assert.equal(spawnCalls[0]?.args[0].endsWith("codex-runner.py"), true);
    assert.ok(spawnCalls[0]?.args.includes("--prompt-file"));
    assert.equal(entry?.runtime, "codex");

    await new Promise((resolve) => setTimeout(resolve, 75));
    const stored = entry ? get(entry.id) : null;
    assert.equal(stored?.runtime, "codex");
  });

  it("reroutes Claude usage-limit failures to the next subagent runtime", async () => {
    spawnCalls.length = 0;
    setChannelConfig(channelId, { runtime: "claude", agent: "ops" });
    setSubagentSpawnProcessForTests(((command: string, args: readonly string[]) => {
      const callArgs = [...args].map(String);
      spawnCalls.push({ command, args: callArgs });

      const outputFile = callArgs[1];
      const isCodex = callArgs[0]?.endsWith("codex-runner.py");
      const payload = isCodex
        ? {
            stdout: '{"type":"thread","thread_id":"subagent-fallback-thread"}\n{"type":"message","content":"Codex subagent fallback complete"}\n',
            stderr: "",
            returncode: 0,
            threadId: "subagent-fallback-thread",
            lastMessage: "Codex subagent fallback complete",
          }
        : {
            stdout: JSON.stringify({
              type: "result",
              is_error: true,
              api_error_status: 403,
              result: "API Error: monthly usage limit reached",
            }),
            stderr: "",
            returncode: 1,
          };

      setTimeout(() => {
        writeFileSync(outputFile, JSON.stringify(payload));
      }, 25);

      return {
        pid: isCodex ? 4403 : 4402,
        unref() {},
      } as ChildProcess;
    }) as typeof import("child_process").spawn);

    const entry = await spawnSubagent({
      channelId,
      description: "Verify fallback handling",
    });

    assert.ok(entry);
    const stored = await waitForSubagentStatus(entry!.id, "completed");
    assert.equal(spawnCalls.length, 2);
    assert.equal(spawnCalls[0]?.args[0].endsWith("claude-runner.py"), true);
    assert.equal(spawnCalls[1]?.args[0].endsWith("codex-runner.py"), true);
    assert.equal(stored?.runtime, "codex");
  });
});
