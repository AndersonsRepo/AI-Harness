import { TextChannel, Message } from "discord.js";
import { spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { parseParallelDirective, spawnParallelGroup } from "./tmux-orchestrator.js";
import {
  getProject,
  updateProject,
  incrementHandoffDepth,
  resetHandoffDepth,
  resolveProjectWorkdir,
} from "./project-manager.js";
import { setSession } from "./session-store.js";
import { getDb } from "./db.js";
import { FileWatcher, trackWatcher, untrackWatcher } from "./file-watcher.js";
import { monitor } from "./truncation-monitor.js";
import { needsWorktree, createWorktree, mergeWorktree, removeWorktree, isGitRepo, captureArtifacts, commitWorktreeIfDirty, ArtifactBundle } from "./worktree-manager.js";
import type { AgentRuntime } from "./agent-loader.js";
import { resolveRuntimePolicy } from "./role-policy.js";
import {
  HARNESS_ROOT,
  extractResponse,
  extractSessionId,
  buildClaudeConfig,
} from "./claude-config.js";
import { buildCodexConfig, extractCodexResponse, extractCodexSessionId } from "./codex-config.js";

const TEMP_DIR = join(HARNESS_ROOT, "bridges", "discord", ".tmp");
const MAX_CONTEXT_MESSAGES = 15;
const MAX_MSG_LENGTH = 500;

export interface HandoffDirective {
  targetAgent: string;
  message: string;
  preHandoffText: string;
}

export interface CreateChannelDirective {
  channelName: string;
  agent?: string;
  description?: string;
}

/**
 * Parse agent output for [CREATE_CHANNEL:name] directives.
 * Optional syntax: [CREATE_CHANNEL:name --agent builder "description"]
 */
export function parseCreateChannel(output: string): CreateChannelDirective | null {
  const match = output.match(
    /\[CREATE_CHANNEL\s*:\s*([\w-]+)(?:\s+--agent\s+(\w+))?(?:\s+"([^"]*)")?\]/i
  );
  if (!match) return null;
  return {
    channelName: match[1],
    agent: match[2],
    description: match[3],
  };
}

export function parseHandoff(output: string): HandoffDirective | null {
  const match = output.match(
    /\[(?:HANDOFF|handoff)\s*:\s*(\w+)\]\s*([\s\S]*?)$/
  );
  if (!match) return null;

  const targetAgent = match[1].toLowerCase();
  const message = match[2].trim();
  const preHandoffText = output.slice(0, match.index).trim();

  return { targetAgent, message, preHandoffText };
}

/**
 * Drain pending handoff_queue rows for a session_key, returning the first
 * one as a HandoffDirective. Tool-based handoff entry point: agents that
 * call mcp-harness/harness_handoff write a row to the queue; the bot calls
 * this after the agent's task completes to extract the requested handoff.
 *
 * If multiple pending rows exist (rare — agent emitted multiple handoff
 * tool calls in one response), returns the FIRST and marks the rest as
 * 'expired'. Parallel handoffs are not supported via this path; use
 * [PARALLEL:] for that.
 *
 * Returns null when the queue has no pending rows for this session.
 */
export function dequeueHandoff(sessionKey: string): HandoffDirective | null {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, from_agent, target_agent, task_description, pre_handoff_text
         FROM handoff_queue
        WHERE session_key = ? AND status = 'pending'
        ORDER BY id ASC`,
    )
    .all(sessionKey) as Array<{
      id: number;
      from_agent: string;
      target_agent: string;
      task_description: string;
      pre_handoff_text: string;
    }>;

  if (rows.length === 0) return null;

  const first = rows[0];
  const consumeStmt = db.prepare(
    `UPDATE handoff_queue SET status = 'consumed', consumed_at = datetime('now') WHERE id = ?`,
  );
  const expireStmt = db.prepare(
    `UPDATE handoff_queue SET status = 'expired', consumed_at = datetime('now') WHERE id = ?`,
  );
  consumeStmt.run(first.id);
  for (const row of rows.slice(1)) {
    expireStmt.run(row.id);
    console.warn(
      `[HANDOFF] Expired duplicate queue row id=${row.id} (session ${sessionKey} had ${rows.length} pending handoffs; only first is honored). Use [PARALLEL:] for multi-target delegation.`,
    );
  }

  return {
    targetAgent: first.target_agent.toLowerCase(),
    message: first.task_description,
    preHandoffText: first.pre_handoff_text || "",
  };
}

export async function buildProjectContext(
  channel: TextChannel,
  agentName: string,
  project: { name: string; description: string; agents: string[] },
  chainContext?: { completedPhases: ChainEntry[]; currentTask: string }
): Promise<string> {
  const contextLines: string[] = [
    `[Project: ${project.name}]`,
    `Description: ${project.description}`,
    `Participating agents: ${project.agents.join(", ")}`,
    `You are the ${agentName} agent.`,
    "",
  ];

  // If chain context exists, use it instead of raw Discord scraping
  if (chainContext && chainContext.completedPhases.length > 0) {
    contextLines.push("--- Completed phases ---");
    for (const entry of chainContext.completedPhases) {
      const truncated = entry.response.length > 300
        ? entry.response.slice(0, 300) + "..."
        : entry.response;
      contextLines.push(`[${entry.agent}]: ${truncated}`);
    }
    contextLines.push("--- End ---");
    contextLines.push("");

    // Abbreviated recent messages as fallback context (last 5, 300 chars each)
    const messages = await channel.messages.fetch({ limit: 5 });
    const sorted = [...messages.values()].reverse();
    if (sorted.length > 0) {
      contextLines.push("--- Recent messages (abbreviated) ---");
      for (const msg of sorted) {
        const author = msg.author.bot ? extractAgentName(msg.content) : msg.author.username;
        const content = msg.content.length > 300
          ? msg.content.slice(0, 300) + "..."
          : msg.content;
        contextLines.push(`${author}: ${content}`);
      }
      contextLines.push("--- End ---");
    }
  } else {
    // No chain context — use full Discord message history
    const messages = await channel.messages.fetch({ limit: MAX_CONTEXT_MESSAGES });
    const sorted = [...messages.values()].reverse();

    contextLines.push("--- Recent conversation ---");
    for (const msg of sorted) {
      const author = msg.author.bot ? extractAgentName(msg.content) : msg.author.username;
      const content =
        msg.content.length > MAX_MSG_LENGTH
          ? msg.content.slice(0, MAX_MSG_LENGTH) + "..."
          : msg.content;
      const timeAgo = getTimeAgo(msg.createdTimestamp);
      contextLines.push(`${author} (${timeAgo}): ${content}`);
    }
    contextLines.push("--- End of conversation ---");
  }

  contextLines.push(
    "",
    `Respond as the ${agentName} agent. When you need another agent's expertise, use [HANDOFF:agent_name] followed by what you need them to do.`,
    `Available agents: ${project.agents.join(", ")}`,
    `Complete your own work first before handing off.`
  );

  return contextLines.join("\n");
}

function extractAgentName(content: string): string {
  const match = content.match(/^\*\*(\w+):\*\*/);
  return match ? match[1] : "bot";
}

function getTimeAgo(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

// extractResponse and extractSessionId imported from claude-config.ts

export function getProjectSessionKey(
  channelId: string,
  agentName: string
): string {
  return `${channelId}:${agentName}`;
}

// --- Chain Log Types ---

export interface ChainEntry {
  agent: string;
  response: string; // truncated to ~2000 chars for debrief context
  timestamp: number;
  // Real implementation evidence captured from the chain worktree at the moment
  // this entry was recorded. Only populated for writer agents when a worktree
  // exists. Enables cross-runtime review gates to see an actual diff instead of
  // just the truncated prose in `response`.
  artifacts?: ArtifactBundle;
}

export interface ChainResult {
  entries: ChainEntry[];
  originAgent: string;
  parallelGroupId?: string; // Set when chain is suspended for parallel execution
}

// --- ChainSink ---
// Transport-agnostic interface for delivering chain output. DiscordSink
// posts to a Discord channel; NullSink swallows everything (used by replay
// and other headless callers). The chain loop calls only these methods, so
// it never imports discord.js directly.
export interface ChainSink {
  /** Post the pre-handoff portion of an agent's response (text before [HANDOFF:...]). */
  postPreHandoffText(agent: string, text: string): Promise<void>;
  /** Post an agent's full response when no further handoff follows. */
  postAgentResponse(agent: string, text: string): Promise<void>;
  /** Post the auto-gate notice header (e.g. "Auto-gate: Builder → Reviewer"). */
  postGateNotice(fromAgent: string, gateAgent: string): Promise<void>;
  /** Post a post-chain gate agent's response. */
  postGateResponse(gateAgent: string, text: string): Promise<void>;
  /** Post a free-text warning/system notice. */
  postWarning(text: string): Promise<void>;
  /** Post a delivery-failure warning when an agent's response can't be sent. */
  postDeliveryFailure(agent: string, errorMessage: string): Promise<void>;
}

export class DiscordSink implements ChainSink {
  constructor(private readonly channel: TextChannel) {}

  async postPreHandoffText(agent: string, text: string): Promise<void> {
    if (!text) return;
    const chunks = monitor.splitForDiscord(
      `**${capitalize(agent)}:** ${text}`,
      1900,
      "handoff:chain-pre-text",
    );
    for (const chunk of chunks) await this.channel.send(chunk);
  }

  async postAgentResponse(agent: string, text: string): Promise<void> {
    const chunks = monitor.splitForDiscord(
      `**${capitalize(agent)}:** ${text}`,
      1900,
      "handoff:response",
    );
    for (const chunk of chunks) await this.channel.send(chunk);
  }

  async postGateNotice(fromAgent: string, gateAgent: string): Promise<void> {
    await this.channel
      .send(`*Auto-gate: ${capitalize(fromAgent)} output → ${capitalize(gateAgent)}*`)
      .catch((err) => console.error(`[HANDOFF] Failed to send gate notice: ${err.message}`));
  }

  async postGateResponse(gateAgent: string, text: string): Promise<void> {
    const chunks = monitor.splitForDiscord(
      `**${capitalize(gateAgent)}:** ${text}`,
      1900,
      `handoff:gate-${gateAgent}`,
    );
    for (const chunk of chunks) await this.channel.send(chunk);
  }

  async postWarning(text: string): Promise<void> {
    await this.channel.send(text).catch(() => {});
  }

  async postDeliveryFailure(agent: string, errorMessage: string): Promise<void> {
    await this.channel
      .send(
        `*Failed to deliver ${agent}'s response (${errorMessage}). The agent completed but the message couldn't be posted.*`,
      )
      .catch(() => {});
  }
}

export class NullSink implements ChainSink {
  async postPreHandoffText(): Promise<void> {}
  async postAgentResponse(): Promise<void> {}
  async postGateNotice(): Promise<void> {}
  async postGateResponse(): Promise<void> {}
  async postWarning(): Promise<void> {}
  async postDeliveryFailure(): Promise<void> {}
}

// --- Post-Chain Gates (deterministic) ---
// After chain terminates, if the final agent is a key in this map, each gate
// agent in the list runs in sequence (provided it hasn't already participated
// in the chain AND is a member of the project's agents). Each gate sees the
// previous agent's output as its input.
//
// Order matters: reviewer first (static analysis of the diff), then tester
// (runtime verification). Both are injected automatically — the LLM cannot
// skip either one.
const POST_CHAIN_GATES: Record<string, string[]> = {
  builder: ["reviewer", "tester"],
};

function formatArtifactSection(artifacts?: ArtifactBundle): string {
  if (!artifacts) return "";
  const sections: string[] = [];
  if (artifacts.changedFiles?.length) {
    sections.push(
      `## Changed Files\n\n${artifacts.changedFiles.map((f) => `- ${f}`).join("\n")}`,
    );
  }
  if (artifacts.diff) {
    const note = artifacts.truncated ? " (truncated to 50KB)" : "";
    sections.push(
      `## Diff${note}\n\n\`\`\`diff\n${artifacts.diff}\n\`\`\``,
    );
  }
  return sections.length ? `\n\n${sections.join("\n\n")}` : "";
}

function gatePromptFor(
  gateAgent: string,
  fromAgent: string,
  previousOutput: string,
  artifacts?: ArtifactBundle,
): string {
  const evidence = formatArtifactSection(artifacts);
  if (gateAgent === "reviewer") {
    return `Review the following ${fromAgent} output for quality, correctness, and potential issues:\n\n${previousOutput}${evidence}`;
  }
  if (gateAgent === "tester") {
    return `Verify that the following ${fromAgent} changes actually run and behave correctly. Pick the minimum viable verification strategy based on the scope of the change, execute it, and report PASS/FAIL with concrete evidence.\n\nChange summary:\n\n${previousOutput}${evidence}`;
  }
  return `Process the following ${fromAgent} output:\n\n${previousOutput}${evidence}`;
}

export interface PostChainGateRequest {
  gateAgent: string;
  fromAgent: string;
  artifact: {
    summary: string;
    diff?: string;
    changedFiles?: string[];
    truncated?: boolean;
  };
  prompt: string;
}

export function resolveHandoffRuntime(channelId: string, agentName: string): AgentRuntime {
  return resolveRuntimePolicy({
    channelId,
    agentName,
  }).selectedRuntime;
}

export function buildPostChainGateRequests(
  chainEntries: ChainEntry[],
  projectAgents?: string[],
): PostChainGateRequest[] {
  const finalEntry = chainEntries[chainEntries.length - 1];
  if (!finalEntry) return [];

  const gateAgents = POST_CHAIN_GATES[finalEntry.agent];
  if (!gateAgents?.length) return [];

  return gateAgents
    .filter((gateAgent) => !chainEntries.some((entry) => entry.agent === gateAgent))
    .filter((gateAgent) => !projectAgents || projectAgents.includes(gateAgent))
    .map((gateAgent) => ({
      gateAgent,
      fromAgent: finalEntry.agent,
      artifact: {
        summary: finalEntry.response,
        diff: finalEntry.artifacts?.diff,
        changedFiles: finalEntry.artifacts?.changedFiles,
        truncated: finalEntry.artifacts?.truncated,
      },
      prompt: gatePromptFor(
        gateAgent,
        finalEntry.agent,
        finalEntry.response,
        finalEntry.artifacts,
      ),
    }));
}

export interface HandoffResult {
  agentName: string;
  response: string;
  nextHandoff: HandoffDirective | null;
}

// --- AgentExecutor ---
// Transport-agnostic interface for executing a single handoff step.
// DiscordAgentExecutor wraps executeHandoff (production); HeadlessAgentExecutor
// (defined in tools/regression-replay/spawn-helper.ts) wraps runAgent for
// replay. The chain loop calls only this interface, so executeChainCore
// never imports discord.js.
export interface ExecuteAgentArgs {
  fromAgent: string;
  toAgent: string;
  handoffMessage: string;
  preHandoffText: string;
  chainContext?: { completedPhases: ChainEntry[]; currentTask: string };
  worktreePath?: string | null;
  /**
   * If true, the spawn config skips `--resume <session-id>`, forcing the
   * receiving agent to start with a fresh conversation. Use for stateless
   * verification agents (post-chain reviewer/tester) — their session IDs
   * accumulate across runs and can fail to resume with "No conversation
   * found" if claude-cli no longer has them. See ERR-20260426-036.
   */
  skipSessionResume?: boolean;
}

export interface AgentExecutor {
  execute(args: ExecuteAgentArgs): Promise<HandoffResult | null>;
}

export class DiscordAgentExecutor implements AgentExecutor {
  constructor(private readonly channel: TextChannel) {}

  async execute(args: ExecuteAgentArgs): Promise<HandoffResult | null> {
    return executeHandoff(
      this.channel,
      args.fromAgent,
      args.toAgent,
      args.handoffMessage,
      args.preHandoffText,
      args.chainContext,
      args.worktreePath,
      args.skipSessionResume,
    );
  }
}

/**
 * Build the per-handoff agent prompt.
 *
 * Pure helper extracted from executeHandoff so production and replay
 * paths produce byte-identical prompt strings on the same input. The
 * format is `${context}\n\n${Capitalized fromAgent} has handed off to
 * you with this request:\n${handoffMessage}`.
 */
export function buildHandoffPrompt(
  context: string,
  fromAgent: string,
  handoffMessage: string,
): string {
  return `${context}\n\n${capitalize(fromAgent)} has handed off to you with this request:\n${handoffMessage}`;
}

export interface ExecuteHandoffCoreParams {
  channelId: string;
  toAgent: string;
  prompt: string;
  sessionKey: string;
  runtime: AgentRuntime;
  worktreePath?: string | null;
  /**
   * Wall-clock cap in ms. Default 600_000 (10 min) — sized for chain
   * builders doing real work; readonly agents (reviewer/researcher)
   * usually finish well under. Override per-call if you have a specific
   * reason (e.g. larger context-rich edits, slower Codex thread).
   */
  timeoutMs?: number;
  /**
   * If true, the spawn skips `--resume <session-id>` even when a stored
   * session exists for this sessionKey. Used for stateless verification
   * agents (post-chain reviewer/tester) — see ERR-20260426-036 for why
   * accumulated session IDs cause "No conversation found" failures on
   * second-run gates.
   */
  skipSessionResume?: boolean;
}

export type ExecuteHandoffCoreResult =
  | {
      ok: true;
      agentName: string;
      response: string;
      nextHandoff: HandoffDirective | null;
      sessionId: string | null;
    }
  | { ok: false; reason: "exit-nonzero"; errorMessage: string }
  | { ok: false; reason: "no-response" }
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "parse-error"; errorMessage: string };

/**
 * Discord-decoupled spawn + parse for a single handoff step.
 *
 * Builds the runner config (codex or claude), spawns python3 detached,
 * watches for output via FileWatcher, parses the response, persists the
 * session ID, and returns a result variant. Does not touch Discord —
 * the caller is responsible for translating error variants into user-
 * facing notices.
 */
export async function executeHandoffCore(
  params: ExecuteHandoffCoreParams,
): Promise<ExecuteHandoffCoreResult> {
  const {
    channelId,
    toAgent,
    prompt,
    sessionKey,
    runtime,
    worktreePath,
    // 10 min default. The previous 3 min ceiling was too tight for chain
    // builders doing real work (read repo + write code + run validation,
    // possibly via Codex which has its own startup overhead). 10 min covers
    // typical builder/tester steps; reviewer/researcher usually finish
    // well under. Raise via param if you have a specific reason.
    timeoutMs = 600_000,
    skipSessionResume = false,
  } = params;

  // Runner-level timeout (seconds) matches the watcher-level timeout (ms)
  // so claude-runner.py / codex-runner.py kill their child agent BEFORE the
  // FileWatcher gives up — the runner's timeout writes a structured error
  // envelope which the watcher then reads, vs. the watcher firing first and
  // leaving an orphan agent process.
  const runnerTimeoutSecs = String(Math.max(1, Math.floor(timeoutMs / 1000)));

  const outputFile = join(
    TEMP_DIR,
    `handoff-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  let promptFile: string | null = null;

  let pythonArgs: string[];
  let childCwd: string;
  let childEnv: Record<string, string>;

  if (runtime === "codex") {
    const config = await buildCodexConfig({
      channelId,
      prompt,
      agentName: toAgent,
      sessionKey,
      taskId: "handoff",
      worktreePath,
      skipSessionResume,
    });

    promptFile = join(
      TEMP_DIR,
      `handoff-${Date.now()}-${Math.random().toString(36).slice(2)}.prompt.txt`,
    );
    writeFileSync(promptFile, config.prompt, "utf-8");

    pythonArgs = [
      `${HARNESS_ROOT}/bridges/discord/codex-runner.py`,
      outputFile,
      "--timeout",
      runnerTimeoutSecs,
      "--prompt-file",
      promptFile,
      ...config.runnerArgs,
    ];
    childCwd = config.cwd;
    childEnv = config.env;
  } else {
    const config = await buildClaudeConfig({
      channelId,
      prompt,
      agentName: toAgent,
      sessionKey,
      taskId: "handoff",
      worktreePath,
      skipSessionResume,
    });

    pythonArgs = [
      `${HARNESS_ROOT}/bridges/discord/claude-runner.py`,
      outputFile,
      "--timeout",
      runnerTimeoutSecs,
      ...config.args,
    ];
    childCwd = config.cwd;
    childEnv = config.env;
  }

  return new Promise<ExecuteHandoffCoreResult>((resolve) => {
    const childProc = spawn("python3", pythonArgs, {
      cwd: childCwd,
      env: childEnv,
      detached: true,
      stdio: "ignore",
    });
    childProc.unref();

    const watcher = new FileWatcher({
      filePath: outputFile,
      onFile: async (content: string) => {
        untrackWatcher(watcher);

        try {
          if (promptFile && existsSync(promptFile)) {
            unlinkSync(promptFile);
          }
          if (existsSync(outputFile)) {
            unlinkSync(outputFile);
          }

          const result = JSON.parse(content);
          const { stdout, stderr, returncode } = result;

          if (returncode !== 0) {
            const errorMsg = stderr?.trim() || `Agent exited with code ${returncode}`;
            resolve({ ok: false, reason: "exit-nonzero", errorMessage: errorMsg });
            return;
          }

          const responseText = runtime === "codex"
            ? extractCodexResponse(result)
            : extractResponse(stdout);
          const sessionId = runtime === "codex"
            ? extractCodexSessionId(result)
            : extractSessionId(stdout);

          if (sessionId) {
            setSession(sessionKey, sessionId, runtime);
          }

          if (!responseText) {
            resolve({ ok: false, reason: "no-response" });
            return;
          }

          const nextHandoff = parseHandoff(responseText);
          resolve({
            ok: true,
            agentName: toAgent,
            response: responseText,
            nextHandoff,
            sessionId: sessionId ?? null,
          });
        } catch (err: any) {
          console.error(`[HANDOFF] Error reading output: ${err.message}`);
          resolve({ ok: false, reason: "parse-error", errorMessage: err.message });
        }
      },
      onTimeout: async () => {
        untrackWatcher(watcher);
        if (promptFile && existsSync(promptFile)) {
          unlinkSync(promptFile);
        }
        resolve({ ok: false, reason: "timeout" });
      },
      timeoutMs,
      fallbackPollMs: 2000,
      retryReadMs: 100,
    });
    trackWatcher(watcher);
    watcher.start();
  });
}

export async function executeHandoff(
  channel: TextChannel,
  fromAgent: string,
  toAgent: string,
  handoffMessage: string,
  preHandoffText: string,
  chainContext?: { completedPhases: ChainEntry[]; currentTask: string },
  worktreePath?: string | null,
  skipSessionResume?: boolean,
): Promise<HandoffResult | null> {
  const project = getProject(channel.id);
  if (!project) return null;

  // Check if target agent is valid
  if (!project.agents.includes(toAgent)) {
    await channel.send(
      `**System:** Agent \`${toAgent}\` is not assigned to this project. Available: ${project.agents.join(", ")}`
    ).catch((err) => console.error(`[HANDOFF] Failed to send invalid-agent notice: ${err.message}`));
    return null;
  }

  // Self-handoff prevention
  if (fromAgent === toAgent) {
    await channel.send(
      `**System:** ${fromAgent} tried to hand off to itself. Skipping.`
    ).catch((err) => console.error(`[HANDOFF] Failed to send self-handoff notice: ${err.message}`));
    return null;
  }

  // Depth check
  const depth = incrementHandoffDepth(channel.id);
  const maxDepth = project.maxHandoffDepth || 20;

  if (depth > maxDepth) {
    await channel.send(
      `**Handoff limit reached (${maxDepth}).** The agents have been collaborating for a while.\n\nLast handoff: ${fromAgent} → ${toAgent}: "${handoffMessage.slice(0, 200)}"\n\nPlease direct the next step or type a message to continue.`
    ).catch((err) => console.error(`[HANDOFF] Failed to send depth-limit notice: ${err.message}`));
    resetHandoffDepth(channel.id);
    return null;
  }

  // Post the from→to arrow. Pre-handoff text itself is posted by the caller:
  // bot.ts / discord-transport.ts handle the initial step before invoking
  // runHandoffChain; executeChainCore posts subsequent steps via
  // sink.postPreHandoffText. Posting it here too caused the message to
  // appear twice in Discord.
  try {
    await channel.send(
      `*${capitalize(fromAgent)} → ${capitalize(toAgent)}:* ${handoffMessage.slice(0, 500)}`
    );
  } catch (err: any) {
    console.error(`[HANDOFF] Failed to post handoff arrow: ${err.message}`);
  }

  // Update active agent
  updateProject(channel.id, { activeAgent: toAgent });

  // Build context (still Discord-coupled — fetches msg history) and final prompt.
  const context = await buildProjectContext(channel, toAgent, project, chainContext);
  const prompt = buildHandoffPrompt(context, fromAgent, handoffMessage);

  const sessionKey = getProjectSessionKey(channel.id, toAgent);
  const runtime = resolveHandoffRuntime(channel.id, toAgent);

  // Show typing while the core runs.
  channel.sendTyping().catch(() => {});
  let coreDone = false;
  const typingInterval = setInterval(() => {
    if (coreDone) {
      clearInterval(typingInterval);
      return;
    }
    channel.sendTyping().catch(() => {});
  }, 8000);

  let result: ExecuteHandoffCoreResult;
  try {
    result = await executeHandoffCore({
      channelId: channel.id,
      toAgent,
      prompt,
      sessionKey,
      runtime,
      worktreePath,
      skipSessionResume,
    });
  } finally {
    coreDone = true;
    clearInterval(typingInterval);
  }

  if (!result.ok) {
    if (result.reason === "exit-nonzero") {
      await channel.send(
        `**${capitalize(toAgent)}:** Something went wrong:\n\`\`\`\n${result.errorMessage.slice(0, 500)}\n\`\`\``,
      ).catch((err) => console.error(`[HANDOFF] Failed to send error notice: ${err.message}`));
    } else if (result.reason === "no-response") {
      await channel.send(
        `**${capitalize(toAgent)}:** Got a response but couldn't parse it.`,
      ).catch((err) => console.error(`[HANDOFF] Failed to send parse-error notice: ${err.message}`));
    } else if (result.reason === "timeout") {
      await channel.send(
        `**${capitalize(toAgent)}:** Timed out before producing a response.`,
      ).catch((err) => console.error(`[HANDOFF] Failed to send timeout notice: ${err.message}`));
    }
    // parse-error: console-logged inside core; no Discord notice (matches original).
    return null;
  }

  return {
    agentName: result.agentName,
    response: result.response,
    nextHandoff: result.nextHandoff,
  };
}

export interface ExecuteChainCoreParams {
  /** Channel ID — used for project lookup, parallel-group spawn, and worktree owner attribution. */
  channelId: string;
  /** Sink for delivering chain output (DiscordSink in production, NullSink in replay). */
  sink: ChainSink;
  /** Executor that performs each handoff step (DiscordAgentExecutor in production, HeadlessAgentExecutor in replay). */
  executor: AgentExecutor;
  /** The first agent in the chain — its response was already produced upstream. */
  initialAgent: string;
  /** That agent's full response text (may contain a [HANDOFF:...] directive). */
  initialResponse: string;
  /** Conventionally the agent that originated the chain. */
  originAgent: string;
  /**
   * Pre-resolved seed handoff (from the harness_handoff tool's queue).
   * When set, the chain uses this instead of parsing initialResponse for
   * a [HANDOFF:] directive. The chain still parses initialResponse for a
   * [PARALLEL:] directive — those don't go through the queue.
   */
  initialHandoff?: HandoffDirective;
}

/**
 * Transport-agnostic chain-execution primitive.
 *
 * Drives the handoff loop, captures per-step artifacts, runs post-chain
 * gates, and manages chain-scoped worktree lifecycle. Output delivery
 * happens through `sink`; per-step execution happens through `executor`.
 * The chain primitive imports zero discord.js — both Discord and replay
 * paths satisfy the ChainSink + AgentExecutor interfaces.
 */
export async function executeChainCore(
  params: ExecuteChainCoreParams,
): Promise<ChainResult> {
  const { channelId, sink, executor, initialAgent, initialResponse, originAgent } = params;
  const chainEntries: ChainEntry[] = [];

  // Record the initial agent's response in the chain log
  chainEntries.push({
    agent: initialAgent,
    response: initialResponse.slice(0, 2000),
    timestamp: Date.now(),
  });

  // Check for parallel directive before sequential handoff
  const parallelDirective = parseParallelDirective(initialResponse);
  if (parallelDirective) {
    console.log(`[HANDOFF] Parallel directive detected: ${parallelDirective.agents.join(", ")}`);
    try {
      const groupId = await spawnParallelGroup({
        channelId,
        directive: parallelDirective,
      });
      // Chain suspends — will resume when parallel tasks complete via [PARALLEL_COMPLETE]
      return { entries: chainEntries, originAgent, parallelGroupId: groupId };
    } catch (err: any) {
      console.error(`[HANDOFF] Failed to spawn parallel group: ${err.message}`);
      await sink.postWarning(`*Failed to start parallel tasks: ${err.message}*`);
    }
  }

  let handoff = params.initialHandoff ?? parseHandoff(initialResponse);
  let fromAgent = initialAgent;

  // Lazy worktree creation — created on first handoff to a writer agent
  const chainId = `chain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let chainWorktreePath: string | null = null;
  let chainWorktreeId: string | null = null;

  while (handoff) {
    // Create worktree lazily on first handoff to a writer
    if (!chainWorktreePath && needsWorktree([handoff.targetAgent])) {
      const project = getProject(channelId);
      const projectCwd = project ? resolveProjectWorkdir(project.name) : null;
      if (projectCwd && isGitRepo(projectCwd)) {
        const wt = createWorktree(projectCwd, project!.name, chainId, channelId, { chainId });
        if (wt) {
          chainWorktreePath = wt.worktree_path;
          chainWorktreeId = wt.id;
          console.log(`[HANDOFF] Worktree created for chain ${chainId}: ${chainWorktreePath}`);
        }
      }
    }

    const result = await executor.execute({
      fromAgent,
      toAgent: handoff.targetAgent,
      handoffMessage: handoff.message,
      preHandoffText: handoff.preHandoffText,
      chainContext: { completedPhases: chainEntries, currentTask: handoff.message },
      worktreePath: chainWorktreePath,
    });

    if (!result) break; // Chain ended (error, depth limit, or invalid agent)

    // Record this agent's response in the chain log. If the chain has an active
    // worktree and this agent could have mutated it, capture a diff + changed-
    // file list so downstream review/test gates see real evidence — especially
    // important across runtime boundaries (Codex builder → Claude reviewer).
    const entryArtifacts = captureArtifacts(chainWorktreePath);
    chainEntries.push({
      agent: result.agentName,
      response: result.response.slice(0, 2000),
      timestamp: Date.now(),
      artifacts: entryArtifacts,
    });

    // Determine next handoff: prefer the harness_handoff tool's queue
    // entry (more reliable than regex on free text), fall back to the
    // text-parsed [HANDOFF:] directive embedded in the response.
    const stepSessionKey = getProjectSessionKey(channelId, result.agentName);
    const queuedNext = dequeueHandoff(stepSessionKey);
    const nextHandoff = queuedNext ?? result.nextHandoff;

    // Post the responding agent's non-handoff text
    try {
      if (nextHandoff) {
        if (nextHandoff.preHandoffText) {
          await sink.postPreHandoffText(result.agentName, nextHandoff.preHandoffText);
        }
      } else {
        // No further handoff — post full response
        await sink.postAgentResponse(result.agentName, result.response);
      }
    } catch (err: any) {
      console.error(`[HANDOFF] Failed to post chain response for ${result.agentName}: ${err.message}`);
      // Try to notify the user that delivery failed
      try {
        await sink.postDeliveryFailure(result.agentName, err.message);
      } catch {}
    }

    fromAgent = result.agentName;
    handoff = nextHandoff;
  }

  // --- Post-Chain Gates (deterministic) ---
  // Each gate for the final agent runs in sequence if it hasn't already participated
  // AND is in the project's agents list.
  const finalAgent = chainEntries[chainEntries.length - 1]?.agent;
  const project = finalAgent ? getProject(channelId) : null;
  const gateRequests = buildPostChainGateRequests(chainEntries, project?.agents);

  if (gateRequests.length > 0) {
    for (const gateRequest of gateRequests) {
      const gatePrompt = gateRequest.prompt;

      await sink.postGateNotice(gateRequest.fromAgent, gateRequest.gateAgent);

      const gateResult = await executor.execute({
        fromAgent: gateRequest.fromAgent,
        toAgent: gateRequest.gateAgent,
        handoffMessage: gatePrompt,
        preHandoffText: "", // no pre-handoff text
        chainContext: undefined,
        worktreePath: chainWorktreePath,
        // Gate agents (reviewer, tester) are stateless verifiers — skip
        // session resume so accumulated session IDs from prior chain runs
        // can't trigger "No conversation found" failures. See ERR-20260426-036.
        skipSessionResume: true,
      });

      if (gateResult) {
        chainEntries.push({
          agent: gateResult.agentName,
          response: gateResult.response.slice(0, 2000),
          timestamp: Date.now(),
          artifacts: captureArtifacts(chainWorktreePath),
        });

        try {
          await sink.postGateResponse(gateResult.agentName, gateResult.response);
        } catch (err: any) {
          console.error(`[HANDOFF] Failed to post gate output: ${err.message}`);
        }
      }
    }
  }

  // Merge and clean up worktree if one was created.
  // Auto-commit any uncommitted edits first — Codex `workspace-write` sandbox
  // protects `.git` as read-only, so chain agents (especially Codex builders)
  // typically can't run `git commit` themselves. The chain process here has
  // full filesystem permissions. See LRN-20260426-054 + ERR-20260426-037.
  if (chainWorktreeId) {
    const commitResult = commitWorktreeIfDirty(chainWorktreeId, {
      message: `chain: changes from ${chainId}`,
    });
    if (commitResult.committed) {
      console.log(`[HANDOFF] Auto-committed worktree changes for chain ${chainId}: ${commitResult.sha?.slice(0, 8) ?? "(no sha)"}`);
    } else if (commitResult.error) {
      console.warn(`[HANDOFF] Auto-commit skipped for chain ${chainId}: ${commitResult.error}`);
    }

    const mergeResult = mergeWorktree(chainWorktreeId);
    console.log(`[HANDOFF] Worktree merge for chain ${chainId}: ${mergeResult.status} — ${mergeResult.details}`);
    removeWorktree(chainWorktreeId);
  }

  return { entries: chainEntries, originAgent };
}

export async function runHandoffChain(
  channel: TextChannel,
  initialAgent: string,
  initialResponse: string,
  options?: { originAgent?: string; initialHandoff?: HandoffDirective }
): Promise<ChainResult> {
  const originAgent = options?.originAgent || initialAgent;
  const sink = new DiscordSink(channel);
  const executor = new DiscordAgentExecutor(channel);
  return executeChainCore({
    channelId: channel.id,
    sink,
    executor,
    initialAgent,
    initialResponse,
    originAgent,
    initialHandoff: options?.initialHandoff,
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
