import { TextChannel, Message } from "discord.js";
import { spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import {
  getProject,
  updateProject,
  incrementHandoffDepth,
  resetHandoffDepth,
} from "./project-manager.js";
import { getSession, setSession } from "./session-store.js";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const TEMP_DIR = join(HARNESS_ROOT, "bridges", "discord", ".tmp");
const MAX_CONTEXT_MESSAGES = 15;
const MAX_MSG_LENGTH = 500;

// Global safety guardrails
const GLOBAL_DISALLOWED_TOOLS = [
  "Bash(rm -rf:*)",
  "Bash(git push --force:*)",
  "Bash(git reset --hard:*)",
  "Bash(DROP:*)",
  "Bash(DELETE FROM:*)",
  "Bash(kill -9:*)",
].join(",");

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
  // Match [HANDOFF:agent_name] message (case-insensitive, optional whitespace)
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
  project: { name: string; description: string; agents: string[] }
): Promise<string> {
  const messages = await channel.messages.fetch({ limit: MAX_CONTEXT_MESSAGES });
  const sorted = [...messages.values()].reverse(); // Oldest first

  const contextLines: string[] = [
    `[Project: ${project.name}]`,
    `Description: ${project.description}`,
    `Participating agents: ${project.agents.join(", ")}`,
    `You are the ${agentName} agent.`,
    "",
    "--- Recent conversation ---",
  ];

  for (const msg of sorted) {
    const author = msg.author.bot ? extractAgentName(msg.content) : msg.author.username;
    const content =
      msg.content.length > MAX_MSG_LENGTH
        ? msg.content.slice(0, MAX_MSG_LENGTH) + "..."
        : msg.content;
    const timeAgo = getTimeAgo(msg.createdTimestamp);
    contextLines.push(`${author} (${timeAgo}): ${content}`);
  }

  contextLines.push(
    "",
    "--- End of conversation ---",
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

// Extract response from Claude JSON output (same logic as bot.ts)
function extractResponse(output: string): string | null {
  try {
    const jsonStart = output.indexOf('{"type"');
    if (jsonStart !== -1) {
      const jsonEnd = output.lastIndexOf("}") + 1;
      const parsed = JSON.parse(output.slice(jsonStart, jsonEnd));
      if (parsed.is_error) return `Error: ${parsed.result || "Unknown error"}`;
      const text = parsed.result || parsed.text || parsed.content;
      return text ? text.trim() : null;
    }
  } catch {}
  const match = output.match(/"result"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (match) {
    return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
  }
  return null;
}

function extractSessionId(output: string): string | null {
  const match = output.match(/"session_id"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function readAgentPrompt(name: string): string | null {
  const agentFile = join(HARNESS_ROOT, ".claude", "agents", `${name}.md`);
  if (!existsSync(agentFile)) return null;
  return readFileSync(agentFile, "utf-8");
}

export function getProjectSessionKey(
  channelId: string,
  agentName: string
): string {
  return `${channelId}:${agentName}`;
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
  preHandoffText: string
): Promise<HandoffResult | null> {
  const project = getProject(channel.id);
  if (!project) return null;

  // Check if target agent is valid
  if (!project.agents.includes(toAgent)) {
    await channel.send(
      `**System:** Agent \`${toAgent}\` is not assigned to this project. Available: ${project.agents.join(", ")}`
    );
    return null;
  }

  // Self-handoff prevention
  if (fromAgent === toAgent) {
    await channel.send(
      `**System:** ${fromAgent} tried to hand off to itself. Skipping.`
    );
    return null;
  }

  // Depth check
  const depth = incrementHandoffDepth(channel.id);
  const maxDepth = project.maxHandoffDepth || 5;

  if (depth > maxDepth) {
    await channel.send(
      `**Handoff limit reached (${maxDepth}).** The agents have been collaborating for a while.\n\nLast handoff: ${fromAgent} → ${toAgent}: "${handoffMessage.slice(0, 200)}"\n\nPlease direct the next step or type a message to continue.`
    );
    resetHandoffDepth(channel.id);
    return null;
  }

  // Post the originating agent's message to the channel
  if (preHandoffText) {
    await channel.send(`**${capitalize(fromAgent)}:** ${preHandoffText.slice(0, 1900)}`);
  }
  await channel.send(
    `*${capitalize(fromAgent)} → ${capitalize(toAgent)}:* ${handoffMessage.slice(0, 500)}`
  );

  // Update active agent
  updateProject(channel.id, { activeAgent: toAgent });

  // Build context and spawn target agent
  const context = await buildProjectContext(channel, toAgent, project);
  const prompt = `${context}\n\n${capitalize(fromAgent)} has handed off to you with this request:\n${handoffMessage}`;

  // Build claude args
  const args = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];

  // Agent personality
  const agentPrompt = readAgentPrompt(toAgent);
  if (agentPrompt) {
    args.push("--append-system-prompt", agentPrompt);
  }

  // Safety guardrails
  args.push("--disallowedTools", GLOBAL_DISALLOWED_TOOLS);

  // Session resume with compound key
  const sessionKey = getProjectSessionKey(channel.id, toAgent);
  const existingSession = getSession(sessionKey);
  if (existingSession) {
    args.push("--resume", existingSession);
  }

  args.push("--", prompt);

  const outputFile = join(
    TEMP_DIR,
    `handoff-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );

  const pythonArgs = [
    `${HARNESS_ROOT}/bridges/discord/claude-runner.py`,
    outputFile,
    "--timeout",
    "180",
    ...args,
  ];

  return new Promise((resolve) => {
    const proc = spawn("python3", pythonArgs, {
      cwd: HARNESS_ROOT,
      env: { ...process.env, HARNESS_ROOT },
      detached: true,
      stdio: "ignore",
    });
    proc.unref();

    // Show typing
    channel.sendTyping().catch(() => {});

    const startTime = Date.now();
    const TIMEOUT = 180_000;
    const POLL_INTERVAL = 1_000;

    const poll = async (): Promise<void> => {
      channel.sendTyping().catch(() => {});

      if (existsSync(outputFile)) {
        try {
          const raw = readFileSync(outputFile, "utf-8");
          unlinkSync(outputFile);

          const result = JSON.parse(raw);
          const { stdout, stderr, returncode } = result;

          if (returncode !== 0) {
            const errorMsg = stderr?.trim() || `Agent exited with code ${returncode}`;
            await channel.send(
              `**${capitalize(toAgent)}:** Something went wrong:\n\`\`\`\n${errorMsg.slice(0, 500)}\n\`\`\``
            );
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
            );
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
        return;
      }

      if (Date.now() - startTime > TIMEOUT) {
        await channel.send(
          `**${capitalize(toAgent)}:** Timed out after 3 minutes.`
        );
        resolve(null);
        return;
      }

      setTimeout(poll, POLL_INTERVAL);
    };

    setTimeout(poll, POLL_INTERVAL);
  });
}

export async function runHandoffChain(
  channel: TextChannel,
  initialAgent: string,
  initialResponse: string
): Promise<void> {
  let handoff = parseHandoff(initialResponse);
  let fromAgent = initialAgent;

  while (handoff) {
    const result = await executeHandoff(
      channel,
      fromAgent,
      handoff.targetAgent,
      handoff.message,
      handoff.preHandoffText
    );

    if (!result) break; // Chain ended (error, depth limit, or invalid agent)

    // Post the responding agent's non-handoff text
    if (result.nextHandoff) {
      if (result.nextHandoff.preHandoffText) {
        await channel.send(
          `**${capitalize(result.agentName)}:** ${result.nextHandoff.preHandoffText.slice(0, 1900)}`
        );
      }
    } else {
      // No further handoff — post full response
      await channel.send(
        `**${capitalize(result.agentName)}:** ${result.response.slice(0, 1900)}`
      );
    }

    fromAgent = result.agentName;
    handoff = result.nextHandoff;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
