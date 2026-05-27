/**
 * Agent Profile
 *
 * Typed, behavior-preserving profile loader for existing `.claude/agents/*.md`
 * files. This sits above runtime selection/configuration and deliberately does
 * not change execution. Compatibility fields mirror current agent-loader.ts
 * behavior so later migrations can compare profile policy against legacy paths.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  AGENT_DEFAULT_MODELS,
  AGENT_TOOL_RESTRICTIONS,
  agentAllowsWrite,
  getAgentModel,
  type AgentRuntime,
  type CodexSandbox,
  type AgentToolRestrictions,
} from "./agent-loader.js";

const DEFAULT_HARNESS_ROOT = process.env.HARNESS_ROOT || ".";

export type ModelQualityTier = "fast" | "balanced" | "deep";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type RuntimeCapability =
  | "code_editing"
  | "evidence_retrieval"
  | "failure_analysis"
  | "long_context"
  | "source_sensitivity"
  | "state_tracking"
  | "structured_output"
  | "tool_execution"
  | "workflow_coordination";

export interface RuntimeModelHint {
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ModelPolicy {
  requiredCapabilities: RuntimeCapability[];
  preferredCapabilities: RuntimeCapability[];
  defaultTier: ModelQualityTier;
  escalationTriggers: string[];
  runtimeHints?: Partial<Record<AgentRuntime, RuntimeModelHint>>;
  fallbackBehavior: string;
}

export interface AgentMetadataProfile {
  runtime: AgentRuntime;
  sandbox?: CodexSandbox;
  raw: Record<string, string>;
}

export interface ToolPolicy {
  restrictions?: AgentToolRestrictions;
}

export interface PermissionPolicy {
  allowsFilesystemWrite: boolean;
  codexSandbox?: CodexSandbox;
}

export interface AgentProfileCompatibility {
  /**
   * Mirrors AGENT_DEFAULT_MODELS. Undefined means the Claude CLI default is
   * still used by current execution paths.
   */
  legacyClaudeModelDefault?: string;
}

export interface AgentProfile {
  name: string;
  role: string;
  description?: string;
  operatingPrinciples: string[];
  communicationStyle?: string;
  runtimePreference: AgentRuntime;
  runtimeFallbacks: AgentRuntime[];
  modelPolicy: ModelPolicy;
  toolPolicy: ToolPolicy;
  permissionPolicy: PermissionPolicy;
  memorySources: string[];
  outputExpectations: string[];
  rawSystemPrompt: string;
  rawMarkdown: string;
  metadata: AgentMetadataProfile;
  compatibility: AgentProfileCompatibility;
}

export interface LoadAgentProfileOptions {
  harnessRoot?: string;
  allowDefault?: boolean;
}

export interface RuntimePolicyCompatibility {
  preferredRuntime: AgentRuntime;
  fallbackOrder: AgentRuntime[];
}

export interface ModelPolicyTaskContext {
  prompt?: string;
  taskType?: string;
  risk?: "low" | "medium" | "high";
}

export interface ModelPolicyResolution {
  profileName: string;
  defaultTier: ModelQualityTier;
  selectedTier: ModelQualityTier;
  requiredCapabilities: RuntimeCapability[];
  preferredCapabilities: RuntimeCapability[];
  escalationTriggersMatched: string[];
  runtimeHints: Partial<Record<AgentRuntime, RuntimeModelHint>>;
  fallbackBehavior: string;
  legacyClaudeModelDefault?: string;
  changedExecution: false;
  reasons: string[];
}

export type LegacyModelSource = "channel-override" | "agent-default" | "cli-default";

export interface ModelPolicyShadowComparison {
  profileName: string;
  agentName: string | null;
  runtime: AgentRuntime;
  legacySelectedModel?: string;
  legacyModelSource: LegacyModelSource;
  recommendation: ModelPolicyResolution;
}

export interface ModelPolicyShadowComparisonInput {
  agentName?: string | null;
  runtime: AgentRuntime;
  prompt?: string;
  taskType?: string;
  channelModel?: string;
  harnessRoot?: string;
}

function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { fields: {}, body: text };
  }
  const afterOpen = text.indexOf("\n") + 1;
  const closeIdx = text.indexOf("\n---", afterOpen);
  if (closeIdx === -1) return { fields: {}, body: text };
  const fmRaw = text.slice(afterOpen, closeIdx);
  const endLineIdx = text.indexOf("\n", closeIdx + 1);
  const body = endLineIdx === -1 ? "" : text.slice(endLineIdx + 1);
  const fields: Record<string, string> = {};
  for (const line of fmRaw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (m) fields[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { fields, body };
}

function agentFilePath(name: string, harnessRoot: string): string {
  return join(harnessRoot, ".claude", "agents", `${name}.md`);
}

function fallbackOrder(runtime: AgentRuntime): AgentRuntime[] {
  return runtime === "codex" ? ["codex", "claude"] : ["claude", "codex"];
}

function parseRuntime(value: string | undefined): AgentRuntime {
  return value === "codex" ? "codex" : "claude";
}

function parseSandbox(value: string | undefined): CodexSandbox | undefined {
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  ) {
    return value;
  }
  return undefined;
}

function uniqueCapabilities(items: RuntimeCapability[]): RuntimeCapability[] {
  return [...new Set(items)];
}

function withLegacyClaudeHint(
  agentName: string,
  policy: ModelPolicy,
): ModelPolicy {
  const legacyModel = AGENT_DEFAULT_MODELS[agentName];
  if (!legacyModel) return policy;
  return {
    ...policy,
    runtimeHints: {
      ...policy.runtimeHints,
      claude: {
        ...policy.runtimeHints?.claude,
        model: legacyModel,
      },
    },
  };
}

function defaultModelPolicyForAgent(agentName: string): ModelPolicy {
  const fallbackBehavior =
    "Prefer the selected runtime/model that satisfies required capabilities; fall back by runtime policy when unavailable or rate-limited.";

  const base = (
    defaultTier: ModelQualityTier,
    requiredCapabilities: RuntimeCapability[],
    preferredCapabilities: RuntimeCapability[],
    escalationTriggers: string[],
    runtimeHints?: Partial<Record<AgentRuntime, RuntimeModelHint>>,
  ): ModelPolicy => withLegacyClaudeHint(agentName, {
    requiredCapabilities: uniqueCapabilities(requiredCapabilities),
    preferredCapabilities: uniqueCapabilities(preferredCapabilities),
    defaultTier,
    escalationTriggers,
    runtimeHints,
    fallbackBehavior,
  });

  switch (agentName) {
    case "orchestrator":
      return base(
        "deep",
        ["state_tracking", "workflow_coordination"],
        ["long_context", "structured_output"],
        ["multi_step_workflow", "handoff_recovery", "ambiguous_state"],
      );
    case "reviewer":
      return base(
        "deep",
        ["failure_analysis", "source_sensitivity"],
        ["long_context", "structured_output"],
        ["security_sensitive", "large_diff", "behavior_regression"],
      );
    case "tester":
      return base(
        "balanced",
        ["tool_execution", "failure_analysis"],
        ["long_context"],
        ["ambiguous_failure", "flaky_test", "cross_runtime_regression"],
      );
    case "project":
      return base(
        "deep",
        ["state_tracking", "long_context"],
        ["workflow_coordination", "evidence_retrieval"],
        ["architecture_planning", "cross_project_synthesis"],
      );
    case "builder":
      return base(
        "balanced",
        ["code_editing", "tool_execution"],
        ["failure_analysis", "long_context"],
        ["large_scope", "risky_code_change", "architecture_change"],
        { codex: { reasoningEffort: "medium" } },
      );
    case "researcher":
      return base(
        "balanced",
        ["evidence_retrieval"],
        ["long_context", "source_sensitivity"],
        ["novelty_or_ambiguity", "source_sensitivity", "high_stakes_claim"],
      );
    case "ops":
      return base(
        "balanced",
        ["tool_execution"],
        ["failure_analysis"],
        ["incident_planning", "risky_command"],
      );
    case "scheduler":
    case "commands":
      return base(
        "fast",
        ["tool_execution"],
        ["structured_output"],
        ["non_deterministic_coordination"],
      );
    case "education":
      return base(
        "balanced",
        ["long_context"],
        ["evidence_retrieval"],
        ["complex_tutoring", "exam_planning"],
      );
    case "quality-auditor":
      return base(
        "deep",
        ["failure_analysis", "source_sensitivity"],
        ["long_context", "evidence_retrieval"],
        ["subtle_regression", "cross_vendor_disagreement"],
      );
    case "hey-lexxi":
      return base(
        "balanced",
        ["source_sensitivity"],
        ["long_context", "structured_output"],
        ["phi_or_compliance", "production_risk", "safety_sensitive"],
      );
    default:
      return base(
        "balanced",
        [],
        ["long_context"],
        ["large_scope", "novelty_or_ambiguity", "high_stakes_claim"],
      );
  }
}

function buildProfile(args: {
  name: string;
  rawMarkdown: string;
  rawSystemPrompt: string;
  fields: Record<string, string>;
}): AgentProfile {
  const runtime = parseRuntime(args.fields.runtime);
  const sandbox = parseSandbox(args.fields.sandbox);
  const restrictions = AGENT_TOOL_RESTRICTIONS[args.name];
  const legacyClaudeModelDefault = AGENT_DEFAULT_MODELS[args.name];

  return {
    name: args.name,
    role: args.fields.role || args.name,
    description: args.fields.description || undefined,
    operatingPrinciples: [],
    communicationStyle: args.fields.communication_style || undefined,
    runtimePreference: runtime,
    runtimeFallbacks: fallbackOrder(runtime),
    modelPolicy: defaultModelPolicyForAgent(args.name),
    toolPolicy: restrictions ? { restrictions } : {},
    permissionPolicy: {
      allowsFilesystemWrite: agentAllowsWrite(args.name),
      codexSandbox: sandbox,
    },
    memorySources: [],
    outputExpectations: [],
    rawSystemPrompt: args.rawSystemPrompt,
    rawMarkdown: args.rawMarkdown,
    metadata: {
      runtime,
      sandbox,
      raw: args.fields,
    },
    compatibility: {
      legacyClaudeModelDefault,
    },
  };
}

function defaultProfile(name: string): AgentProfile {
  return buildProfile({
    name,
    rawMarkdown: "",
    rawSystemPrompt: "",
    fields: {},
  });
}

export function loadAgentProfile(
  name: string,
  opts: LoadAgentProfileOptions = {},
): AgentProfile | null {
  const harnessRoot = opts.harnessRoot ?? DEFAULT_HARNESS_ROOT;
  const path = agentFilePath(name, harnessRoot);
  if (!existsSync(path)) {
    return opts.allowDefault ? defaultProfile(name) : null;
  }

  const rawMarkdown = readFileSync(path, "utf-8");
  const { fields, body } = parseFrontmatter(rawMarkdown);
  const rawSystemPrompt = Object.keys(fields).length > 0 ? body : rawMarkdown;
  return buildProfile({
    name,
    rawMarkdown,
    rawSystemPrompt,
    fields,
  });
}

export function resolveRuntimePolicyCompatibility(
  agentName?: string | null,
  opts: Pick<LoadAgentProfileOptions, "harnessRoot"> = {},
): RuntimePolicyCompatibility {
  const profileName = agentName || "default";
  const profile = loadAgentProfile(profileName, {
    harnessRoot: opts.harnessRoot,
    allowDefault: true,
  })!;
  return {
    preferredRuntime: profile.runtimePreference,
    fallbackOrder: profile.runtimeFallbacks,
  };
}

function tierRank(tier: ModelQualityTier): number {
  return tier === "fast" ? 0 : tier === "balanced" ? 1 : 2;
}

function maxTier(a: ModelQualityTier, b: ModelQualityTier): ModelQualityTier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

function promptText(context: ModelPolicyTaskContext): string {
  return `${context.taskType || ""}\n${context.prompt || ""}`.toLowerCase();
}

function matchedEscalationTriggers(
  profile: AgentProfile,
  context: ModelPolicyTaskContext,
): string[] {
  const text = promptText(context);
  const matched = new Set<string>();

  if (context.risk === "high") matched.add("high_risk");
  if (/(security|auth|permission|exploit|compliance|phi|production)/.test(text)) {
    matched.add("high_stakes_claim");
    matched.add("security_sensitive");
  }
  if (/(novel|ambiguous|unknown|uncertain|research|architecture|tradeoff)/.test(text)) {
    matched.add("novelty_or_ambiguity");
  }
  if (/(large|broad|multi[- ]step|chain|handoff|workflow)/.test(text)) {
    matched.add("large_scope");
    matched.add("multi_step_workflow");
  }
  if (/(flaky|intermittent|race|timeout|failure)/.test(text)) {
    matched.add("ambiguous_failure");
  }

  return profile.modelPolicy.escalationTriggers.filter((trigger) => matched.has(trigger));
}

export function resolveModelPolicy(
  profile: AgentProfile,
  context: ModelPolicyTaskContext = {},
): ModelPolicyResolution {
  const matched = matchedEscalationTriggers(profile, context);
  const selectedTier = matched.length > 0
    ? maxTier(profile.modelPolicy.defaultTier, "deep")
    : profile.modelPolicy.defaultTier;
  const runtimeHints = profile.modelPolicy.runtimeHints ?? {};
  const reasons: string[] = [
    `default tier ${profile.modelPolicy.defaultTier}`,
  ];

  if (matched.length > 0) {
    reasons.push(`escalated by ${matched.join(", ")}`);
  }
  if (profile.compatibility.legacyClaudeModelDefault) {
    reasons.push(
      `preserves legacy Claude default ${profile.compatibility.legacyClaudeModelDefault}`,
    );
  }

  return {
    profileName: profile.name,
    defaultTier: profile.modelPolicy.defaultTier,
    selectedTier,
    requiredCapabilities: profile.modelPolicy.requiredCapabilities,
    preferredCapabilities: profile.modelPolicy.preferredCapabilities,
    escalationTriggersMatched: matched,
    runtimeHints,
    fallbackBehavior: profile.modelPolicy.fallbackBehavior,
    legacyClaudeModelDefault: profile.compatibility.legacyClaudeModelDefault,
    changedExecution: false,
    reasons,
  };
}

function legacyModelSource(
  agentName: string | null,
  channelModel?: string,
): LegacyModelSource {
  if (channelModel) return "channel-override";
  if (agentName && AGENT_DEFAULT_MODELS[agentName]) return "agent-default";
  return "cli-default";
}

export function resolveModelPolicyShadowComparison(
  input: ModelPolicyShadowComparisonInput,
): ModelPolicyShadowComparison {
  const agentName = input.agentName || null;
  const profileName = agentName || "default";
  const profile = loadAgentProfile(profileName, {
    harnessRoot: input.harnessRoot,
    allowDefault: true,
  })!;
  const legacySelectedModel = getAgentModel(
    agentName || undefined,
    input.channelModel,
  );
  const recommendation = resolveModelPolicy(profile, {
    prompt: input.prompt,
    taskType: input.taskType,
  });

  return {
    profileName: profile.name,
    agentName,
    runtime: input.runtime,
    legacySelectedModel,
    legacyModelSource: legacyModelSource(agentName, input.channelModel),
    recommendation,
  };
}

export function formatModelPolicyShadowLog(
  comparison: ModelPolicyShadowComparison,
): string {
  const legacy = comparison.legacySelectedModel ?? "cli-default";
  const claudeHint = comparison.recommendation.runtimeHints.claude?.model ?? "none";
  const codexEffort = comparison.recommendation.runtimeHints.codex?.reasoningEffort ?? "none";
  const triggers = comparison.recommendation.escalationTriggersMatched.length
    ? comparison.recommendation.escalationTriggersMatched.join(",")
    : "none";
  return [
    "[MODEL_POLICY_SHADOW]",
    `agent=${comparison.profileName}`,
    `runtime=${comparison.runtime}`,
    `legacy=${legacy}(${comparison.legacyModelSource})`,
    `tier=${comparison.recommendation.selectedTier}`,
    `claudeHint=${claudeHint}`,
    `codexEffort=${codexEffort}`,
    `triggers=${triggers}`,
    "execution=unchanged",
  ].join(" ");
}
