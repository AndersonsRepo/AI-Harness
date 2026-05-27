import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentContext,
  buildAgentContextWithMemory,
  formatAgentContextShadowLog,
  summarizeClaudeRendererParity,
  summarizeClaudeSkillRendererParity,
  summarizeCodexRendererParity,
  summarizeCodexSkillRendererParity,
  summarizeAgentContextConfigParity,
} from "../agent-context.js";
import { buildLearningsSection, extractKeywords } from "../context-assembler.js";
import { monitor } from "../truncation-monitor.js";
import {
  buildSkillCatalogShadow,
  formatHarnessSkillsCatalog,
  summarizeSkillCatalogShadow,
} from "../skill-catalog.js";
import { buildClaudeConfig } from "../claude-config.js";
import {
  buildCodexConfig,
  buildCodexHarnessEnvArgs,
  buildCodexMcpApprovalArgs,
} from "../codex-config.js";
import { clearChannelConfig, setChannelConfig } from "../channel-config-store.js";
import { getAdapter } from "../runtime-adapter.js";
import { clearSession, setSession } from "../session-store.js";
import { adoptChannel, deleteProject } from "../project-manager.js";

function makeHarnessRoot(fixtures: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "aih-agent-context-"));
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const [name, text] of Object.entries(fixtures)) {
    writeFileSync(join(agentsDir, `${name}.md`), text);
  }
  return root;
}

function writeSkill(root: string, dirname: string, content: string): void {
  const skillDir = join(root, ".claude", "skills", dirname);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content);
}

function cleanupRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function cleanupChannel(channelId: string): void {
  clearChannelConfig(channelId);
  deleteProject(channelId);
  clearSession(channelId, "claude");
  clearSession(channelId, "codex");
  clearSession(`${channelId}:builder`, "claude");
  clearSession(`${channelId}:builder`, "codex");
  clearSession(`${channelId}:reviewer`, "claude");
  clearSession(`${channelId}:reviewer`, "codex");
}

describe("AgentContext shadow builder", () => {
  const channelsToCleanup = new Set<string>();

  afterEach(() => {
    for (const channelId of channelsToCleanup) cleanupChannel(channelId);
    channelsToCleanup.clear();
  });

  it("builds a shadow turn context from an explicit agent without changing execution", () => {
    const root = makeHarnessRoot({
      builder:
        "---\n" +
        "runtime: codex\n" +
        "sandbox: workspace-write\n" +
        "---\n" +
        "# Builder Agent\n\n" +
        "Implement focused code changes.\n",
    });
    try {
      const context = buildAgentContext({
        channelId: "agent-context-explicit",
        agentName: "builder",
        prompt: "Implement the next slice",
        sessionKey: "agent-context-explicit:builder",
        runtime: "codex",
        workflow: { kind: "handoff", taskId: "chain-123" },
        harnessRoot: root,
      });

      assert.equal(context.changedExecution, false);
      assert.equal(context.profile.name, "builder");
      assert.equal(context.channelId, "agent-context-explicit");
      assert.equal(context.sessionKey, "agent-context-explicit:builder");
      assert.equal(context.userPrompt, "Implement the next slice");
      assert.equal(context.runtime, "codex");
      assert.deepEqual(context.workflow, { kind: "handoff", taskId: "chain-123" });
      assert.equal(context.project, null);
      assert.deepEqual(context.recentConversation, []);
      assert.deepEqual(context.vaultMemory, []);
    } finally {
      cleanupRoot(root);
    }
  });

  it("falls back to channel agent and includes project/channel state when present", () => {
    const channelId = "agent-context-project";
    channelsToCleanup.add(channelId);
    const root = makeHarnessRoot({
      reviewer:
        "---\n" +
        "runtime: codex\n" +
        "---\n" +
        "# Reviewer Agent\n\n" +
        "Review diffs.\n",
    });
    try {
      adoptChannel(
        channelId,
        "proj-context",
        "category-1",
        "guild-1",
        "Project context test",
        ["reviewer", "builder"],
      );
      setChannelConfig(channelId, { agent: "reviewer", runtime: "codex", model: "opus" });

      const context = buildAgentContext({
        channelId,
        agentName: null,
        prompt: "Review the change",
        sessionKey: `${channelId}:reviewer`,
        runtime: "codex",
        harnessRoot: root,
      });

      assert.equal(context.profile.name, "reviewer");
      assert.equal(context.channelConfig.agent, "reviewer");
      assert.equal(context.channelConfig.runtime, "codex");
      assert.equal(context.channelConfig.model, "opus");
      assert.ok(context.project);
      assert.equal(context.project.name, "context");
      assert.equal(context.project.description, "Project context test");
      assert.deepEqual(context.project.agents, ["reviewer", "builder"]);
      assert.equal(context.project.workdir, null);
      assert.equal(context.workflow.kind, "runtime-invocation");
    } finally {
      cleanupRoot(root);
    }
  });

  it("formats a compact shadow log without prompt contents", () => {
    const root = makeHarnessRoot({
      ops:
        "# Ops Agent\n\n" +
        "Operate safely.\n",
    });
    try {
      const context = buildAgentContext({
        channelId: "agent-context-log",
        agentName: "ops",
        prompt: "this prompt must not appear in logs",
        sessionKey: "agent-context-log:ops",
        runtime: "claude",
        extraSystemPrompts: ["operator note"],
        harnessRoot: root,
      });

      const log = formatAgentContextShadowLog(context);

      assert.match(log, /^\[AGENT_CONTEXT_SHADOW\]/);
      assert.match(log, /agent=ops/);
      assert.match(log, /runtime=claude/);
      assert.match(log, /profile=ops/);
      assert.match(log, /project=none/);
      assert.match(log, /operatorGuidance=1/);
      assert.match(log, /execution=unchanged/);
      assert.equal(log.includes("this prompt must not appear"), false);
    } finally {
      cleanupRoot(root);
    }
  });

  it("summarizes the same effective agent/session/runtime facts used by config builders", () => {
    const channelId = "agent-context-parity-explicit";
    channelsToCleanup.add(channelId);
    const root = makeHarnessRoot({
      builder:
        "---\n" +
        "runtime: codex\n" +
        "sandbox: workspace-write\n" +
        "---\n" +
        "# Builder Agent\n\n" +
        "Implement focused code changes.\n",
      reviewer:
        "---\n" +
        "runtime: codex\n" +
        "---\n" +
        "# Reviewer Agent\n\n" +
        "Review diffs.\n",
    });
    try {
      setChannelConfig(channelId, {
        agent: "reviewer",
        runtime: "claude",
        model: "opus",
      });

      const context = buildAgentContext({
        channelId,
        agentName: "builder",
        prompt: "Implement the next slice",
        sessionKey: `${channelId}:builder`,
        runtime: "codex",
        workflow: {
          kind: "handoff",
          taskId: "chain-parity",
          worktreePath: "/tmp/chain-worktree",
          skipSessionResume: true,
        },
        extraSystemPrompts: ["operator note", "second note"],
        harnessRoot: root,
      });

      assert.deepEqual(summarizeAgentContextConfigParity(context), {
        effectiveAgentName: "builder",
        channelAgent: "reviewer",
        sessionKey: `${channelId}:builder`,
        selectedRuntime: "codex",
        channelRuntimeOverride: "claude",
        channelModelOverride: "opus",
        projectName: null,
        projectWorkdir: null,
        workflowKind: "handoff",
        taskId: "chain-parity",
        worktreePath: "/tmp/chain-worktree",
        skipSessionResume: true,
        isContinuation: undefined,
        operatorGuidanceCount: 2,
        recentConversationCount: 0,
        vaultMemoryCount: 0,
        skillSourceCount: 0,
        relevantSkillCount: 0,
        relevantSkillNames: [],
        vaultSkillIndexPath: null,
        changedExecution: false,
      });
    } finally {
      cleanupRoot(root);
    }
  });

  it("summarizes channel-agent fallback and project workdir resolution", () => {
    const channelId = "agent-context-parity-project";
    cleanupChannel(channelId);
    channelsToCleanup.add(channelId);
    const root = makeHarnessRoot({
      reviewer:
        "---\n" +
        "runtime: codex\n" +
        "---\n" +
        "# Reviewer Agent\n\n" +
        "Review diffs.\n",
    });
    try {
      adoptChannel(
        channelId,
        "proj-website-agency",
        "category-1",
        "guild-1",
        "Website agency project channel",
        ["reviewer", "builder"],
      );
      setChannelConfig(channelId, { agent: "reviewer", model: "sonnet" });

      const context = buildAgentContext({
        channelId,
        agentName: null,
        prompt: "Review the current plan",
        sessionKey: `${channelId}:reviewer`,
        runtime: "codex",
        workflow: { kind: "parallel" },
        harnessRoot: root,
      });
      const summary = summarizeAgentContextConfigParity(context);

      assert.equal(summary.effectiveAgentName, "reviewer");
      assert.equal(summary.channelAgent, "reviewer");
      assert.equal(summary.sessionKey, `${channelId}:reviewer`);
      assert.equal(summary.selectedRuntime, "codex");
      assert.equal(summary.channelModelOverride, "sonnet");
      assert.equal(summary.projectName, "website-agency");
      assert.equal(summary.projectWorkdir, join(process.env.HOME || "", "Desktop", "website-agency"));
      assert.equal(summary.workflowKind, "parallel");
    } finally {
      cleanupRoot(root);
    }
  });

  it("preserves workflow kind distinctions for handoff, parallel, and subagent shadow contexts", () => {
    const root = makeHarnessRoot({
      ops:
        "# Ops Agent\n\n" +
        "Operate safely.\n",
    });
    try {
      const cases = ["handoff", "parallel", "subagent"] as const;

      for (const kind of cases) {
        const context = buildAgentContext({
          channelId: `agent-context-${kind}`,
          agentName: "ops",
          prompt: "Check workflow shape",
          sessionKey: `agent-context-${kind}:ops`,
          runtime: "claude",
          workflow: { kind },
          harnessRoot: root,
        });

        assert.equal(summarizeAgentContextConfigParity(context).workflowKind, kind);
      }
    } finally {
      cleanupRoot(root);
    }
  });

  it("summarizes Claude renderer parity without replacing the legacy config builder", async () => {
    const channelId = "agent-context-renderer-claude";
    const sessionKey = `${channelId}:reviewer`;
    const worktreePath = "/tmp/agent-context-renderer-claude";
    channelsToCleanup.add(channelId);
    setChannelConfig(channelId, {
      permissionMode: "plan",
      model: "opus",
    });
    setSession(sessionKey, "claude-session-renderer", "claude");

    const context = buildAgentContext({
      channelId,
      agentName: "reviewer",
      prompt: "Review renderer parity for Claude",
      sessionKey,
      runtime: "claude",
      workflow: {
        kind: "handoff",
        taskId: "renderer-claude",
        worktreePath,
      },
      extraSystemPrompts: ["operator note"],
    });
    const config = await buildClaudeConfig({
      channelId,
      agentName: "reviewer",
      prompt: context.userPrompt,
      sessionKey,
      taskId: "renderer-claude",
      worktreePath,
      extraSystemPrompts: context.operatorGuidance,
    });

    const summary = summarizeClaudeRendererParity(context, config);

    assert.equal(summary.changedExecution, false);
    assert.equal(summary.effectiveAgentName, "reviewer");
    assert.equal(summary.sessionKey, sessionKey);
    assert.equal(summary.appendedAgentPrompt, true);
    assert.equal(summary.appendedHarnessContext, true);
    assert.equal(summary.extraSystemPromptCount, 1);
    assert.equal(summary.permissionMode, "plan");
    assert.equal(summary.model, "opus");
    assert.equal(summary.hasMcpConfig, true);
    assert.equal(summary.strictMcpConfig, true);
    assert.equal(summary.resumeSessionId, "claude-session-renderer");
    assert.equal(summary.promptArgument, "Review renderer parity for Claude");
    assert.equal(summary.envHarnessSessionKey, sessionKey);
    assert.equal(summary.envHarnessFromAgent, "reviewer");
    assert.equal(summary.envProjectCwd, worktreePath);
  });

  it("summarizes Codex renderer parity while keeping Codex-specific prompt shape explicit", async () => {
    const channelId = "agent-context-renderer-codex";
    const sessionKey = `${channelId}:builder`;
    const worktreePath = "/tmp/agent-context-renderer-codex";
    channelsToCleanup.add(channelId);
    setChannelConfig(channelId, { runtime: "codex", allowedMcps: ["harness"] });
    setSession(sessionKey, "codex-thread-renderer", "codex");

    const context = buildAgentContext({
      channelId,
      agentName: "builder",
      prompt: "Implement renderer parity for Codex",
      sessionKey,
      runtime: "codex",
      workflow: {
        kind: "parallel",
        taskId: "renderer-codex",
        worktreePath,
      },
      extraSystemPrompts: ["operator note", "second note"],
    });
    const config = await buildCodexConfig({
      channelId,
      agentName: "builder",
      prompt: context.userPrompt,
      sessionKey,
      taskId: "renderer-codex",
      worktreePath,
      extraSystemPrompts: context.operatorGuidance,
    });
    const registryRoot = mkdtempSync(join(tmpdir(), "aih-codex-registry-"));
    const registryPath = join(registryRoot, "config.toml");
    writeFileSync(registryPath, "[mcp_servers.harness]\ncommand = \"harness\"\n");
    try {
      const baseSummary = summarizeCodexRendererParity(context, config);
      const summary = summarizeCodexRendererParity(context, {
        ...config,
        runnerArgs: [
          ...config.runnerArgs,
          ...buildCodexMcpApprovalArgs(channelId, registryPath),
          ...buildCodexHarnessEnvArgs({
            channelId,
            sessionKey,
            fromAgent: "builder",
            registryPath,
          }),
        ],
      });

      assert.equal(summary.changedExecution, false);
      assert.equal(summary.effectiveAgentName, "builder");
      assert.equal(summary.sessionKey, sessionKey);
      assert.equal(summary.hasAgentPersonalitySection, true);
      assert.equal(summary.hasHarnessContextSection, true);
      assert.equal(summary.hasOperatorGuidanceSection, true);
      assert.equal(summary.operatorGuidanceCount, 2);
      assert.equal(summary.hasUserRequestSection, true);
      assert.equal(summary.promptContainsUserRequest, true);
      assert.equal(summary.sandbox, "workspace-write");
      assert.equal(summary.workingDirectory, worktreePath);
      assert.equal(summary.cwd, worktreePath);
      assert.equal(summary.hasSkipGitRepoCheck, true);
      assert.equal(summary.approvalPolicyNever, true);
      assert.equal(summary.mcpApprovalOverrideCount, baseSummary.mcpApprovalOverrideCount + 1);
      assert.equal(summary.harnessEnvOverrideCount, baseSummary.harnessEnvOverrideCount + 3);
      assert.equal(summary.sessionId, "codex-thread-renderer");
      assert.equal(summary.envHarnessSessionKey, sessionKey);
      assert.equal(summary.envHarnessFromAgent, "builder");
      assert.equal(summary.envProjectCwd, worktreePath);
    } finally {
      rmSync(registryRoot, { recursive: true, force: true });
    }
  });

  it("keeps Codex prompt-file behavior in the runtime adapter boundary", async () => {
    const channelId = "agent-context-renderer-codex-file";
    const sessionKey = `${channelId}:builder`;
    const tempRoot = mkdtempSync(join(tmpdir(), "aih-codex-renderer-"));
    const promptFilePath = join(tempRoot, "prompt.txt");
    const outputFile = join(tempRoot, "out.json");
    channelsToCleanup.add(channelId);
    try {
      const spawnArgs = await getAdapter("codex").buildSpawnArgs({
        channelId,
        prompt: "Write the prompt file parity slice",
        agentName: "builder",
        sessionKey,
        taskId: "renderer-codex-file",
        outputFile,
        skipSessionResume: true,
        promptFilePath,
      });

      assert.equal(spawnArgs.promptFilePath, promptFilePath);
      assert.equal(spawnArgs.pythonArgs.includes("--prompt-file"), true);
      assert.equal(spawnArgs.pythonArgs.includes(promptFilePath), true);
      assert.equal(existsSync(promptFilePath), true);
      const promptFile = readFileSync(promptFilePath, "utf-8");
      assert.match(promptFile, /# User Request/);
      assert.match(promptFile, /Write the prompt file parity slice/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("summarizes Claude skill renderer parity as native discovery without prompt duplication", async () => {
    const root = makeHarnessRoot({
      reviewer:
        "---\n" +
        "runtime: claude\n" +
        "---\n" +
        "# Reviewer Agent\n\n" +
        "Review diffs.\n",
    });
    try {
      writeSkill(root, "review-changes",
        "---\n" +
        "name: review-changes\n" +
        "description: Review committed changes against requirements.\n" +
        "user-invocable: true\n" +
        "---\n" +
        "# Review Changes\n\nFull body should stay in SKILL.md.\n",
      );

      const context = buildAgentContext({
        channelId: "agent-context-claude-skill-parity",
        agentName: "reviewer",
        prompt: "Use review-changes on this branch.",
        sessionKey: "agent-context-claude-skill-parity:reviewer",
        runtime: "claude",
        harnessRoot: root,
      });
      const config = await buildClaudeConfig({
        channelId: context.channelId,
        agentName: context.profile.name,
        prompt: context.userPrompt,
        sessionKey: context.sessionKey,
      });

      const summary = summarizeClaudeSkillRendererParity(context, config);

      assert.equal(summary.runtime, "claude");
      assert.equal(summary.changedExecution, false);
      assert.equal(summary.strategy, "preserve-native-skill-discovery");
      assert.equal(summary.skillSourceCount, 1);
      assert.equal(summary.relevantSkillCount, 1);
      assert.deepEqual(summary.relevantSkillNames, ["review-changes"]);
      assert.equal(summary.nativeProjectSkillDiscovery, true);
      assert.equal(summary.promptDuplicatesSkillMetadata, false);
      assert.equal(summary.promptContainsSkillDescription, false);
      assert.equal(summary.promptContainsCanonicalPath, false);
      assert.equal(summary.bodyIncluded, false);
    } finally {
      cleanupRoot(root);
    }
  });

  it("summarizes Codex skill renderer parity as concise entries with canonical paths", async () => {
    const root = makeHarnessRoot({
      builder:
        "---\n" +
        "runtime: codex\n" +
        "---\n" +
        "# Builder Agent\n\n" +
        "Build focused changes.\n",
    });
    try {
      writeSkill(root, "handoff",
        "---\n" +
        "name: handoff\n" +
        "description: Prepare fresh-chat handoffs.\n" +
        "user-invocable: true\n" +
        "---\n" +
        "# Handoff\n\nFull body should stay in SKILL.md.\n",
      );

      const context = buildAgentContext({
        channelId: "agent-context-codex-skill-parity",
        agentName: "builder",
        prompt: "Use handoff for the next chat.",
        sessionKey: "agent-context-codex-skill-parity:builder",
        runtime: "codex",
        harnessRoot: root,
      });
      const config = await buildCodexConfig({
        channelId: context.channelId,
        agentName: context.profile.name,
        prompt: context.userPrompt,
        sessionKey: context.sessionKey,
      });

      const summary = summarizeCodexSkillRendererParity(context, config);

      assert.equal(summary.runtime, "codex");
      assert.equal(summary.changedExecution, false);
      assert.equal(summary.strategy, "render-concise-relevant-skill-context");
      assert.equal(summary.needsExplicitSkillContext, true);
      assert.equal(summary.existingPromptHasSkillContext, false);
      assert.equal(summary.plannedSectionTitle, "# Relevant Skills");
      assert.deepEqual(summary.plannedSkillEntries, [{
        name: "handoff",
        description: "Prepare fresh-chat handoffs.",
        canonicalPath: join(root, ".claude", "skills", "handoff", "SKILL.md"),
        userInvocable: true,
        bodyIncluded: false,
      }]);
      assert.equal(summary.existingPromptContainsSkillDescription, false);
      assert.equal(summary.existingPromptContainsCanonicalPath, false);
    } finally {
      cleanupRoot(root);
    }
  });

  it("builds a deterministic project skill catalog matching harness_skills shape", () => {
    const root = makeHarnessRoot({});
    try {
      writeSkill(root, "review-changes",
        "---\n" +
        "name: review-changes\n" +
        "description: Review committed changes against requirements.\n" +
        "user-invocable: true\n" +
        "argument-hint: \"<base>..<head>\"\n" +
        "agent: reviewer\n" +
        "model: opus\n" +
        "---\n" +
        "# Review Changes\n",
      );
      writeSkill(root, "self-improve",
        "---\n" +
        "name: self-improve\n" +
        "description: Capture learnings and corrections.\n" +
        "user-invocable: false\n" +
        "---\n" +
        "# Self Improve\n",
      );

      const catalog = buildSkillCatalogShadow({ harnessRoot: root });
      const summary = summarizeSkillCatalogShadow(catalog);
      const text = formatHarnessSkillsCatalog(catalog);

      assert.equal(catalog.changedExecution, false);
      assert.deepEqual(catalog.skills.map((s) => s.name), ["review-changes", "self-improve"]);
      assert.equal(summary.projectSkillCount, 2);
      assert.equal(summary.userInvocableCount, 1);
      assert.equal(summary.autoTriggeredCount, 1);
      assert.equal(summary.vaultIndexPath, null);
      assert.equal(summary.changedExecution, false);
      assert.match(text, /# Available Skills/);
      assert.match(text, /## User-Invocable/);
      assert.match(text, /- \*\*\/review-changes\*\* `<base>\.\.<head>` — Review committed changes against requirements\. \(agent: reviewer, model: opus\)/);
      assert.match(text, /## Auto-Triggered/);
      assert.match(text, /- \*\*self-improve\*\* — Capture learnings and corrections\./);
    } finally {
      cleanupRoot(root);
    }
  });

  it("reports vault skill index metadata without copying skill bodies", () => {
    const root = makeHarnessRoot({});
    try {
      writeSkill(root, "handoff",
        "---\n" +
        "name: handoff\n" +
        "description: Prepare fresh-chat handoffs.\n" +
        "user-invocable: true\n" +
        "---\n" +
        "# Handoff\n\nFull body should not appear in catalog summaries.\n",
      );
      const vaultTopics = join(root, "vault", "topics");
      mkdirSync(vaultTopics, { recursive: true });
      writeFileSync(join(vaultTopics, "skills.md"),
        "---\n" +
        "type: learning\n" +
        "category: skill_index\n" +
        "---\n" +
        "# Skill Index\n\n" +
        "- handoff: canonical path `.claude/skills/handoff/SKILL.md`\n",
      );

      const catalog = buildSkillCatalogShadow({ harnessRoot: root });
      const summary = summarizeSkillCatalogShadow(catalog);
      const text = formatHarnessSkillsCatalog(catalog);

      assert.equal(summary.vaultIndexPath, join(root, "vault", "topics", "skills.md"));
      assert.equal(catalog.vaultIndex?.canonicalPath, join(root, "vault", "topics", "skills.md"));
      assert.equal(text.includes("Full body should not appear"), false);
    } finally {
      cleanupRoot(root);
    }
  });

  it("carries project skill catalog facts in AgentContext shadow metadata", () => {
    const root = makeHarnessRoot({
      reviewer:
        "---\n" +
        "runtime: codex\n" +
        "---\n" +
        "# Reviewer Agent\n\n" +
        "Review diffs.\n",
    });
    try {
      writeSkill(root, "review-changes",
        "---\n" +
        "name: review-changes\n" +
        "description: Review committed changes against requirements.\n" +
        "user-invocable: true\n" +
        "argument-hint: \"<base>..<head>\"\n" +
        "agent: reviewer\n" +
        "---\n" +
        "# Review Changes\n\nFull skill body stays canonical here.\n",
      );
      writeSkill(root, "self-improve",
        "---\n" +
        "name: self-improve\n" +
        "description: Capture learnings and corrections.\n" +
        "user-invocable: false\n" +
        "---\n" +
        "# Self Improve\n",
      );
      const vaultTopics = join(root, "vault", "topics");
      mkdirSync(vaultTopics, { recursive: true });
      writeFileSync(join(vaultTopics, "skills.md"), "# Skill Index\n");

      const context = buildAgentContext({
        channelId: "agent-context-skills",
        agentName: "reviewer",
        prompt: "Use review-changes on the latest commit.",
        sessionKey: "agent-context-skills:reviewer",
        runtime: "codex",
        harnessRoot: root,
      });
      const summary = summarizeAgentContextConfigParity(context);
      const log = formatAgentContextShadowLog(context);

      assert.equal(context.skillPolicy.changedExecution, false);
      assert.deepEqual(context.skillPolicy.allowedSkills, ["review-changes", "self-improve"]);
      assert.deepEqual(context.skillPolicy.recommendedSkills, ["review-changes"]);
      assert.equal(context.skillPolicy.skillSources.length, 2);
      assert.equal(context.skillPolicy.vaultIndexPath, join(root, "vault", "topics", "skills.md"));
      assert.deepEqual(context.relevantSkills.map((skill) => skill.name), ["review-changes"]);
      assert.equal(context.relevantSkills[0]?.canonicalPath, join(root, ".claude", "skills", "review-changes", "SKILL.md"));
      assert.equal(context.relevantSkills[0]?.description, "Review committed changes against requirements.");
      assert.equal(context.relevantSkills[0]?.bodyIncluded, false);

      assert.equal(summary.skillSourceCount, 2);
      assert.equal(summary.relevantSkillCount, 1);
      assert.deepEqual(summary.relevantSkillNames, ["review-changes"]);
      assert.equal(summary.vaultSkillIndexPath, join(root, "vault", "topics", "skills.md"));

      assert.match(log, /skillSources=2/);
      assert.match(log, /relevantSkills=1/);
      assert.match(log, /selectedSkills=review-changes/);
      assert.match(log, /vaultSkillIndex=present/);
      assert.equal(log.includes("Full skill body stays canonical here"), false);
    } finally {
      cleanupRoot(root);
    }
  });

  it("does not select short skill names from substrings inside other words", () => {
    const root = makeHarnessRoot({
      builder:
        "---\n" +
        "runtime: codex\n" +
        "---\n" +
        "# Builder Agent\n\n" +
        "Build focused changes.\n",
    });
    try {
      writeSkill(root, "run",
        "---\n" +
        "name: run\n" +
        "description: Run a prepared operation.\n" +
        "user-invocable: true\n" +
        "---\n" +
        "# Run\n",
      );
      writeSkill(root, "spec",
        "---\n" +
        "name: spec\n" +
        "description: Prepare a feature specification.\n" +
        "user-invocable: true\n" +
        "---\n" +
        "# Spec\n",
      );

      const context = buildAgentContext({
        channelId: "agent-context-skill-substring",
        agentName: "builder",
        prompt: "Inspect the running process and respect existing behavior.",
        sessionKey: "agent-context-skill-substring:builder",
        runtime: "codex",
        harnessRoot: root,
      });

      assert.deepEqual(context.relevantSkills.map((skill) => skill.name), []);
      assert.deepEqual(context.skillPolicy.recommendedSkills, []);
    } finally {
      cleanupRoot(root);
    }
  });

  it("records distinct match reasons for bare, slash, and dollar skill mentions", () => {
    const root = makeHarnessRoot({
      builder:
        "---\n" +
        "runtime: codex\n" +
        "---\n" +
        "# Builder Agent\n\n" +
        "Build focused changes.\n",
    });
    try {
      writeSkill(root, "handoff",
        "---\n" +
        "name: handoff\n" +
        "description: Prepare fresh-chat handoffs.\n" +
        "user-invocable: true\n" +
        "---\n" +
        "# Handoff\n",
      );
      writeSkill(root, "review",
        "---\n" +
        "name: review\n" +
        "description: Review a change.\n" +
        "user-invocable: true\n" +
        "---\n" +
        "# Review\n",
      );
      writeSkill(root, "verify",
        "---\n" +
        "name: verify\n" +
        "description: Verify a result.\n" +
        "user-invocable: true\n" +
        "---\n" +
        "# Verify\n",
      );

      const context = buildAgentContext({
        channelId: "agent-context-skill-match-reasons",
        agentName: "builder",
        prompt: "Use /handoff, $review, and verify the result.",
        sessionKey: "agent-context-skill-match-reasons:builder",
        runtime: "codex",
        harnessRoot: root,
      });
      const reasonsBySkill = new Map(
        context.relevantSkills.map((skill) => [skill.name, skill.matchReasons]),
      );

      assert.deepEqual(context.relevantSkills.map((skill) => skill.name), [
        "handoff",
        "review",
        "verify",
      ]);
      assert.deepEqual(reasonsBySkill.get("handoff"), ["user-prompt-slash"]);
      assert.deepEqual(reasonsBySkill.get("review"), ["user-prompt-dollar"]);
      assert.deepEqual(reasonsBySkill.get("verify"), ["user-prompt-name"]);
      assert.deepEqual(context.skillPolicy.recommendedSkills, [
        "handoff",
        "review",
        "verify",
      ]);
    } finally {
      cleanupRoot(root);
    }
  });

  it("does not render AgentContext skill metadata into existing Codex prompts", async () => {
    const root = makeHarnessRoot({
      builder:
        "---\n" +
        "runtime: codex\n" +
        "---\n" +
        "# Builder Agent\n\n" +
        "Build focused changes.\n",
    });
    try {
      writeSkill(root, "handoff",
        "---\n" +
        "name: handoff\n" +
        "description: Prepare fresh-chat handoffs.\n" +
        "user-invocable: true\n" +
        "---\n" +
        "# Handoff\n",
      );

      const context = buildAgentContext({
        channelId: "agent-context-skill-render-boundary",
        agentName: "builder",
        prompt: "Use handoff metadata only in the shadow context.",
        sessionKey: "agent-context-skill-render-boundary:builder",
        runtime: "codex",
        harnessRoot: root,
      });
      const config = await buildCodexConfig({
        channelId: context.channelId,
        agentName: context.profile.name,
        prompt: context.userPrompt,
        sessionKey: context.sessionKey,
      });

      assert.deepEqual(context.relevantSkills.map((skill) => skill.name), ["handoff"]);
      assert.equal(config.prompt.includes("Prepare fresh-chat handoffs."), false);
      assert.equal(config.prompt.includes(".claude/skills/handoff/SKILL.md"), false);
    } finally {
      cleanupRoot(root);
    }
  });
});

describe("AgentContext memory population (Phase A)", () => {
  const channelsToCleanup = new Set<string>();

  afterEach(() => {
    for (const channelId of channelsToCleanup) cleanupChannel(channelId);
    channelsToCleanup.clear();
  });

  const BUILDER_FIXTURE = {
    builder:
      "---\nruntime: codex\nsandbox: workspace-write\n---\n# Builder Agent\n\nImplement focused code changes.\n",
  };

  it("passes through caller-injected recentConversation (transport-free)", () => {
    const root = makeHarnessRoot(BUILDER_FIXTURE);
    try {
      const convo = ["alice (2m ago): please refactor X", "builder (1m ago): on it"];
      const context = buildAgentContext({
        channelId: "agent-context-recentconvo",
        agentName: "builder",
        prompt: "continue",
        runtime: "codex",
        harnessRoot: root,
        recentConversation: convo,
      });
      assert.deepEqual(context.recentConversation, convo);
    } finally {
      cleanupRoot(root);
    }
  });

  it("defaults recentConversation to empty when not provided (general-chat parity)", () => {
    const root = makeHarnessRoot(BUILDER_FIXTURE);
    try {
      const context = buildAgentContext({
        channelId: "agent-context-recentconvo-empty",
        agentName: "builder",
        prompt: "continue",
        runtime: "codex",
        harnessRoot: root,
      });
      assert.deepEqual(context.recentConversation, []);
    } finally {
      cleanupRoot(root);
    }
  });

  it("keeps vaultMemory empty in the synchronous shadow builder (no embedding search)", () => {
    const root = makeHarnessRoot(BUILDER_FIXTURE);
    try {
      const context = buildAgentContext({
        channelId: "agent-context-sync-empty",
        agentName: "builder",
        prompt: "runtime abstraction agent profile",
        runtime: "codex",
        harnessRoot: root,
      });
      assert.deepEqual(context.vaultMemory, []);
    } finally {
      cleanupRoot(root);
    }
  });

  it("populates vaultMemory with exactly what the live learnings assembler produces (parity by construction)", async () => {
    const root = makeHarnessRoot(BUILDER_FIXTURE);
    const channelId = "agent-context-memory-parity";
    try {
      const prompt = "runtime abstraction agent profile context renderer";
      const context = await buildAgentContextWithMemory({
        channelId,
        agentName: "builder",
        prompt,
        runtime: "codex",
        harnessRoot: root,
        workflow: { kind: "subagent", taskId: "mem-parity-1" },
      });

      // The enriched context must surface EXACTLY what the live execution path
      // would inject for the learnings section — same call, side-effect-free.
      const expectedSection = await buildLearningsSection(
        prompt,
        extractKeywords(prompt),
        {
          agentName: "builder",
          channelId,
          taskId: "mem-parity-1",
          projectName: undefined,
        },
        { recordSideEffects: false },
      );
      const expected = expectedSection ? [expectedSection] : [];
      assert.deepEqual(context.vaultMemory, expected);
      // Sanity: vaultMemory is always an array (never undefined/null).
      assert.ok(Array.isArray(context.vaultMemory));
    } finally {
      cleanupRoot(root);
    }
  });

  it("leaves no truncation events in the shared monitor (side-effect-free memory read)", async () => {
    const root = makeHarnessRoot(BUILDER_FIXTURE);
    const channelId = "agent-context-memory-noleak";
    try {
      // Clear any pre-existing events so the assertion is about THIS call only.
      monitor.drainRecentEvents("context:learnings");
      await buildAgentContextWithMemory({
        channelId,
        agentName: "builder",
        prompt: "runtime abstraction long context truncation learnings agent profile",
        runtime: "codex",
        harnessRoot: root,
        workflow: { kind: "subagent", taskId: "mem-noleak-1" },
      });
      // A side-effect-free read must not leave its truncation events behind,
      // or the next live assembleContext() drain would mis-report them.
      const leftover = monitor.drainRecentEvents("context:learnings");
      assert.deepEqual(leftover, []);
    } finally {
      cleanupRoot(root);
    }
  });
});
