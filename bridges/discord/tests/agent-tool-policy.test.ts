/**
 * Agent Tool Policy — Codex enforcement parity with Claude --allowedTools.
 *
 * Covers:
 *   - safety.ts:buildAgentToolPolicy — translates AGENT_TOOL_RESTRICTIONS
 *     entries into a policy enforceable by codex-runner.py at the JSONL
 *     layer (Bash regex + MCP exact-name match).
 *   - codex-config.ts — wires the policy JSON into the CODEX_TOOL_POLICY
 *     env var per spawn.
 *
 * Run: HARNESS_ROOT=$PWD npx --prefix bridges/discord tsx --test \
 *      bridges/discord/tests/agent-tool-policy.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentToolPolicy, agentToolPolicyJson } from "../safety.js";
import { AGENT_TOOL_RESTRICTIONS } from "../agent-loader.js";
import { buildCodexConfig } from "../codex-config.js";

// ─── buildAgentToolPolicy — translation ──────────────────────────────

describe("buildAgentToolPolicy — null cases", () => {
  it("returns null when restrictions undefined", () => {
    assert.equal(buildAgentToolPolicy(undefined), null);
  });

  it("returns null when both allowed and disallowed are absent", () => {
    assert.equal(buildAgentToolPolicy({}), null);
  });

  it("returns null when disallowed contains only sandbox-governed tools", () => {
    // Edit/Write/NotebookEdit are filesystem-governed via the Codex
    // read-only sandbox; they have no JSONL representation, so no policy
    // is needed at the runner level.
    const policy = buildAgentToolPolicy({
      disallowed: ["Edit", "Write", "NotebookEdit"],
    });
    assert.equal(policy, null);
  });
});

describe("buildAgentToolPolicy — blacklist mode (orchestrator-style)", () => {
  it("translates Bash() patterns to regex with word boundaries", () => {
    const policy = buildAgentToolPolicy({
      disallowed: ["Edit", "Write", "Bash(npm:*)", "Bash(npx:*)"],
    });
    assert.ok(policy);
    assert.equal(policy!.mode, "blacklist");
    assert.equal(policy!.bashPatterns.length, 2);
    const ids = policy!.bashPatterns.map((p) => p.id);
    assert.ok(ids.includes("bash-npm"));
    assert.ok(ids.includes("bash-npx"));
    // Regex should use \b boundaries.
    for (const p of policy!.bashPatterns) {
      assert.ok(p.regex.startsWith("\\b"), `${p.regex} should start with \\b`);
      assert.ok(p.regex.endsWith("\\b"), `${p.regex} should end with \\b`);
    }
  });

  it("captures MCP tool names verbatim", () => {
    const policy = buildAgentToolPolicy({
      disallowed: ["mcp__codex__codex", "mcp__codex__codex-reply"],
    });
    assert.ok(policy);
    assert.equal(policy!.mode, "blacklist");
    assert.deepEqual(
      policy!.mcpPatterns.slice().sort(),
      ["mcp__codex__codex", "mcp__codex__codex-reply"],
    );
  });

  it("orchestrator's full restriction set translates correctly", () => {
    const policy = buildAgentToolPolicy(AGENT_TOOL_RESTRICTIONS.orchestrator);
    assert.ok(policy);
    assert.equal(policy!.mode, "blacklist");
    // Bash(npm:*), Bash(npx:*) → 2 patterns; Edit/Write/NotebookEdit dropped.
    assert.equal(policy!.bashPatterns.length, 2);
    assert.equal(policy!.mcpPatterns.length, 2);
  });
});

describe("buildAgentToolPolicy — whitelist mode (researcher-style)", () => {
  it("captures only Bash + MCP from a mixed allowed list", () => {
    const policy = buildAgentToolPolicy({
      allowed: [
        "Read",
        "Grep",
        "Glob",
        "WebSearch",
        "Bash(cat:*)",
        "Bash(ls:*)",
        "mcp__vault__vault_read",
      ],
    });
    assert.ok(policy);
    assert.equal(policy!.mode, "whitelist");
    assert.equal(policy!.bashPatterns.length, 2);
    assert.equal(policy!.mcpPatterns.length, 1);
    assert.ok(policy!.mcpPatterns.includes("mcp__vault__vault_read"));
  });

  it("researcher's full whitelist translates to expected counts", () => {
    const policy = buildAgentToolPolicy(AGENT_TOOL_RESTRICTIONS.researcher);
    assert.ok(policy);
    assert.equal(policy!.mode, "whitelist");
    // researcher.allowed has 6 Bash() entries (cat, ls, find, wc, head, tail)
    // and several mcp__* entries.
    assert.equal(policy!.bashPatterns.length, 6);
    assert.ok(policy!.mcpPatterns.length >= 4);
  });
});

describe("buildAgentToolPolicy — SQL keyword case-insensitive flag", () => {
  it("flags caseInsensitive for uppercase prefixes (DROP / DELETE FROM)", () => {
    const policy = buildAgentToolPolicy({
      disallowed: ["Bash(DROP:*)", "Bash(DELETE FROM:*)", "Bash(npm:*)"],
    });
    assert.ok(policy);
    const byId = new Map(policy!.bashPatterns.map((p) => [p.id, p]));
    assert.equal(byId.get("bash-drop")?.caseInsensitive, true);
    assert.equal(byId.get("bash-delete-from")?.caseInsensitive, true);
    assert.equal(byId.get("bash-npm")?.caseInsensitive, undefined);
  });
});

describe("buildAgentToolPolicy — regex behavior", () => {
  it("the produced regex matches typical command shapes", () => {
    const policy = buildAgentToolPolicy({
      disallowed: ["Bash(npm:*)", "Bash(git push --force:*)"],
    });
    assert.ok(policy);
    const npmPattern = new RegExp(
      policy!.bashPatterns.find((p) => p.id === "bash-npm")!.regex,
    );
    assert.ok(npmPattern.test("npm install"));
    assert.ok(npmPattern.test("cd /tmp && npm install"));
    // False match acceptable: \b boundary is liberal but defense-in-depth.

    const gitPattern = new RegExp(
      policy!.bashPatterns.find((p) => p.id === "bash-git-push---force")!.regex,
    );
    assert.ok(gitPattern.test("git push --force origin main"));
    assert.ok(!gitPattern.test("git push origin main"));
  });
});

// ─── agentToolPolicyJson — env var serialization ─────────────────────

describe("agentToolPolicyJson", () => {
  it("returns null for null policy", () => {
    assert.equal(agentToolPolicyJson(undefined), null);
    assert.equal(agentToolPolicyJson({}), null);
  });

  it("emits valid JSON for a real agent profile", () => {
    const json = agentToolPolicyJson(AGENT_TOOL_RESTRICTIONS.orchestrator);
    assert.ok(json);
    const parsed = JSON.parse(json!);
    assert.equal(parsed.mode, "blacklist");
    assert.ok(Array.isArray(parsed.bashPatterns));
    assert.ok(Array.isArray(parsed.mcpPatterns));
  });

  it("Set serializes as array (not {})", () => {
    // JSON.stringify on a Set produces "{}" — make sure the helper
    // converts it to an array first so codex-runner can decode it.
    const json = agentToolPolicyJson({ disallowed: ["mcp__codex__codex"] });
    assert.ok(json);
    const parsed = JSON.parse(json!);
    assert.ok(Array.isArray(parsed.mcpPatterns));
    assert.deepEqual(parsed.mcpPatterns, ["mcp__codex__codex"]);
  });
});

// ─── codex-config.ts — env wiring ────────────────────────────────────

describe("buildCodexConfig — CODEX_TOOL_POLICY env var", () => {
  const channelId = "tool-policy-channel";

  it("sets CODEX_TOOL_POLICY for an agent with restrictions (orchestrator)", async () => {
    const config = await buildCodexConfig({
      channelId,
      prompt: "test",
      agentName: "orchestrator",
      sessionKey: channelId,
      taskId: "test-orchestrator-policy",
      skipSessionResume: true,
    });
    assert.ok(config.env.CODEX_TOOL_POLICY, "CODEX_TOOL_POLICY should be set");
    const parsed = JSON.parse(config.env.CODEX_TOOL_POLICY);
    assert.equal(parsed.mode, "blacklist");
  });

  it("sets CODEX_TOOL_POLICY in whitelist mode for researcher", async () => {
    const config = await buildCodexConfig({
      channelId,
      prompt: "test",
      agentName: "researcher",
      sessionKey: channelId,
      taskId: "test-researcher-policy",
      skipSessionResume: true,
    });
    assert.ok(config.env.CODEX_TOOL_POLICY);
    const parsed = JSON.parse(config.env.CODEX_TOOL_POLICY);
    assert.equal(parsed.mode, "whitelist");
  });

  it("omits CODEX_TOOL_POLICY for unrestricted agents (builder)", async () => {
    const config = await buildCodexConfig({
      channelId,
      prompt: "test",
      agentName: "builder",
      sessionKey: channelId,
      taskId: "test-builder-policy",
      skipSessionResume: true,
    });
    // builder has no AGENT_TOOL_RESTRICTIONS entry → no policy → env unset
    assert.equal(config.env.CODEX_TOOL_POLICY, undefined);
  });

  it("omits CODEX_TOOL_POLICY when no agent name is provided", async () => {
    const config = await buildCodexConfig({
      channelId,
      prompt: "test",
      agentName: null,
      sessionKey: channelId,
      taskId: "test-no-agent-policy",
      skipSessionResume: true,
    });
    assert.equal(config.env.CODEX_TOOL_POLICY, undefined);
  });
});
