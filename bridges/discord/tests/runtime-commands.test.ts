import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeCommand, type CommandContext } from "../core-commands.js";
import { setChannelConfig } from "../channel-config-store.js";
import { getDb } from "../db.js";
import { clearChannelSessions } from "../session-store.js";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    channelId: "runtime-command-chan",
    userId: "test-user-1",
    rawText: "/runtime codex",
    ...overrides,
  };
}

function cleanupChannel(channelId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM channel_configs WHERE channel_id = ?").run(channelId);
  clearChannelSessions(channelId);
}

afterEach(() => {
  cleanupChannel("runtime-command-chan");
  cleanupChannel("runtime-command-chan-clear");
  cleanupChannel("runtime-command-chan-config");
});

describe("Core Commands — Runtime Routing", () => {
  it("/runtime sets runtime override", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/runtime codex" }));
    assert.ok(result);
    assert.ok(result.text.includes("runtime override set"));
  });

  it("/runtime clear removes runtime override", async () => {
    setChannelConfig("runtime-command-chan-clear", { runtime: "codex" });
    const result = await executeCommand(makeCtx({
      channelId: "runtime-command-chan-clear",
      rawText: "/runtime clear",
    }));
    assert.ok(result);
    assert.ok(result.text.includes("runtime override cleared"));
  });

  it("/config shows runtime override", async () => {
    setChannelConfig("runtime-command-chan-config", { runtime: "codex", agent: "builder" });
    const result = await executeCommand(makeCtx({
      channelId: "runtime-command-chan-config",
      rawText: "/config",
    }));
    assert.ok(result);
    assert.ok(result.text.includes("Runtime override"));
    assert.ok(result.text.includes("codex"));
  });

  it("/config shows effective role policy and fallback order without an override", async () => {
    setChannelConfig("runtime-command-chan", { agent: "builder" });
    const result = await executeCommand(makeCtx({
      channelId: "runtime-command-chan",
      rawText: "/config",
    }));
    assert.ok(result);
    assert.ok(result.text.includes("Runtime policy"));
    assert.ok(result.text.includes("codex"));
    assert.ok(result.text.includes("codex -> claude"));
  });
});
