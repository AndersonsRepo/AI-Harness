/**
 * Agent Context
 *
 * Shadow-mode typed turn context. This module describes the durable agent and
 * invocation facts that existing prompt builders already consume through
 * separate paths. It deliberately does not render prompts or change execution.
 */

import {
  loadAgentProfile,
  type AgentProfile,
  type LoadAgentProfileOptions,
} from "./agent-profile.js";
import type { AgentRuntime } from "./agent-loader.js";
import { getChannelConfig } from "./channel-config-store.js";
import {
  getProject,
  resolveProjectWorkdir,
  type ProjectConfig,
} from "./project-manager.js";
import {
  buildSkillCatalogShadow,
  type SkillCatalogEntry,
} from "./skill-catalog.js";
import { buildLearningsSection, extractKeywords } from "./context-assembler.js";

export interface AgentContextWorkflow {
  // "chat" = the general-chat task-runner path (HARNESS_RENDER_CONTEXT=chat
  // selects it). "task" is legacy/unused. The value is a log label + flag
  // selector only — no behavior switches on it.
  kind: "runtime-invocation" | "handoff" | "parallel" | "subagent" | "chat" | "task";
  taskId?: string;
  worktreePath?: string | null;
  skipSessionResume?: boolean;
  isContinuation?: boolean;
}

export interface AgentContextChannelConfig {
  agent?: string;
  runtime?: AgentRuntime;
  permissionMode?: string;
  model?: string;
  allowedMcps?: string[];
}

export interface AgentContextProject {
  channelId: string;
  name: string;
  description: string;
  agents: string[];
  activeAgent?: string;
  workdir: string | null;
}

export interface AgentContextSkillSource {
  name: string;
  description: string;
  userInvocable: boolean;
  canonicalPath: string;
  supportedRuntimes: AgentRuntime[];
  source: SkillCatalogEntry["source"];
}

export interface AgentContextSkillSnippet {
  name: string;
  description: string;
  userInvocable: boolean;
  canonicalPath: string;
  source: SkillCatalogEntry["source"];
  matchReasons: string[];
  bodyIncluded: false;
}

export interface SkillPolicy {
  allowedSkills: string[];
  recommendedSkills: string[];
  disabledSkills: string[];
  skillSources: AgentContextSkillSource[];
  vaultIndexPath: string | null;
  changedExecution: false;
}

export interface AgentContext {
  profile: AgentProfile;
  channelId: string;
  channelName?: string;
  sessionKey: string;
  userPrompt: string;
  runtime: AgentRuntime;
  channelConfig: AgentContextChannelConfig;
  project: AgentContextProject | null;
  workflow: AgentContextWorkflow;
  operatorGuidance: string[];
  recentConversation: string[];
  vaultMemory: string[];
  skillPolicy: SkillPolicy;
  relevantSkills: AgentContextSkillSnippet[];
  changedExecution: false;
}

export interface AgentContextConfigParitySummary {
  effectiveAgentName: string;
  channelAgent?: string;
  sessionKey: string;
  selectedRuntime: AgentRuntime;
  channelRuntimeOverride?: AgentRuntime;
  channelModelOverride?: string;
  projectName: string | null;
  projectWorkdir: string | null;
  workflowKind: AgentContextWorkflow["kind"];
  taskId?: string;
  worktreePath?: string | null;
  skipSessionResume?: boolean;
  isContinuation?: boolean;
  operatorGuidanceCount: number;
  recentConversationCount: number;
  vaultMemoryCount: number;
  skillSourceCount: number;
  relevantSkillCount: number;
  relevantSkillNames: string[];
  vaultSkillIndexPath: string | null;
  changedExecution: false;
}

export interface ClaudeRendererParityConfig {
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface ClaudeRendererParitySummary {
  runtime: "claude";
  effectiveAgentName: string;
  sessionKey: string;
  appendSystemPromptCount: number;
  appendedAgentPrompt: boolean;
  appendedHarnessContext: boolean;
  extraSystemPromptCount: number;
  permissionMode?: string;
  model?: string;
  hasMcpConfig: boolean;
  strictMcpConfig: boolean;
  resumeSessionId?: string;
  promptArgument?: string;
  cwd: string;
  envHarnessSessionKey?: string;
  envHarnessFromAgent?: string;
  envProjectCwd?: string;
  changedExecution: false;
}

export interface ClaudeSkillRendererParitySummary {
  runtime: "claude";
  strategy: "preserve-native-skill-discovery";
  skillSourceCount: number;
  relevantSkillCount: number;
  relevantSkillNames: string[];
  nativeProjectSkillDiscovery: boolean;
  promptDuplicatesSkillMetadata: boolean;
  promptContainsSkillDescription: boolean;
  promptContainsCanonicalPath: boolean;
  bodyIncluded: false;
  changedExecution: false;
}

export interface CodexRendererParityConfig {
  prompt: string;
  runnerArgs: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface CodexRendererParitySummary {
  runtime: "codex";
  effectiveAgentName: string;
  sessionKey: string;
  hasAgentPersonalitySection: boolean;
  hasHarnessContextSection: boolean;
  hasOperatorGuidanceSection: boolean;
  operatorGuidanceCount: number;
  hasUserRequestSection: boolean;
  promptContainsUserRequest: boolean;
  sandbox?: string;
  workingDirectory?: string;
  cwd: string;
  hasSkipGitRepoCheck: boolean;
  approvalPolicyNever: boolean;
  mcpApprovalOverrideCount: number;
  harnessEnvOverrideCount: number;
  sessionId?: string;
  envHarnessSessionKey?: string;
  envHarnessFromAgent?: string;
  envProjectCwd?: string;
  changedExecution: false;
}

export interface CodexPlannedSkillContextEntry {
  name: string;
  description: string;
  canonicalPath: string;
  userInvocable: boolean;
  bodyIncluded: false;
}

export interface CodexSkillRendererParitySummary {
  runtime: "codex";
  strategy: "render-concise-relevant-skill-context";
  needsExplicitSkillContext: boolean;
  existingPromptHasSkillContext: boolean;
  plannedSectionTitle: "# Relevant Skills";
  plannedSkillEntries: CodexPlannedSkillContextEntry[];
  existingPromptContainsSkillDescription: boolean;
  existingPromptContainsCanonicalPath: boolean;
  changedExecution: false;
}

export interface BuildAgentContextInput {
  channelId: string;
  agentName?: string | null;
  prompt: string;
  sessionKey?: string | null;
  runtime: AgentRuntime;
  workflow?: Partial<AgentContextWorkflow>;
  extraSystemPrompts?: string[];
  harnessRoot?: LoadAgentProfileOptions["harnessRoot"];
  // Recent channel conversation, pre-formatted by the caller. This is
  // transport-owned data (e.g. Discord messages fetched by handoff-router),
  // so it is injected here rather than fetched — the durable-agent layer
  // stays transport-free (see LRN-20260520-001). General chat leaves this
  // empty because it relies on the runtime's own session resume, not on
  // injected history.
  recentConversation?: string[];
  // Human-readable channel name → HARNESS_CHANNEL_NAME in the spawn env.
  // Caller-injected (transport-owned), like recentConversation.
  channelName?: string | null;
}

function projectContext(project: ProjectConfig | null): AgentContextProject | null {
  if (!project) return null;
  return {
    channelId: project.channelId,
    name: project.name,
    description: project.description,
    agents: project.agents,
    activeAgent: project.activeAgent,
    workdir: resolveProjectWorkdir(project.name),
  };
}

function effectiveAgentName(
  explicitAgentName: string | null | undefined,
  channelAgent: string | undefined,
  project: ProjectConfig | null,
): string {
  return (
    explicitAgentName ||
    channelAgent ||
    project?.activeAgent ||
    project?.agents[0] ||
    "default"
  );
}

function workflowContext(
  workflow: Partial<AgentContextWorkflow> | undefined,
): AgentContextWorkflow {
  const result: AgentContextWorkflow = {
    kind: workflow?.kind ?? "runtime-invocation",
  };
  if (workflow?.taskId !== undefined) result.taskId = workflow.taskId;
  if (workflow?.worktreePath !== undefined) result.worktreePath = workflow.worktreePath;
  if (workflow?.skipSessionResume !== undefined) {
    result.skipSessionResume = workflow.skipSessionResume;
  }
  if (workflow?.isContinuation !== undefined) result.isContinuation = workflow.isContinuation;
  return result;
}

function skillSourceForContext(skill: SkillCatalogEntry): AgentContextSkillSource {
  return {
    name: skill.name,
    description: skill.description,
    userInvocable: skill.userInvocable,
    canonicalPath: skill.canonicalPath,
    supportedRuntimes: ["claude", "codex"],
    source: skill.source,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function promptSkillMatchReason(prompt: string, skillName: string): string | null {
  const escaped = escapeRegExp(skillName.toLowerCase());
  const haystack = prompt.toLowerCase();
  if (new RegExp(`(^|[^\\w-])/${escaped}(?=$|[^\\w-])`).test(haystack)) {
    return "user-prompt-slash";
  }
  if (new RegExp(`(^|[^\\w-])\\$${escaped}(?=$|[^\\w-])`).test(haystack)) {
    return "user-prompt-dollar";
  }
  if (new RegExp(`(^|[^\\w-])${escaped}(?=$|[^\\w-])`).test(haystack)) {
    return "user-prompt-name";
  }
  return null;
}

function relevantSkillForContext(
  prompt: string,
  skill: SkillCatalogEntry,
): AgentContextSkillSnippet | null {
  const matchReason = promptSkillMatchReason(prompt, skill.name);
  if (!matchReason) return null;
  return {
    name: skill.name,
    description: skill.description,
    userInvocable: skill.userInvocable,
    canonicalPath: skill.canonicalPath,
    source: skill.source,
    matchReasons: [matchReason],
    bodyIncluded: false,
  };
}

function buildSkillPolicyContext(
  input: BuildAgentContextInput,
): { skillPolicy: SkillPolicy; relevantSkills: AgentContextSkillSnippet[] } {
  const harnessRoot = input.harnessRoot ?? process.env.HARNESS_ROOT ?? ".";
  const catalog = buildSkillCatalogShadow({ harnessRoot });
  const skillSources = catalog.skills.map(skillSourceForContext);
  const relevantSkills = catalog.skills
    .map((skill) => relevantSkillForContext(input.prompt, skill))
    .filter((skill): skill is AgentContextSkillSnippet => Boolean(skill));

  return {
    skillPolicy: {
      allowedSkills: skillSources.map((skill) => skill.name),
      recommendedSkills: relevantSkills.map((skill) => skill.name),
      disabledSkills: [],
      skillSources,
      vaultIndexPath: catalog.vaultIndex?.canonicalPath ?? null,
      changedExecution: false,
    },
    relevantSkills,
  };
}

export function buildAgentContext(input: BuildAgentContextInput): AgentContext {
  const channelConfig = getChannelConfig(input.channelId);
  const project = getProject(input.channelId);
  const profileName = effectiveAgentName(input.agentName, channelConfig?.agent, project);
  const profile = loadAgentProfile(profileName, {
    harnessRoot: input.harnessRoot,
    allowDefault: true,
  })!;
  const skills = buildSkillPolicyContext(input);

  return {
    profile,
    channelId: input.channelId,
    channelName: input.channelName ?? undefined,
    sessionKey: input.sessionKey || input.channelId,
    userPrompt: input.prompt,
    runtime: input.runtime,
    channelConfig: {
      agent: channelConfig?.agent,
      runtime: channelConfig?.runtime,
      permissionMode: channelConfig?.permissionMode,
      model: channelConfig?.model,
      allowedMcps: channelConfig?.allowedMcps,
    },
    project: projectContext(project),
    workflow: workflowContext(input.workflow),
    operatorGuidance: input.extraSystemPrompts ?? [],
    recentConversation: input.recentConversation ?? [],
    vaultMemory: [],
    skillPolicy: skills.skillPolicy,
    relevantSkills: skills.relevantSkills,
    changedExecution: false,
  };
}

/**
 * Async variant that populates `vaultMemory` from the harness vault using the
 * SAME assembler the live execution path uses (`buildLearningsSection`), in a
 * side-effect-free mode so it neither writes retrieval_hits rows nor pollutes
 * the shared truncation monitor. The returned learnings are byte-identical to
 * what `assembleContext()` would inject for the raw-learnings section.
 *
 * This is kept separate from the synchronous `buildAgentContext` so cheap
 * shadow logging stays sync and never triggers an embedding search. Renderers
 * (Phase B+) and parity tests use this enriched variant.
 *
 * Note: topic-page-aware ordering/demotion is intentionally out of scope here;
 * this surfaces the raw relevant learnings. Topic-page handling can be added
 * when a renderer requires it.
 */
export async function buildAgentContextWithMemory(
  input: BuildAgentContextInput,
): Promise<AgentContext> {
  const base = buildAgentContext(input);
  let vaultMemory: string[] = [];
  try {
    const section = await buildLearningsSection(
      input.prompt,
      extractKeywords(input.prompt),
      {
        agentName: base.profile.name,
        channelId: input.channelId,
        taskId: input.workflow?.taskId ?? "agent-context-memory",
        projectName: base.project?.name,
      },
      { recordSideEffects: false },
    );
    if (section) vaultMemory = [section];
  } catch {
    // Vault retrieval is best-effort; an empty memory must never break context
    // assembly. Leave vaultMemory empty on failure.
    vaultMemory = [];
  }
  return { ...base, vaultMemory };
}

export function formatAgentContextShadowLog(context: AgentContext): string {
  return [
    "[AGENT_CONTEXT_SHADOW]",
    `agent=${context.profile.name}`,
    `profile=${context.profile.name}`,
    `runtime=${context.runtime}`,
    `session=${context.sessionKey ? "present" : "none"}`,
    `project=${context.project?.name ?? "none"}`,
    `channelAgent=${context.channelConfig.agent ?? "none"}`,
    `workflow=${context.workflow.kind}`,
    `operatorGuidance=${context.operatorGuidance.length}`,
    `recentConversation=${context.recentConversation.length}`,
    `vaultMemory=${context.vaultMemory.length}`,
    `skillSources=${context.skillPolicy.skillSources.length}`,
    `relevantSkills=${context.relevantSkills.length}`,
    `selectedSkills=${context.relevantSkills.map((skill) => skill.name).join(",") || "none"}`,
    `vaultSkillIndex=${context.skillPolicy.vaultIndexPath ? "present" : "none"}`,
    "execution=unchanged",
  ].join(" ");
}

export function summarizeAgentContextConfigParity(
  context: AgentContext,
): AgentContextConfigParitySummary {
  return {
    effectiveAgentName: context.profile.name,
    channelAgent: context.channelConfig.agent,
    sessionKey: context.sessionKey,
    selectedRuntime: context.runtime,
    channelRuntimeOverride: context.channelConfig.runtime,
    channelModelOverride: context.channelConfig.model,
    projectName: context.project?.name ?? null,
    projectWorkdir: context.project?.workdir ?? null,
    workflowKind: context.workflow.kind,
    taskId: context.workflow.taskId,
    worktreePath: context.workflow.worktreePath,
    skipSessionResume: context.workflow.skipSessionResume,
    isContinuation: context.workflow.isContinuation,
    operatorGuidanceCount: context.operatorGuidance.length,
    recentConversationCount: context.recentConversation.length,
    vaultMemoryCount: context.vaultMemory.length,
    skillSourceCount: context.skillPolicy.skillSources.length,
    relevantSkillCount: context.relevantSkills.length,
    relevantSkillNames: context.relevantSkills.map((skill) => skill.name),
    vaultSkillIndexPath: context.skillPolicy.vaultIndexPath,
    changedExecution: false,
  };
}

function valuesAfterFlag(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) values.push(args[i + 1]!);
  }
  return values;
}

function valueAfterFlag(args: string[], flag: string): string | undefined {
  return valuesAfterFlag(args, flag)[0];
}

function promptAfterSeparator(args: string[]): string | undefined {
  const idx = args.lastIndexOf("--");
  return idx >= 0 ? args[idx + 1] : undefined;
}

function continuationPrompt(): string {
  return "Continue where you left off. If you are done, do not include [CONTINUE].";
}

function containsAnySkillDescription(text: string, skills: AgentContextSkillSnippet[]): boolean {
  return skills.some((skill) => skill.description && text.includes(skill.description));
}

function containsAnySkillCanonicalPath(text: string, skills: AgentContextSkillSnippet[]): boolean {
  return skills.some((skill) => text.includes(skill.canonicalPath));
}

/**
 * Observational summary of the current Claude config-builder output for an
 * AgentContext. This is deliberately not a renderer and is not called by
 * execution paths; it pins the legacy shape before a future renderContext().
 */
export function summarizeClaudeRendererParity(
  context: AgentContext,
  config: ClaudeRendererParityConfig,
): ClaudeRendererParitySummary {
  const appendSystemPrompts = valuesAfterFlag(config.args, "--append-system-prompt");
  const expectedAgentPrompt = context.profile.rawSystemPrompt;
  const appendedAgentPrompt = Boolean(
    expectedAgentPrompt &&
      appendSystemPrompts.includes(expectedAgentPrompt),
  );
  const extraSystemPromptCount = context.operatorGuidance.filter((prompt) =>
    appendSystemPrompts.includes(prompt),
  ).length;
  const appendedHarnessContext = appendSystemPrompts.some((prompt) => {
    if (prompt === expectedAgentPrompt) return false;
    if (context.operatorGuidance.includes(prompt)) return false;
    return prompt.trim().length > 0;
  });

  return {
    runtime: "claude",
    effectiveAgentName: context.profile.name,
    sessionKey: context.sessionKey,
    appendSystemPromptCount: appendSystemPrompts.length,
    appendedAgentPrompt,
    appendedHarnessContext,
    extraSystemPromptCount,
    permissionMode: valueAfterFlag(config.args, "--permission-mode"),
    model: valueAfterFlag(config.args, "--model"),
    hasMcpConfig: Boolean(valueAfterFlag(config.args, "--mcp-config")),
    strictMcpConfig: config.args.includes("--strict-mcp-config"),
    resumeSessionId: valueAfterFlag(config.args, "--resume"),
    promptArgument: promptAfterSeparator(config.args),
    cwd: config.cwd,
    envHarnessSessionKey: config.env.HARNESS_SESSION_KEY,
    envHarnessFromAgent: config.env.HARNESS_FROM_AGENT,
    envProjectCwd: config.env.PROJECT_CWD,
    changedExecution: false,
  };
}

/**
 * Observational skill-rendering parity for Claude. Claude should keep native
 * project skill discovery as the primary affordance, while AgentContext records
 * which skills were relevant without duplicating SKILL.md metadata into prompts.
 */
export function summarizeClaudeSkillRendererParity(
  context: AgentContext,
  config: ClaudeRendererParityConfig,
): ClaudeSkillRendererParitySummary {
  const promptText = [
    ...valuesAfterFlag(config.args, "--append-system-prompt"),
    promptAfterSeparator(config.args) ?? "",
  ].join("\n");
  const promptContainsSkillDescription = containsAnySkillDescription(
    promptText,
    context.relevantSkills,
  );
  const promptContainsCanonicalPath = containsAnySkillCanonicalPath(
    promptText,
    context.relevantSkills,
  );

  return {
    runtime: "claude",
    strategy: "preserve-native-skill-discovery",
    skillSourceCount: context.skillPolicy.skillSources.length,
    relevantSkillCount: context.relevantSkills.length,
    relevantSkillNames: context.relevantSkills.map((skill) => skill.name),
    nativeProjectSkillDiscovery: context.skillPolicy.skillSources.some(
      (skill) => skill.source === "project",
    ),
    promptDuplicatesSkillMetadata: promptContainsSkillDescription || promptContainsCanonicalPath,
    promptContainsSkillDescription,
    promptContainsCanonicalPath,
    bodyIncluded: false,
    changedExecution: false,
  };
}

/**
 * Observational summary of the current Codex config-builder output for an
 * AgentContext. It keeps Codex's sectioned prompt and sandbox/MCP details
 * explicit instead of flattening them into a generic prompt abstraction.
 */
export function summarizeCodexRendererParity(
  context: AgentContext,
  config: CodexRendererParityConfig,
): CodexRendererParitySummary {
  const cOverrides = valuesAfterFlag(config.runnerArgs, "-c");
  const userPrompt = context.workflow.isContinuation
    ? continuationPrompt()
    : context.userPrompt;

  return {
    runtime: "codex",
    effectiveAgentName: context.profile.name,
    sessionKey: context.sessionKey,
    hasAgentPersonalitySection: config.prompt.includes("# Agent Personality"),
    hasHarnessContextSection: config.prompt.includes("# Harness Context"),
    hasOperatorGuidanceSection: config.prompt.includes("# Operator Guidance"),
    operatorGuidanceCount: context.operatorGuidance.filter((prompt) =>
      config.prompt.includes(prompt),
    ).length,
    hasUserRequestSection: config.prompt.includes("# User Request"),
    promptContainsUserRequest: config.prompt.includes(userPrompt),
    sandbox: valueAfterFlag(config.runnerArgs, "-s"),
    workingDirectory: valueAfterFlag(config.runnerArgs, "-C"),
    cwd: config.cwd,
    hasSkipGitRepoCheck: config.runnerArgs.includes("--skip-git-repo-check"),
    approvalPolicyNever: cOverrides.includes('approval_policy="never"'),
    mcpApprovalOverrideCount: cOverrides.filter((arg) =>
      /^mcp_servers\.[^.]+\.default_tools_approval_mode="approve"$/.test(arg),
    ).length,
    harnessEnvOverrideCount: cOverrides.filter((arg) =>
      /^mcp_servers\.harness\.env\.HARNESS_/.test(arg),
    ).length,
    sessionId: valueAfterFlag(config.runnerArgs, "--session-id"),
    envHarnessSessionKey: config.env.HARNESS_SESSION_KEY,
    envHarnessFromAgent: config.env.HARNESS_FROM_AGENT,
    envProjectCwd: config.env.PROJECT_CWD,
    changedExecution: false,
  };
}

/**
 * Observational skill-rendering parity for Codex. Codex has no Claude-native
 * skill discovery, so future rendering should provide concise relevant skill
 * summaries and canonical SKILL.md paths without copying full skill bodies.
 */
export function summarizeCodexSkillRendererParity(
  context: AgentContext,
  config: CodexRendererParityConfig,
): CodexSkillRendererParitySummary {
  return {
    runtime: "codex",
    strategy: "render-concise-relevant-skill-context",
    needsExplicitSkillContext: context.relevantSkills.length > 0,
    existingPromptHasSkillContext: config.prompt.includes("# Relevant Skills"),
    plannedSectionTitle: "# Relevant Skills",
    plannedSkillEntries: context.relevantSkills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      canonicalPath: skill.canonicalPath,
      userInvocable: skill.userInvocable,
      bodyIncluded: false,
    })),
    existingPromptContainsSkillDescription: containsAnySkillDescription(
      config.prompt,
      context.relevantSkills,
    ),
    existingPromptContainsCanonicalPath: containsAnySkillCanonicalPath(
      config.prompt,
      context.relevantSkills,
    ),
    changedExecution: false,
  };
}
