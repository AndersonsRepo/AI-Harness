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

  // Discord state
  monitorMessageId: string | null;
  monitorThreadId: string | null;

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

export function setMonitorUpdateCallback(cb: (instance: MonitoredInstance) => void): void {
  onUpdateCallback = cb;
}

// ─── Registry CRUD ───────────────────────────────────────────────────

export function registerInstance(config: {
  taskId: string;
  channelId: string;
  agent: string;
  prompt: string;
  pid: number;
}): MonitoredInstance {
  const instance: MonitoredInstance = {
    taskId: config.taskId,
    channelId: config.channelId,
    agent: config.agent,
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

    monitorMessageId: null,
    monitorThreadId: null,

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

  // Cost estimate: Sonnet pricing $3/MTok input, $15/MTok output
  const inputCost = (instance.estimatedInputTokens / 1_000_000) * 3;
  const outputCost = (instance.estimatedOutputTokens / 1_000_000) * 15;
  const estCostCents = Math.round((inputCost + outputCost) * 100);

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
