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
  it("defaults builder/researcher/education/reviewer/tester/orchestrator to Codex; ops stays on Claude", () => {
    assert.equal(getPreferredRuntimeForAgent("builder"), "codex");
    assert.deepEqual(getFallbackOrderForAgent("builder"), ["codex", "claude"]);
    assert.equal(getPreferredRuntimeForAgent("researcher"), "codex");
    assert.deepEqual(getFallbackOrderForAgent("researcher"), ["codex", "claude"]);
    assert.equal(getPreferredRuntimeForAgent("education"), "codex");
    assert.deepEqual(getFallbackOrderForAgent("education"), ["codex", "claude"]);
    assert.equal(getPreferredRuntimeForAgent("reviewer"), "codex");
    assert.deepEqual(getFallbackOrderForAgent("reviewer"), ["codex", "claude"]);
    assert.equal(getPreferredRuntimeForAgent("tester"), "codex");
    assert.deepEqual(getFallbackOrderForAgent("tester"), ["codex", "claude"]);
    assert.equal(getPreferredRuntimeForAgent("orchestrator"), "codex");
    assert.deepEqual(getFallbackOrderForAgent("orchestrator"), ["codex", "claude"]);
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
});
