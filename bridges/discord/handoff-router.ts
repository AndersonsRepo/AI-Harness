import { TextChannel, Message } from "discord.js";
import { spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, mkdirSync, readdirSync } from "fs";
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
import { FileWatcher, trackWatcher, untrackWatcher } from "./file-watcher.js";
import { monitor } from "./truncation-monitor.js";
import { needsWorktree, createWorktree, mergeWorktree, removeWorktree, isGitRepo } from "./worktree-manager.js";
import {
  HARNESS_ROOT,
  extractResponse,
  extractSessionId,
  buildClaudeConfig,
} from "./claude-config.js";

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
}

export interface ChainResult {
  entries: ChainEntry[];
  originAgent: string;
  parallelGroupId?: string; // Set when chain is suspended for parallel execution
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

function gatePromptFor(gateAgent: string, fromAgent: string, previousOutput: string): string {
  if (gateAgent === "reviewer") {
    return `Review the following ${fromAgent} output for quality, correctness, and potential issues:\n\n${previousOutput}`;
  }
  if (gateAgent === "tester") {
    return `Verify that the following ${fromAgent} changes actually run and behave correctly. Pick the minimum viable verification strategy based on the scope of the change, execute it, and report PASS/FAIL with concrete evidence.\n\nChange summary:\n\n${previousOutput}`;
  }
  return `Process the following ${fromAgent} output:\n\n${previousOutput}`;
}

export interface PostChainGateRequest {
  gateAgent: string;
  fromAgent: string;
  artifact: string;
  prompt: string;
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
      artifact: finalEntry.response,
      prompt: gatePromptFor(gateAgent, finalEntry.agent, finalEntry.response),
    }));
}

export interface HandoffResult {
  agentName: string;
  response: string;
  nextHandoff: HandoffDirective | null;
}

export async function executeHandoff(
  channel: TextChannel,
  fromAgent: string,
  toAgent: string,
  handoffMessage: string,
  preHandoffText: string,
  chainContext?: { completedPhases: ChainEntry[]; currentTask: string },
  worktreePath?: string | null,
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

  // Post the originating agent's message to the channel
  try {
    if (preHandoffText) {
      const chunks = monitor.splitForDiscord(`**${capitalize(fromAgent)}:** ${preHandoffText}`, 1900, "handoff:pre-text");
      for (const chunk of chunks) await channel.send(chunk);
    }
    await channel.send(
      `*${capitalize(fromAgent)} → ${capitalize(toAgent)}:* ${handoffMessage.slice(0, 500)}`
    );
  } catch (err: any) {
    console.error(`[HANDOFF] Failed to post pre-handoff text: ${err.message}`);
  }

  // Update active agent
  updateProject(channel.id, { activeAgent: toAgent });

  // Build context and spawn target agent
  const context = await buildProjectContext(channel, toAgent, project, chainContext);
  const prompt = `${context}\n\n${capitalize(fromAgent)} has handed off to you with this request:\n${handoffMessage}`;

  // Build shared config
  const sessionKey = getProjectSessionKey(channel.id, toAgent);
  const config = await buildClaudeConfig({
    channelId: channel.id,
    prompt,
    agentName: toAgent,
    sessionKey,
    taskId: "handoff",
    worktreePath,
  });

  const outputFile = join(
    TEMP_DIR,
    `handoff-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );

  const pythonArgs = [
    `${HARNESS_ROOT}/bridges/discord/claude-runner.py`,
    outputFile,
    "--timeout",
    "180",
    ...config.args,
  ];

  return new Promise((resolve) => {
    const childProc = spawn("python3", pythonArgs, {
      cwd: config.cwd,
      env: config.env,
      detached: true,
      stdio: "ignore",
    });
    childProc.unref();

    // Show typing
    channel.sendTyping().catch(() => {});

    // Use FileWatcher instead of polling
    const watcher = new FileWatcher({
      filePath: outputFile,
      onFile: async (content: string) => {
        untrackWatcher(watcher);

        try {
          // Clean up
          if (existsSync(outputFile)) {
            unlinkSync(outputFile);
          }

          const result = JSON.parse(content);
          const { stdout, stderr, returncode } = result;

          if (returncode !== 0) {
            const errorMsg = stderr?.trim() || `Agent exited with code ${returncode}`;
            await channel.send(
              `**${capitalize(toAgent)}:** Something went wrong:\n\`\`\`\n${errorMsg.slice(0, 500)}\n\`\`\``
            ).catch((err) => console.error(`[HANDOFF] Failed to send error notice: ${err.message}`));
            resolve(null);
            return;
          }

          const responseText = extractResponse(stdout);
          const sessionId = extractSessionId(stdout);

          if (sessionId) {
            setSession(sessionKey, sessionId);
          }

          if (!responseText) {
            await channel.send(
              `**${capitalize(toAgent)}:** Got a response but couldn't parse it.`
            ).catch((err) => console.error(`[HANDOFF] Failed to send parse-error notice: ${err.message}`));
            resolve(null);
            return;
          }

          // Check if this agent's output contains another handoff
          const nextHandoff = parseHandoff(responseText);

          resolve({
            agentName: toAgent,
            response: responseText,
            nextHandoff,
          });
        } catch (err: any) {
          console.error(`[HANDOFF] Error reading output: ${err.message}`);
          resolve(null);
        }
      },
      onTimeout: async () => {
        untrackWatcher(watcher);
        await channel.send(
          `**${capitalize(toAgent)}:** Timed out after 3 minutes.`
        ).catch((err) => console.error(`[HANDOFF] Failed to send timeout notice: ${err.message}`));
        resolve(null);
      },
      timeoutMs: 180_000,
      fallbackPollMs: 2000,
      retryReadMs: 100,
    });
    trackWatcher(watcher);
    watcher.start();

    // Keep typing indicator alive
    const typingInterval = setInterval(() => {
      if (watcher.isStopped()) {
        clearInterval(typingInterval);
        return;
      }
      channel.sendTyping().catch(() => {});
    }, 8000);
  });
}

export async function runHandoffChain(
  channel: TextChannel,
  initialAgent: string,
  initialResponse: string,
  options?: { originAgent?: string }
): Promise<ChainResult> {
  const chainEntries: ChainEntry[] = [];
  const originAgent = options?.originAgent || initialAgent;

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
        channelId: channel.id,
        directive: parallelDirective,
      });
      // Chain suspends — will resume when parallel tasks complete via [PARALLEL_COMPLETE]
      return { entries: chainEntries, originAgent, parallelGroupId: groupId };
    } catch (err: any) {
      console.error(`[HANDOFF] Failed to spawn parallel group: ${err.message}`);
      await channel.send(`*Failed to start parallel tasks: ${err.message}*`).catch(() => {});
    }
  }

  let handoff = parseHandoff(initialResponse);
  let fromAgent = initialAgent;

  // Lazy worktree creation — created on first handoff to a writer agent
  const chainId = `chain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let chainWorktreePath: string | null = null;
  let chainWorktreeId: string | null = null;

  while (handoff) {
    // Create worktree lazily on first handoff to a writer
    if (!chainWorktreePath && needsWorktree([handoff.targetAgent])) {
      const project = getProject(channel.id);
      const projectCwd = project ? resolveProjectWorkdir(project.name) : null;
      if (projectCwd && isGitRepo(projectCwd)) {
        const wt = createWorktree(projectCwd, project!.name, chainId, channel.id, { chainId });
        if (wt) {
          chainWorktreePath = wt.worktree_path;
          chainWorktreeId = wt.id;
          console.log(`[HANDOFF] Worktree created for chain ${chainId}: ${chainWorktreePath}`);
        }
      }
    }

    const result = await executeHandoff(
      channel,
      fromAgent,
      handoff.targetAgent,
      handoff.message,
      handoff.preHandoffText,
      { completedPhases: chainEntries, currentTask: handoff.message },
      chainWorktreePath,
    );

    if (!result) break; // Chain ended (error, depth limit, or invalid agent)

    // Record this agent's response in the chain log
    chainEntries.push({
      agent: result.agentName,
      response: result.response.slice(0, 2000),
      timestamp: Date.now(),
    });

    // Post the responding agent's non-handoff text
    try {
      if (result.nextHandoff) {
        if (result.nextHandoff.preHandoffText) {
          const chunks = monitor.splitForDiscord(
            `**${capitalize(result.agentName)}:** ${result.nextHandoff.preHandoffText}`, 1900, "handoff:chain-pre-text"
          );
          for (const chunk of chunks) await channel.send(chunk);
        }
      } else {
        // No further handoff — post full response
        const chunks = monitor.splitForDiscord(
          `**${capitalize(result.agentName)}:** ${result.response}`, 1900, "handoff:response"
        );
        for (const chunk of chunks) await channel.send(chunk);
      }
    } catch (err: any) {
      console.error(`[HANDOFF] Failed to post chain response for ${result.agentName}: ${err.message}`);
      // Try to notify the user that delivery failed
      try {
        await channel.send(`*Failed to deliver ${result.agentName}'s response (${err.message}). The agent completed but the message couldn't be posted.*`).catch(() => {});
      } catch {}
    }

    fromAgent = result.agentName;
    handoff = result.nextHandoff;
  }

  // --- Post-Chain Gates (deterministic) ---
  // Each gate for the final agent runs in sequence if it hasn't already participated
  // AND is in the project's agents list.
  const finalAgent = chainEntries[chainEntries.length - 1]?.agent;
  const project = finalAgent ? getProject(channel.id) : null;
  const gateRequests = buildPostChainGateRequests(chainEntries, project?.agents);

  if (gateRequests.length > 0) {
    for (const gateRequest of gateRequests) {
      const gatePrompt = gateRequest.prompt;

      await channel.send(`*Auto-gate: ${capitalize(gateRequest.fromAgent)} output → ${capitalize(gateRequest.gateAgent)}*`)
        .catch((err) => console.error(`[HANDOFF] Failed to send gate notice: ${err.message}`));

      const gateResult = await executeHandoff(
        channel,
        gateRequest.fromAgent,
        gateRequest.gateAgent,
        gatePrompt,
        "", // no pre-handoff text
        undefined,
        chainWorktreePath,
      );

      if (gateResult) {
        chainEntries.push({
          agent: gateResult.agentName,
          response: gateResult.response.slice(0, 2000),
          timestamp: Date.now(),
        });

        try {
          const chunks = monitor.splitForDiscord(
            `**${capitalize(gateResult.agentName)}:** ${gateResult.response}`, 1900, `handoff:gate-${gateRequest.gateAgent}`
          );
          for (const chunk of chunks) await channel.send(chunk);
        } catch (err: any) {
          console.error(`[HANDOFF] Failed to post gate output: ${err.message}`);
        }
      }
    }
  }

  // Merge and clean up worktree if one was created
  if (chainWorktreeId) {
    const mergeResult = mergeWorktree(chainWorktreeId);
    console.log(`[HANDOFF] Worktree merge for chain ${chainId}: ${mergeResult.status} — ${mergeResult.details}`);
    removeWorktree(chainWorktreeId);
  }

  return { entries: chainEntries, originAgent };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
