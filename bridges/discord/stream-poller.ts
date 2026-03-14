import { existsSync, readdirSync, readFileSync, mkdirSync, watch, FSWatcher } from "fs";
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
  private watcher: FSWatcher | null = null;
  private fallbackInterval: ReturnType<typeof setInterval> | null = null;
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
    if (this.watcher || this.fallbackInterval) return;

    // Primary: fs.watch on the stream directory
    try {
      this.watcher = watch(this.streamDir, (eventType, filename) => {
        if (filename && filename.startsWith("chunk-") && filename.endsWith(".json")) {
          this.poll();
        }
      });
      this.watcher.on("error", () => {
        // Watcher error — fallback handles it
      });
    } catch {
      // Directory might not exist yet
    }

    // Fallback poll at 2s (safety net)
    this.fallbackInterval = setInterval(() => this.poll(), 2000);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.fallbackInterval) {
      clearInterval(this.fallbackInterval);
      this.fallbackInterval = null;
    }
    // Don't flush if the result event already arrived — the onTaskOutput
    // handler will post the final response to avoid duplicates.
  }

  /** Stop without flushing — used when the result event arrives,
   *  since the onTaskOutput handler will post the final response. */
  private stopWithoutFlush(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.fallbackInterval) {
      clearInterval(this.fallbackInterval);
      this.fallbackInterval = null;
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
        // Don't update accumulatedText or flush — the onTaskOutput handler
        // will post the final response. The stream poller only handles
        // progressive updates during execution.
        this.stopWithoutFlush();
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
