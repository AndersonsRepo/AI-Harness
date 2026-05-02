/**
 * Instance Monitor — Real-time tracking of running Claude instances.
 *
 * Maintains an in-memory registry of all active Claude processes with:
 * - Tool call history with full arguments and timing
 * - Accumulated assistant output
 * - Resource estimates (tokens, cost)
 * - Intervention state (hold continuation, inject guidance)
 *
 * Data flows: StreamPoller events → processMonitorEvent → registry update → UI callback
 * Persistence: summary written to task_telemetry on completion (see db.ts v3)
 */

export interface ToolCallEvent {
  timestamp: number;
  toolName: string;
  toolInput: Record<string, unknown>;
  displaySummary: string;
  durationMs?: number;
  resultPreview?: string;
}

export interface MonitoredInstance {
  taskId: string;
  channelId: string;
  agent: string;
  runtime: "claude" | "codex";
  prompt: string;
  startedAt: number;
  pid: number;
  status: "running" | "paused_continue" | "completed" | "killed" | "failed";

  // Real-time state
  toolCalls: ToolCallEvent[];
  currentTool: ToolCallEvent | null;
  assistantText: string;
  thinkingText: string;
  lastActivityAt: number;

  // Resource tracking
  chunkCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  // Subset of estimatedInputTokens that hit the prompt cache. Codex reports
  // this in turn.completed.usage.cached_input_tokens; Claude path leaves it 0
  // (cache-cost capture for Claude is a separate follow-up).
  cachedInputTokens: number;

  // Discord state
  monitorMessageId: string | null;
  monitorThreadId: string | null;
  lastPostedThinkingLen: number;

  // Intervention state
  holdContinuation: boolean;
  interventionNote: string | null;
}

export interface MonitorEvent {
  type: string;
  content?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  result?: string;
  is_error?: boolean;
  // Content blocks from assistant messages
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
      id?: string;
    }>;
  };
}

// Max tool calls to keep in memory per instance
const MAX_TOOL_HISTORY = 100;

// Registry
const instances = new Map<string, MonitoredInstance>();

// UI update callback — set by monitor-ui.ts
let onUpdateCallback: ((instance: MonitoredInstance) => void) | null = null;
let onCompleteCallback: ((instance: MonitoredInstance) => void) | null = null;

export function setMonitorUpdateCallback(cb: (instance: MonitoredInstance) => void): void {
  onUpdateCallback = cb;
}

export function setMonitorCompletionCallback(cb: (instance: MonitoredInstance) => void): void {
  onCompleteCallback = cb;
}

// ─── Registry CRUD ───────────────────────────────────────────────────

export function registerInstance(config: {
  taskId: string;
  channelId: string;
  agent: string;
  runtime?: "claude" | "codex";
  prompt: string;
  pid: number;
}): MonitoredInstance {
  const instance: MonitoredInstance = {
    taskId: config.taskId,
    channelId: config.channelId,
    agent: config.agent,
    runtime: config.runtime || "claude",
    prompt: config.prompt.slice(0, 500),
    startedAt: Date.now(),
    pid: config.pid,
    status: "running",

    toolCalls: [],
    currentTool: null,
    assistantText: "",
    thinkingText: "",
    lastActivityAt: Date.now(),

    chunkCount: 0,
    estimatedInputTokens: Math.round(config.prompt.length / 4) + 2000,
    estimatedOutputTokens: 0,
    cachedInputTokens: 0,

    monitorMessageId: null,
    monitorThreadId: null,
    lastPostedThinkingLen: 0,

    holdContinuation: false,
    interventionNote: null,
  };

  instances.set(config.taskId, instance);
  console.log(`[MONITOR] Registered instance ${config.taskId} (${config.agent}) PID ${config.pid}`);

  if (onUpdateCallback) onUpdateCallback(instance);
  return instance;
}

export function unregisterInstance(taskId: string): MonitoredInstance | null {
  const instance = instances.get(taskId);
  if (!instance) return null;
  instances.delete(taskId);
  console.log(`[MONITOR] Unregistered instance ${taskId}`);
  return instance;
}

export function finalizeInstance(
  taskId: string,
  status: MonitoredInstance["status"],
): MonitoredInstance | null {
  const instance = unregisterInstance(taskId);
  if (!instance) return null;
  instance.status = status;
  if (onCompleteCallback) onCompleteCallback(instance);
  return instance;
}

export function getInstance(taskId: string): MonitoredInstance | null {
  return instances.get(taskId) || null;
}

export function getInstances(): MonitoredInstance[] {
  return Array.from(instances.values());
}

export function getActiveCount(): number {
  return instances.size;
}

// ─── Event Processing ────────────────────────────────────────────────

function formatToolSummary(toolName: string, input?: Record<string, unknown>): string {
  if (!input) return toolName;

  switch (toolName) {
    case "Bash":
      return `Bash: ${(input.command as string || "").slice(0, 120)}`;
    case "Read":
      return `Read: ${(input.file_path as string || "file")}`;
    case "Edit":
      return `Edit: ${(input.file_path as string || "file")}`;
    case "Write":
      return `Write: ${(input.file_path as string || "file")}`;
    case "Grep":
      return `Grep: "${(input.pattern as string || "")}" in ${(input.path as string || ".")}`;
    case "Glob":
      return `Glob: ${(input.pattern as string || "*")}`;
    case "WebFetch":
      return `WebFetch: ${(input.url as string || "url")}`;
    case "WebSearch":
      return `WebSearch: "${(input.query as string || "")}"`;
    default:
      if (toolName.startsWith("mcp__")) {
        const parts = toolName.split("__");
        return `MCP ${parts[1]}: ${parts[2] || toolName}`;
      }
      return toolName;
  }
}

export function processMonitorEvent(taskId: string, event: MonitorEvent): void {
  const instance = instances.get(taskId);
  if (!instance) return;

  instance.chunkCount++;
  instance.lastActivityAt = Date.now();

  // Debug: log event types being processed (except system/rate_limit which are noise)
  if (event.type !== "system" && event.type !== "rate_limit_event") {
    const toolInfo = event.message?.content?.find((b: any) => b.type === "tool_use");
    if (toolInfo) {
      console.log(`[MONITOR] Event ${event.type} for ${taskId}: tool_use ${(toolInfo as any).name}`);
    }
  }

  switch (event.type) {
    case "assistant": {
      // Claude CLI stream-json nests tool calls inside assistant message content blocks
      if (event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "thinking" && block.text) {
            // Capture thinking/reasoning — keep last 500 chars for display
            instance.thinkingText = block.text.slice(-500);
          } else if (block.type === "text" && block.text) {
            instance.assistantText += block.text;
            instance.estimatedOutputTokens = Math.round(instance.assistantText.length / 4);
            // Use visible text as "thinking" preview since thinking blocks aren't in stream-json
            instance.thinkingText = block.text.slice(-500);
          } else if (block.type === "tool_use" && block.name) {
            // Tool call inside assistant message — this is the primary format
            handleToolUse(instance, block.name, block.input || {});
          } else if (block.type === "tool_result") {
            // Tool result inside assistant message
            handleToolResult(instance, (block as any).output || (block as any).content || "");
          }
        }
      }
      // Fallback: raw content field (older format)
      if (event.content) {
        instance.assistantText += event.content;
        instance.estimatedOutputTokens = Math.round(instance.assistantText.length / 4);
      }
      break;
    }

    // Top-level tool events (may appear in some output formats)
    case "tool_use": {
      const toolName = event.tool_name || (event as any).name || "unknown";
      const toolInput = event.tool_input || (event as any).input || {};
      handleToolUse(instance, toolName, toolInput);
      break;
    }

    case "tool_result": {
      handleToolResult(instance, (event as any).output || (event as any).content || event.result || "");
      break;
    }

    // Tool results arrive inside "user" messages (Claude CLI format)
    case "user": {
      if (event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "tool_result") {
            handleToolResult(instance, (block as any).output || (block as any).content || "");
          }
        }
      }
      break;
    }

    case "result": {
      instance.status = event.is_error ? "failed" : "completed";
      if (instance.currentTool) {
        instance.currentTool.durationMs = Date.now() - instance.currentTool.timestamp;
        pushToolCall(instance, instance.currentTool);
        instance.currentTool = null;
      }
      break;
    }
  }

  if (onUpdateCallback) onUpdateCallback(instance);
}

function handleToolUse(instance: MonitoredInstance, toolName: string, toolInput: Record<string, unknown>): void {
  // Close any pending tool call
  if (instance.currentTool) {
    instance.currentTool.durationMs = Date.now() - instance.currentTool.timestamp;
    pushToolCall(instance, instance.currentTool);
  }

  instance.currentTool = {
    timestamp: Date.now(),
    toolName,
    toolInput,
    displaySummary: formatToolSummary(toolName, toolInput),
  };
}

function handleToolResult(instance: MonitoredInstance, result: unknown): void {
  if (instance.currentTool) {
    instance.currentTool.durationMs = Date.now() - instance.currentTool.timestamp;
    instance.currentTool.resultPreview = String(result).slice(0, 200);
    pushToolCall(instance, instance.currentTool);
    instance.currentTool = null;
  }
}

function pushToolCall(instance: MonitoredInstance, tool: ToolCallEvent): void {
  instance.toolCalls.push(tool);
  if (instance.toolCalls.length > MAX_TOOL_HISTORY) {
    instance.toolCalls.shift();
  }
}

// ─── Codex JSONL Parsing ────────────────────────────────────────────
//
// Codex emits a different event shape than Claude's stream-json. The
// per-event handler above matches Claude's `assistant` blocks; this
// post-completion pass walks the full Codex JSONL stdout and synthesizes
// telemetry so role-telemetry / task_telemetry don't silently report
// `total_tools = 0` for every Codex spawn.
//
// Codex shapes consumed here (item.completed events with item.type =):
//   - mcp_tool_call    → tool call, name `mcp__<server>__<tool>`
//   - command_execution → Bash equivalent
//   - agent_message    → assistant text accumulation
// And turn-level:
//   - turn.completed.usage.{input_tokens,output_tokens,cached_input_tokens}
//     → token estimates (cached_input_tokens is a subset of input_tokens
//     reported separately so cost can apply the cached rate to that slice)

export function recordCodexResult(taskId: string, stdoutJsonl: string): void {
  const instance = instances.get(taskId);
  if (!instance || typeof stdoutJsonl !== "string" || !stdoutJsonl) return;

  for (const rawLine of stdoutJsonl.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object") continue;

    if (ev.type === "item.completed" && ev.item && typeof ev.item === "object") {
      const item = ev.item;
      const itemType = String(item.type || "");

      if (itemType === "mcp_tool_call") {
        const server = String(item.server || "unknown");
        const tool = String(item.tool || "unknown");
        const toolName = `mcp__${server}__${tool}`;
        const toolInput = (item.arguments && typeof item.arguments === "object")
          ? item.arguments as Record<string, unknown>
          : {};
        let resultPreview: string;
        if (item.error && typeof item.error === "object" && item.error.message) {
          resultPreview = `Error: ${String(item.error.message).slice(0, 200)}`;
        } else if (item.result !== undefined && item.result !== null) {
          resultPreview = JSON.stringify(item.result).slice(0, 200);
        } else {
          resultPreview = "";
        }
        pushToolCall(instance, {
          timestamp: Date.now(),
          toolName,
          toolInput,
          displaySummary: formatToolSummary(toolName, toolInput),
          resultPreview,
        });
      } else if (itemType === "command_execution") {
        const command = String(item.command || "");
        pushToolCall(instance, {
          timestamp: Date.now(),
          toolName: "Bash",
          toolInput: { command },
          displaySummary: formatToolSummary("Bash", { command }),
          resultPreview: String(item.output || "").slice(0, 200),
        });
      } else if (itemType === "agent_message" && typeof item.text === "string") {
        instance.assistantText += item.text;
        instance.estimatedOutputTokens = Math.round(instance.assistantText.length / 4);
      }
    } else if (ev.type === "turn.completed" && ev.usage && typeof ev.usage === "object") {
      // Authoritative token counts from Codex itself — preferred over the
      // text-length estimate maintained while accumulating agent_message.
      if (typeof ev.usage.input_tokens === "number") {
        instance.estimatedInputTokens = ev.usage.input_tokens;
      }
      if (typeof ev.usage.output_tokens === "number") {
        instance.estimatedOutputTokens = ev.usage.output_tokens;
      }
      if (typeof ev.usage.cached_input_tokens === "number") {
        instance.cachedInputTokens = ev.usage.cached_input_tokens;
      }
    }
  }
}

// ─── Claude stdout post-hoc replay ───────────────────────────────────
//
// task-runner spawns drive a StreamPoller that feeds events into
// processMonitorEvent live. The handoff-router path doesn't poll —
// it watches for the result file and reads the whole stdout once at
// the end. This helper iterates Claude's stream-json stdout post-hoc
// and feeds each line through processMonitorEvent so chain-step
// instances accumulate the same tool-call / token state that
// task-runner spawns get for free.
//
// Mirrors recordCodexResult: tolerant of malformed lines, no-ops on
// unknown event types, defensive against missing instances.

export function recordClaudeResult(taskId: string, stdout: string): void {
  const instance = instances.get(taskId);
  if (!instance || typeof stdout !== "string" || !stdout) return;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event && typeof event === "object" && typeof event.type === "string") {
      processMonitorEvent(taskId, event);
    }
  }
}

// ─── Intervention Controls ───────────────────────────────────────────

export function setHoldContinuation(taskId: string, hold: boolean): boolean {
  const instance = instances.get(taskId);
  if (!instance) return false;
  instance.holdContinuation = hold;
  instance.status = hold ? "paused_continue" : "running";
  console.log(`[MONITOR] ${taskId} hold continuation: ${hold}`);
  if (onUpdateCallback) onUpdateCallback(instance);
  return true;
}

export function setInterventionNote(taskId: string, note: string): boolean {
  const instance = instances.get(taskId);
  if (!instance) return false;
  instance.interventionNote = note;
  console.log(`[MONITOR] ${taskId} intervention note set: ${note.slice(0, 80)}`);
  return true;
}

export function clearInterventionNote(taskId: string): void {
  const instance = instances.get(taskId);
  if (instance) instance.interventionNote = null;
}

export function getInterventionNote(taskId: string): string | null {
  return instances.get(taskId)?.interventionNote || null;
}

export function isHoldingContinuation(taskId: string): boolean {
  return instances.get(taskId)?.holdContinuation || false;
}

// ─── Pricing ─────────────────────────────────────────────────────────
//
// Per-million-token rates in USD. Claude row prices Sonnet 4.x; Codex row
// prices GPT-5.4 (the default model in ~/.codex/config.toml). Cached input
// applies only to Codex for now — Claude prompt-cache cost capture is a
// separate follow-up. If the runtime field on a MonitoredInstance ever
// gains a third value, add a row here or the cost will silently fall back
// to Claude pricing.
const PRICING_PER_MTOK_USD: Record<
  "claude" | "codex",
  { input: number; cachedInput: number; output: number }
> = {
  claude: { input: 3, cachedInput: 3, output: 15 },
  codex:  { input: 1.25, cachedInput: 0.125, output: 10 },
};

function estimateCostCents(instance: MonitoredInstance): number {
  const rates = PRICING_PER_MTOK_USD[instance.runtime] ?? PRICING_PER_MTOK_USD.claude;
  // cached_input_tokens is a subset of input_tokens; subtract so each slice
  // is priced at its own rate. Defensive clamp covers a malformed payload
  // where cached > input.
  const cached = Math.max(0, Math.min(instance.cachedInputTokens, instance.estimatedInputTokens));
  const fresh = instance.estimatedInputTokens - cached;
  const inputCost = (fresh / 1_000_000) * rates.input + (cached / 1_000_000) * rates.cachedInput;
  const outputCost = (instance.estimatedOutputTokens / 1_000_000) * rates.output;
  return Math.round((inputCost + outputCost) * 100);
}

// ─── Summary for Persistence ─────────────────────────────────────────

export function getCompletedSummary(taskId: string): {
  toolCalls: ToolCallEvent[];
  totalTools: number;
  durationMs: number;
  estInputTokens: number;
  estOutputTokens: number;
  estCostCents: number;
  intervention: string | null;
} | null {
  const instance = instances.get(taskId);
  if (!instance) return null;

  const durationMs = Date.now() - instance.startedAt;
  const estCostCents = estimateCostCents(instance);

  return {
    toolCalls: instance.toolCalls,
    totalTools: instance.toolCalls.length,
    durationMs,
    estInputTokens: instance.estimatedInputTokens,
    estOutputTokens: instance.estimatedOutputTokens,
    estCostCents,
    intervention: instance.interventionNote,
  };
}

// ─── Utility ─────────────────────────────────────────────────────────

export function setMonitorMessageId(taskId: string, messageId: string): void {
  const instance = instances.get(taskId);
  if (instance) instance.monitorMessageId = messageId;
}

export function updateInstanceStatus(taskId: string, status: MonitoredInstance["status"]): void {
  const instance = instances.get(taskId);
  if (instance) {
    instance.status = status;
    if (onUpdateCallback) onUpdateCallback(instance);
  }
}
