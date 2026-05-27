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
  it("preserves preferred runtime and fallback order for current agent profiles", () => {
    const cases = [
      ["builder", "codex", ["codex", "claude"]],
      ["researcher", "codex", ["codex", "claude"]],
      ["education", "codex", ["codex", "claude"]],
      ["reviewer", "codex", ["codex", "claude"]],
      ["tester", "codex", ["codex", "claude"]],
      ["orchestrator", "codex", ["codex", "claude"]],
      ["codex-builder", "codex", ["codex", "claude"]],
      ["unknown-agent", "claude", ["claude", "codex"]],
      [null, "claude", ["claude", "codex"]],
    ] as const;

    for (const [agentName, expectedRuntime, expectedFallbackOrder] of cases) {
      assert.equal(getPreferredRuntimeForAgent(agentName), expectedRuntime, String(agentName));
      assert.deepEqual(getFallbackOrderForAgent(agentName), expectedFallbackOrder, String(agentName));
    }

    // ops has no role-policy override and no `runtime: codex` in its agent
    // frontmatter, so it falls through to the Claude default. Acts as a
    // sentinel — if this flips, the policy or agent file changed.
    assert.equal(getPreferredRuntimeForAgent("ops"), "claude");
    assert.deepEqual(getFallbackOrderForAgent("ops"), ["claude", "codex"]);
  });

  it("uses channel override ahead of role policy while preserving fallback order", () => {
    const channelId = "role-policy-override";
    setChannelConfig(channelId, { runtime: "claude", agent: "reviewer" });

    const policy = resolveRuntimePolicy({
      channelId,
      agentName: "reviewer",
    });

    assert.equal(policy.selectedRuntime, "claude");
    assert.equal(policy.source, "channel");
    assert.deepEqual(policy.fallbackOrder, ["claude", "codex"]);
    cleanupChannel(channelId);
  });

  it("uses explicit task runtime ahead of channel and role policy while preserving role fallback", () => {
    const channelId = "role-policy-explicit-override";
    setChannelConfig(channelId, { runtime: "claude", agent: "reviewer" });

    const policy = resolveRuntimePolicy({
      channelId,
      agentName: "reviewer",
      explicitRuntime: "codex",
    });

    assert.equal(policy.selectedRuntime, "codex");
    assert.equal(policy.preferredRuntime, "codex");
    assert.equal(policy.source, "task");
    assert.deepEqual(policy.fallbackOrder, ["codex", "claude"]);
    cleanupChannel(channelId);
  });

  it("keeps channel override ahead of role policy for Claude-default agents", () => {
    const channelId = "role-policy-channel-override-ops";
    setChannelConfig(channelId, { runtime: "codex", agent: "ops" });

    const policy = resolveRuntimePolicy({
      channelId,
      agentName: "ops",
    });

    assert.equal(policy.selectedRuntime, "codex");
    assert.equal(policy.preferredRuntime, "codex");
    assert.equal(policy.source, "channel");
    assert.deepEqual(policy.fallbackOrder, ["codex", "claude"]);
    cleanupChannel(channelId);
  });
});
