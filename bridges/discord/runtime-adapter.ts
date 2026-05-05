/**
 * Runtime Adapter
 *
 * Single dispatch point for runtime asymmetries (Claude vs Codex). Hides
 * `if (runtime === "codex")` branching at call sites. Each adapter wraps
 * the runtime-specific config builder, response/session extractor, and
 * telemetry recorder. New runtimes register a new adapter; call sites
 * stay unchanged.
 *
 * The two future-proofing concessions for non-process drivers (e.g. local
 * models via HTTP) are intentional and minimal:
 *
 * 1. SpawnArgs models the runner command line, not a child process. Local
 *    drivers can spawn via the same shape or substitute their own runner.
 * 2. Capability flags (`continuation`, `loopDetection`, …) replace string
 *    checks. Adapters declare what they support; call sites query.
 *
 * The deeper local-model concerns (MCP shim, tool-call shape, statelessness,
 * sandbox) are deliberately NOT modeled here — they belong to a layer below
 * a future local adapter, not to this dispatch surface.
 *
 * Adapter implementations are inlined in this file rather than split into
 * separate modules to avoid ESM circular-import temporal-dead-zone issues
 * that arose from `runtime-adapter.ts → adapters → runtime-adapter.ts`
 * during module body initialization. Splitting becomes worth it if the
 * adapter count grows past 3–4.
 */

import { writeFileSync } from "fs";
import type { AgentRuntime } from "./agent-loader.js";
import {
  buildClaudeConfig,
  extractResponse as extractClaudeResponse,
  extractSessionId as extractClaudeSessionId,
} from "./claude-config.js";
import {
  buildCodexConfig,
  extractCodexResponse,
  extractCodexSessionId,
} from "./codex-config.js";
import { recordClaudeResult, recordCodexResult } from "./instance-monitor.js";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";

export interface BuildSpawnInput {
  channelId: string;
  prompt: string;
  agentName: string | null;
  taskId: string;
  outputFile: string;

  sessionKey: string | null;
  skipSessionResume?: boolean;

  streamDir?: string;
  timeoutSecs?: number;
  worktreePath?: string | null;

  // Claude-specific
  isContinuation?: boolean;
  extraSystemPrompts?: string[];

  // Codex-specific. Caller provides the path; adapter writes the prompt
  // file there. Caller owns cleanup. Required when runtime === "codex".
  promptFilePath?: string;
}

export interface SpawnArgs {
  pythonArgs: string[];
  cwd: string;
  env: Record<string, string>;
  promptFilePath: string | null;
}

/**
 * Shape of the JSON envelope written by claude-runner.py / codex-runner.py
 * to the output file. `stdout` is a JSONL stream-of-events string for both
 * runtimes. Codex also writes top-level `threadId` and `lastMessage`.
 */
export interface ParsedEnvelope {
  stdout: string;
  stderr?: string;
  returncode?: number;
  threadId?: string | null;
  lastMessage?: string | null;
  [key: string]: unknown;
}

export interface RuntimeCapabilities {
  /** Supports `[CONTINUE]` bounded-step continuation. */
  continuation: boolean;
  /** Tool-call repetition detection in stdout JSONL. */
  loopDetection: boolean;
  /** API failure tracker increments on transient stderr matches. */
  transientErrorRetry: boolean;
  /** Resume by stored session id (vs. always-fresh). */
  sessionResume: boolean;
}

export interface RuntimeAdapter {
  readonly tag: AgentRuntime;
  readonly capabilities: RuntimeCapabilities;

  /**
   * Build the python argv + env for one spawn. Pure with the exception of
   * Codex prompt-file writing (required by codex-runner.py's input model).
   */
  buildSpawnArgs(input: BuildSpawnInput): Promise<SpawnArgs>;

  /** Pull final agent text from a parsed runner envelope. */
  extractResponse(envelope: ParsedEnvelope): string | null;

  /** Pull session/thread id from a parsed runner envelope. */
  extractSessionId(envelope: ParsedEnvelope): string | null;

  /** Record per-spawn telemetry (tool counts, tokens) from envelope.stdout. */
  recordResult(taskId: string, envelope: ParsedEnvelope): void;

  /**
   * Parse tool-call signatures from envelope stdout for loop detection.
   * Returns one signature per tool invocation in deterministic order. Empty
   * array when stdout has no recognizable tool events. Adapters that set
   * `capabilities.loopDetection = false` may return [] unconditionally.
   */
  parseToolCallSignatures(envelope: ParsedEnvelope): string[];

  /**
   * Decide whether a non-zero-returncode envelope represents a stale stored
   * session id (one the upstream runtime no longer recognizes). When true,
   * task-runner clears the session and retries cold instead of treating the
   * spawn as a generic failure.
   */
  isStaleSessionError(envelope: ParsedEnvelope): boolean;
}

const adapters = new Map<AgentRuntime, RuntimeAdapter>();

export function registerAdapter(adapter: RuntimeAdapter): void {
  adapters.set(adapter.tag, adapter);
}

export function getAdapter(runtime: AgentRuntime): RuntimeAdapter {
  const adapter = adapters.get(runtime);
  if (!adapter) {
    throw new Error(
      `No RuntimeAdapter registered for runtime "${runtime}". ` +
        `Registered: ${[...adapters.keys()].join(", ") || "(none)"}.`,
    );
  }
  return adapter;
}

// ─── Claude Adapter ─────────────────────────────────────────────────────

const claudeAdapter: RuntimeAdapter = {
  tag: "claude",

  capabilities: {
    continuation: true,
    loopDetection: true,
    transientErrorRetry: true,
    sessionResume: true,
  },

  async buildSpawnArgs(input: BuildSpawnInput): Promise<SpawnArgs> {
    const config = await buildClaudeConfig({
      channelId: input.channelId,
      prompt: input.prompt,
      agentName: input.agentName,
      sessionKey: input.sessionKey,
      taskId: input.taskId,
      isContinuation: input.isContinuation,
      extraSystemPrompts: input.extraSystemPrompts,
      worktreePath: input.worktreePath ?? null,
      skipSessionResume: input.skipSessionResume,
    });

    const pythonArgs: string[] = [
      `${HARNESS_ROOT}/bridges/discord/claude-runner.py`,
      input.outputFile,
    ];
    if (input.streamDir) {
      pythonArgs.push("--stream-dir", input.streamDir);
    }
    if (typeof input.timeoutSecs === "number") {
      pythonArgs.push("--timeout", String(input.timeoutSecs));
    }
    pythonArgs.push(...config.args);

    return {
      pythonArgs,
      cwd: config.cwd,
      env: config.env,
      promptFilePath: null,
    };
  },

  extractResponse(envelope: ParsedEnvelope): string | null {
    return extractClaudeResponse(envelope.stdout);
  },

  extractSessionId(envelope: ParsedEnvelope): string | null {
    return extractClaudeSessionId(envelope.stdout);
  },

  recordResult(taskId: string, envelope: ParsedEnvelope): void {
    if (typeof envelope.stdout === "string") {
      recordClaudeResult(taskId, envelope.stdout);
    }
  },

  parseToolCallSignatures(envelope: ParsedEnvelope): string[] {
    const stdout = typeof envelope.stdout === "string" ? envelope.stdout : "";
    if (!stdout) return [];
    const signatures: string[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed);
        if (ev?.type === "tool_use" || ev?.type === "tool_result") {
          const name = ev.name || ev.tool || "unknown";
          const inputJson = JSON.stringify(ev.input || "").slice(0, 100);
          signatures.push(`${name}:${inputJson}`);
          continue;
        }
        // Claude CLI nests tool_use blocks inside assistant messages
        if (ev?.type === "assistant" && Array.isArray(ev?.message?.content)) {
          for (const block of ev.message.content) {
            if (block?.type === "tool_use" && block?.name) {
              const inputJson = JSON.stringify(block.input || "").slice(0, 100);
              signatures.push(`${block.name}:${inputJson}`);
            }
          }
        }
      } catch {}
    }
    return signatures;
  },

  isStaleSessionError(envelope: ParsedEnvelope): boolean {
    const stderr = typeof envelope.stderr === "string" ? envelope.stderr.toLowerCase() : "";
    if (!stderr) return false;
    return (
      stderr.includes("session") &&
      (stderr.includes("not found") || stderr.includes("expired"))
    );
  },
};

// ─── Codex Adapter ──────────────────────────────────────────────────────

const codexAdapter: RuntimeAdapter = {
  tag: "codex",

  capabilities: {
    // `[CONTINUE]` is a textual marker the agent prompt instructs the model
    // to emit when more work remains. Both runtimes can produce it; Codex
    // also supports `codex exec resume <thread-id>` so step 2 picks up where
    // step 1 left off (parity with Claude's `--resume`).
    continuation: true,
    // Codex's JSONL stream uses `item.completed` events with mcp_tool_call /
    // command_execution shapes. parseToolCallSignatures() handles both.
    loopDetection: true,
    // codex-runner.py has its own retry-with-backoff for 429/5xx; the
    // tracker drives the bot-level cooldown. Wired symmetrically.
    transientErrorRetry: true,
    // `codex exec resume <session-id>` works (with the narrow flag set
    // documented in cbbf8f3 / ERR-codex-exec-resume-sandbox-flag-rejected).
    sessionResume: true,
  },

  async buildSpawnArgs(input: BuildSpawnInput): Promise<SpawnArgs> {
    if (!input.promptFilePath) {
      throw new Error(
        "codex adapter requires `promptFilePath` — codex-runner.py reads " +
          "the prompt from a file, not stdin/argv. Caller must provide one " +
          "and clean it up after spawn.",
      );
    }

    const config = await buildCodexConfig({
      channelId: input.channelId,
      prompt: input.prompt,
      agentName: input.agentName,
      sessionKey: input.sessionKey,
      taskId: input.taskId,
      extraSystemPrompts: input.extraSystemPrompts,
      worktreePath: input.worktreePath ?? null,
      outputFile: input.outputFile,
      streamDir: input.streamDir,
      skipSessionResume: input.skipSessionResume,
      isContinuation: input.isContinuation,
    });

    writeFileSync(input.promptFilePath, config.prompt, "utf-8");

    const pythonArgs: string[] = [
      `${HARNESS_ROOT}/bridges/discord/codex-runner.py`,
      input.outputFile,
    ];
    if (input.streamDir) {
      pythonArgs.push("--stream-dir", input.streamDir);
    }
    if (typeof input.timeoutSecs === "number") {
      pythonArgs.push("--timeout", String(input.timeoutSecs));
    }
    pythonArgs.push("--prompt-file", input.promptFilePath, ...config.runnerArgs);

    return {
      pythonArgs,
      cwd: config.cwd,
      env: config.env,
      promptFilePath: input.promptFilePath,
    };
  },

  extractResponse(envelope: ParsedEnvelope): string | null {
    return extractCodexResponse(envelope);
  },

  extractSessionId(envelope: ParsedEnvelope): string | null {
    return extractCodexSessionId(envelope);
  },

  recordResult(taskId: string, envelope: ParsedEnvelope): void {
    if (typeof envelope.stdout === "string") {
      recordCodexResult(taskId, envelope.stdout);
    }
  },

  parseToolCallSignatures(envelope: ParsedEnvelope): string[] {
    const stdout = typeof envelope.stdout === "string" ? envelope.stdout : "";
    if (!stdout) return [];
    const signatures: string[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed);
        if (ev?.type !== "item.completed") continue;
        const item = ev.item;
        if (!item || typeof item !== "object") continue;
        const itemType = String(item.type || "");
        if (itemType === "mcp_tool_call") {
          const name = `mcp__${item.server || "unknown"}__${item.tool || "unknown"}`;
          const args = item.arguments && typeof item.arguments === "object" ? item.arguments : {};
          signatures.push(`${name}:${JSON.stringify(args).slice(0, 100)}`);
        } else if (itemType === "command_execution") {
          const command = String(item.command || "");
          signatures.push(`Bash:${JSON.stringify({ command }).slice(0, 100)}`);
        }
      } catch {}
    }
    return signatures;
  },

  isStaleSessionError(envelope: ParsedEnvelope): boolean {
    const stderr = typeof envelope.stderr === "string" ? envelope.stderr.toLowerCase() : "";
    if (!stderr) return false;
    // Codex CLI's exact stderr text for an unknown thread/session is not
    // documented in the codebase yet. Match permissively across the three
    // identifier nouns Codex uses (thread/session/conversation) crossed with
    // the standard "missing/invalid" lexicon. False positives only cost one
    // extra cold-start retry; false negatives leave a stale id wedging the
    // session forever, which is the worse failure mode.
    const subject = ["thread", "session", "conversation"].some((s) => stderr.includes(s));
    const verb = [
      "not found",
      "does not exist",
      "no such",
      "unknown",
      "invalid",
      "expired",
    ].some((s) => stderr.includes(s));
    return subject && verb;
  },
};

registerAdapter(claudeAdapter);
registerAdapter(codexAdapter);
