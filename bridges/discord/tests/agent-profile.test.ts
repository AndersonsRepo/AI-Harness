import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatModelPolicyShadowLog,
  loadAgentProfile,
  resolveRuntimePolicyCompatibility,
  resolveModelPolicy,
  resolveModelPolicyShadowComparison,
  type AgentProfile,
} from "../agent-profile.js";

function makeHarnessRoot(fixtures: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "aih-agent-profile-"));
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const [name, text] of Object.entries(fixtures)) {
    writeFileSync(join(agentsDir, `${name}.md`), text);
  }
  return root;
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function requireProfile(profile: AgentProfile | null): AgentProfile {
  assert.ok(profile, "expected profile to load");
  return profile;
}

describe("AgentProfile loader", () => {
  it("loads builder profile while preserving current frontmatter and prompt compatibility", () => {
    const root = makeHarnessRoot({
      builder:
        "---\n" +
        "runtime: codex\n" +
        "sandbox: workspace-write\n" +
        "description: Code implementation agent\n" +
        "---\n" +
        "# Builder Agent\n\n" +
        "Implement focused code changes.\n",
    });
    try {
      const profile = requireProfile(loadAgentProfile("builder", { harnessRoot: root }));

      assert.equal(profile.name, "builder");
      assert.equal(profile.role, "builder");
      assert.equal(profile.description, "Code implementation agent");
      assert.equal(profile.rawSystemPrompt, "# Builder Agent\n\nImplement focused code changes.\n");
      assert.equal(profile.rawMarkdown.includes("runtime: codex"), true);
      assert.deepEqual(profile.metadata.raw, {
        runtime: "codex",
        sandbox: "workspace-write",
        description: "Code implementation agent",
      });
      assert.equal(profile.runtimePreference, "codex");
      assert.deepEqual(profile.runtimeFallbacks, ["codex", "claude"]);
      assert.equal(profile.permissionPolicy.codexSandbox, "workspace-write");
      assert.equal(profile.compatibility.legacyClaudeModelDefault, undefined);
    } finally {
      cleanup(root);
    }
  });

  it("preserves reviewer legacy Opus default while shadow policy describes requirements", () => {
    const root = makeHarnessRoot({
      reviewer:
        "---\n" +
        "runtime: codex\n" +
        "---\n" +
        "# Reviewer Agent\n\n" +
        "Review diffs for defects and regressions.\n",
    });
    try {
      const profile = requireProfile(loadAgentProfile("reviewer", { harnessRoot: root }));
      const recommendation = resolveModelPolicy(profile, {
        taskType: "code_review",
        prompt: "Review this security-sensitive auth diff.",
      });

      assert.equal(profile.compatibility.legacyClaudeModelDefault, "opus");
      assert.equal(profile.modelPolicy.defaultTier, "deep");
      assert.deepEqual(profile.modelPolicy.runtimeHints?.claude, { model: "opus" });
      assert.equal(recommendation.selectedTier, "deep");
      assert.equal(recommendation.changedExecution, false);
      assert.equal(recommendation.runtimeHints.claude?.model, "opus");
      assert.ok(recommendation.reasons.some((reason) => reason.includes("legacy Claude default")));
    } finally {
      cleanup(root);
    }
  });

  it("keeps researcher on CLI model default while recommending balanced/deep policy", () => {
    const root = makeHarnessRoot({
      researcher:
        "---\n" +
        "runtime: codex\n" +
        "---\n" +
        "# Researcher Agent\n\n" +
        "Find and synthesize evidence.\n",
    });
    try {
      const profile = requireProfile(loadAgentProfile("researcher", { harnessRoot: root }));
      const recommendation = resolveModelPolicy(profile, {
        taskType: "research",
        prompt: "Research a novel ambiguous architecture tradeoff.",
      });

      assert.equal(profile.compatibility.legacyClaudeModelDefault, undefined);
      assert.equal(profile.modelPolicy.defaultTier, "balanced");
      assert.equal(recommendation.selectedTier, "deep");
      assert.equal(recommendation.changedExecution, false);
      assert.ok(recommendation.escalationTriggersMatched.includes("novelty_or_ambiguity"));
    } finally {
      cleanup(root);
    }
  });

  it("loads orchestrator with deep policy and legacy model compatibility", () => {
    const root = makeHarnessRoot({
      orchestrator:
        "---\n" +
        "runtime: codex\n" +
        "---\n" +
        "# Orchestrator Agent\n\n" +
        "Coordinate state, sequencing, and handoffs.\n",
    });
    try {
      const profile = requireProfile(loadAgentProfile("orchestrator", { harnessRoot: root }));

      assert.equal(profile.compatibility.legacyClaudeModelDefault, "opus");
      assert.equal(profile.modelPolicy.defaultTier, "deep");
      assert.deepEqual(profile.runtimeFallbacks, ["codex", "claude"]);
      assert.ok(profile.modelPolicy.requiredCapabilities.includes("state_tracking"));
    } finally {
      cleanup(root);
    }
  });

  it("returns a default profile for unknown agents without inventing file metadata", () => {
    const root = makeHarnessRoot({});
    try {
      const profile = loadAgentProfile("unknown-agent", { harnessRoot: root });

      assert.equal(profile, null);

      const fallback = requireProfile(loadAgentProfile("unknown-agent", {
        harnessRoot: root,
        allowDefault: true,
      }));
      assert.equal(fallback.name, "unknown-agent");
      assert.equal(fallback.role, "unknown-agent");
      assert.equal(fallback.rawSystemPrompt, "");
      assert.deepEqual(fallback.metadata.raw, {});
      assert.equal(fallback.runtimePreference, "claude");
      assert.deepEqual(fallback.runtimeFallbacks, ["claude", "codex"]);
      assert.equal(fallback.modelPolicy.defaultTier, "balanced");
      assert.equal(fallback.compatibility.legacyClaudeModelDefault, undefined);
    } finally {
      cleanup(root);
    }
  });
});

describe("AgentProfile runtime policy compatibility", () => {
  it("resolves runtime preference and fallback order from profile metadata", () => {
    const root = makeHarnessRoot({
      builder:
        "---\n" +
        "runtime: codex\n" +
        "sandbox: workspace-write\n" +
        "---\n" +
        "# Builder Agent\n\n" +
        "Implement focused code changes.\n",
      ops:
        "# Ops Agent\n\n" +
        "Operate safely.\n",
    });
    try {
      assert.deepEqual(
        resolveRuntimePolicyCompatibility("builder", { harnessRoot: root }),
        {
          preferredRuntime: "codex",
          fallbackOrder: ["codex", "claude"],
        },
      );
      assert.deepEqual(
        resolveRuntimePolicyCompatibility("ops", { harnessRoot: root }),
        {
          preferredRuntime: "claude",
          fallbackOrder: ["claude", "codex"],
        },
      );
    } finally {
      cleanup(root);
    }
  });

  it("returns Claude-first compatibility for default or unknown agents", () => {
    const root = makeHarnessRoot({});
    try {
      assert.deepEqual(
        resolveRuntimePolicyCompatibility(null, { harnessRoot: root }),
        {
          preferredRuntime: "claude",
          fallbackOrder: ["claude", "codex"],
        },
      );
      assert.deepEqual(
        resolveRuntimePolicyCompatibility("unknown-agent", { harnessRoot: root }),
        {
          preferredRuntime: "claude",
          fallbackOrder: ["claude", "codex"],
        },
      );
    } finally {
      cleanup(root);
    }
  });
});

describe("AgentProfile shadow model policy comparison", () => {
  it("compares reviewer policy recommendations against legacy Claude model defaults", () => {
    const root = makeHarnessRoot({
      reviewer:
        "---\n" +
        "runtime: codex\n" +
        "---\n" +
        "# Reviewer Agent\n\n" +
        "Review diffs for defects and regressions.\n",
    });
    try {
      const comparison = resolveModelPolicyShadowComparison({
        agentName: "reviewer",
        runtime: "codex",
        prompt: "Review this large security diff",
        harnessRoot: root,
      });

      assert.ok(comparison);
      assert.equal(comparison.profileName, "reviewer");
      assert.equal(comparison.runtime, "codex");
      assert.equal(comparison.legacySelectedModel, "opus");
      assert.equal(comparison.legacyModelSource, "agent-default");
      assert.equal(comparison.recommendation.selectedTier, "deep");
      assert.equal(comparison.recommendation.changedExecution, false);
      assert.equal(comparison.recommendation.runtimeHints.claude?.model, "opus");
      assert.match(formatModelPolicyShadowLog(comparison), /\[MODEL_POLICY_SHADOW\]/);
      assert.match(formatModelPolicyShadowLog(comparison), /legacy=opus\(agent-default\)/);
      assert.match(formatModelPolicyShadowLog(comparison), /execution=unchanged/);
    } finally {
      cleanup(root);
    }
  });

  it("keeps channel model override as the legacy selected model", () => {
    const root = makeHarnessRoot({
      researcher:
        "---\n" +
        "runtime: codex\n" +
        "---\n" +
        "# Researcher Agent\n\n" +
        "Find and synthesize evidence.\n",
    });
    try {
      const comparison = resolveModelPolicyShadowComparison({
        agentName: "researcher",
        runtime: "codex",
        prompt: "Research an ambiguous source-sensitive claim",
        channelModel: "claude-sonnet-4-6",
        harnessRoot: root,
      });

      assert.ok(comparison);
      assert.equal(comparison.legacySelectedModel, "claude-sonnet-4-6");
      assert.equal(comparison.legacyModelSource, "channel-override");
      assert.equal(comparison.recommendation.selectedTier, "deep");
      assert.equal(comparison.recommendation.changedExecution, false);
    } finally {
      cleanup(root);
    }
  });

  it("returns a default comparison for unknown/default agents without changing execution", () => {
    const root = makeHarnessRoot({});
    try {
      const comparison = resolveModelPolicyShadowComparison({
        agentName: null,
        runtime: "claude",
        prompt: "Handle a normal request",
        harnessRoot: root,
      });

      assert.ok(comparison);
      assert.equal(comparison.profileName, "default");
      assert.equal(comparison.legacySelectedModel, undefined);
      assert.equal(comparison.legacyModelSource, "cli-default");
      assert.equal(comparison.recommendation.selectedTier, "balanced");
      assert.equal(comparison.recommendation.changedExecution, false);
    } finally {
      cleanup(root);
    }
  });
});
