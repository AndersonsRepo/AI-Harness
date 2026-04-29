import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../db.js";
import { setChannelConfig } from "../channel-config-store.js";
import { getFallbackOrderForAgent, getPreferredRuntimeForAgent, resolveRuntimePolicy } from "../role-policy.js";

function cleanupChannel(channelId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM channel_configs WHERE channel_id = ?").run(channelId);
}

describe("Role Policy — Runtime Selection", () => {
  it("defaults builder/researcher/education to Codex; reviewer to Claude", () => {
    assert.equal(getPreferredRuntimeForAgent("builder"), "codex");
    assert.deepEqual(getFallbackOrderForAgent("builder"), ["codex", "claude"]);
    assert.equal(getPreferredRuntimeForAgent("researcher"), "codex");
    assert.deepEqual(getFallbackOrderForAgent("researcher"), ["codex", "claude"]);
    assert.equal(getPreferredRuntimeForAgent("education"), "codex");
    assert.deepEqual(getFallbackOrderForAgent("education"), ["codex", "claude"]);
    assert.equal(getPreferredRuntimeForAgent("reviewer"), "claude");
    assert.deepEqual(getFallbackOrderForAgent("reviewer"), ["claude", "codex"]);
  });

  it("uses channel override ahead of role policy while preserving fallback order", () => {
    const channelId = "role-policy-override";
    setChannelConfig(channelId, { runtime: "codex", agent: "reviewer" });

    const policy = resolveRuntimePolicy({
      channelId,
      agentName: "reviewer",
    });

    assert.equal(policy.selectedRuntime, "codex");
    assert.equal(policy.source, "channel");
    assert.deepEqual(policy.fallbackOrder, ["codex", "claude"]);
    cleanupChannel(channelId);
  });
});
