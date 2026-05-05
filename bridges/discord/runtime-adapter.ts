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
};

// ─── Codex Adapter ──────────────────────────────────────────────────────

const codexAdapter: RuntimeAdapter = {
  tag: "codex",

  capabilities: {
    // Codex doesn't emit Claude's `[CONTINUE]` directive shape and the
    // step_count machinery in task-runner predates Codex.
    continuation: false,
    // Loop detection parses Claude's tool_use event shape from stream-json.
    // Codex's JSONL shape is different; loop detection has not been ported.
    loopDetection: false,
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
};

registerAdapter(claudeAdapter);
registerAdapter(codexAdapter);
