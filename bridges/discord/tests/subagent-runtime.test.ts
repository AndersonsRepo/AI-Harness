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
});
