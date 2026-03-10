import { existsSync, readdirSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";

export interface StreamEvent {
  type: "assistant" | "tool_use" | "tool_result" | "result" | string;
  content?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  result?: string;
}

export type StreamCallback = (text: string, toolInfo?: string) => void;

export class StreamPoller {
  private streamDir: string;
  private lastChunk: number = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private accumulatedText: string = "";
  private callback: StreamCallback;
  private lastCallbackTime: number = 0;
  private throttleMs: number;
  private done: boolean = false;

  constructor(
    streamDir: string,
    callback: StreamCallback,
    throttleMs: number = 2000
  ) {
    this.streamDir = streamDir;
    this.callback = callback;
    this.throttleMs = throttleMs;
    try {
      mkdirSync(streamDir, { recursive: true });
    } catch {}
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.poll(), 500);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // Final flush
    if (this.accumulatedText) {
      this.callback(this.accumulatedText);
    }
  }

  isDone(): boolean {
    return this.done;
  }

  private poll(): void {
    if (!existsSync(this.streamDir)) return;

    try {
      const files = readdirSync(this.streamDir)
        .filter((f) => f.startsWith("chunk-") && f.endsWith(".json"))
        .sort();

      for (const file of files) {
        const num = parseInt(file.replace("chunk-", "").replace(".json", ""), 10);
        if (num <= this.lastChunk) continue;

        const content = readFileSync(join(this.streamDir, file), "utf-8");
        try {
          const event: StreamEvent = JSON.parse(content);
          this.processEvent(event);
        } catch {}

        this.lastChunk = num;
      }
    } catch {}

    // Throttled callback
    const now = Date.now();
    if (
      this.accumulatedText &&
      now - this.lastCallbackTime >= this.throttleMs
    ) {
      this.callback(this.accumulatedText, undefined);
      this.lastCallbackTime = now;
    }
  }

  private processEvent(event: StreamEvent): void {
    switch (event.type) {
      case "assistant":
        if (event.content) {
          this.accumulatedText += event.content;
        }
        break;
      case "tool_use":
        if (event.tool_name) {
          const toolInfo = this.formatToolInfo(event.tool_name, event.tool_input);
          this.callback(this.accumulatedText, toolInfo);
          this.lastCallbackTime = Date.now();
        }
        break;
      case "result":
        this.done = true;
        if (event.result) {
          this.accumulatedText = event.result;
        }
        this.stop();
        break;
    }
  }

  private formatToolInfo(
    toolName: string,
    input?: Record<string, unknown>
  ): string {
    switch (toolName) {
      case "Read":
        return `Reading ${(input?.file_path as string) || "file"}...`;
      case "Grep":
        return `Searching for "${(input?.pattern as string) || "pattern"}"...`;
      case "Glob":
        return `Finding files matching ${(input?.pattern as string) || "pattern"}...`;
      case "Edit":
        return `Editing ${(input?.file_path as string) || "file"}...`;
      case "Write":
        return `Writing ${(input?.file_path as string) || "file"}...`;
      case "Bash":
        return `Running command...`;
      default:
        return `Using ${toolName}...`;
    }
  }
}
