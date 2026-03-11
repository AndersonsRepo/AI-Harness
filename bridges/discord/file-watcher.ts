import { watch, existsSync, readFileSync, FSWatcher } from "fs";
import { dirname, basename } from "path";

export interface FileWatcherOptions {
  /** Path to the file to watch for */
  filePath: string;
  /** Called when file is detected and readable */
  onFile: (content: string) => void;
  /** Called on timeout (optional) */
  onTimeout?: () => void;
  /** Timeout in ms (0 = no timeout) */
  timeoutMs?: number;
  /** Delay before reading after fs.watch event (ms) — allows atomic rename to complete */
  retryReadMs?: number;
  /** Fallback poll interval (ms) — safety net for unreliable fs.watch */
  fallbackPollMs?: number;
}

/**
 * Event-driven file watcher with fallback polling.
 * Watches the directory (not the file) since the file may not exist yet.
 * On detection: waits retryReadMs, then reads. Fallback polls at fallbackPollMs.
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private fallbackInterval: ReturnType<typeof setInterval> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly dir: string;
  private readonly filename: string;
  private opts: FileWatcherOptions;

  constructor(opts: FileWatcherOptions) {
    this.opts = opts;
    this.dir = dirname(opts.filePath);
    this.filename = basename(opts.filePath);
  }

  start(): void {
    if (this.stopped) return;

    // Watch the directory for changes
    try {
      this.watcher = watch(this.dir, (eventType, changedFile) => {
        if (this.stopped) return;
        if (changedFile === this.filename || changedFile === this.filename + ".tmp") {
          // Delay read to allow atomic rename (.tmp -> final) to complete
          setTimeout(() => this.tryRead(), this.opts.retryReadMs ?? 50);
        }
      });
      this.watcher.on("error", () => {
        // fs.watch error — fallback poll will handle it
      });
    } catch {
      // Directory doesn't exist yet — fallback poll will handle it
    }

    // Fallback polling (safety net)
    const pollMs = this.opts.fallbackPollMs ?? 5000;
    this.fallbackInterval = setInterval(() => this.tryRead(), pollMs);

    // Timeout
    if (this.opts.timeoutMs && this.opts.timeoutMs > 0) {
      this.timeoutTimer = setTimeout(() => {
        if (this.stopped) return;
        this.stop();
        this.opts.onTimeout?.();
      }, this.opts.timeoutMs);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.fallbackInterval) {
      clearInterval(this.fallbackInterval);
      this.fallbackInterval = null;
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  isStopped(): boolean {
    return this.stopped;
  }

  private tryRead(): void {
    if (this.stopped) return;
    if (!existsSync(this.opts.filePath)) return;

    try {
      const content = readFileSync(this.opts.filePath, "utf-8");
      // Sanity check — file should have content (not still being written)
      if (!content || content.length === 0) return;

      this.stop();
      this.opts.onFile(content);
    } catch {
      // File might still be locked/incomplete — next poll will retry
    }
  }
}

// Track all active watchers for clean shutdown
const activeWatchers: Set<FileWatcher> = new Set();

export function trackWatcher(watcher: FileWatcher): void {
  activeWatchers.add(watcher);
}

export function untrackWatcher(watcher: FileWatcher): void {
  activeWatchers.delete(watcher);
}

export function stopAllWatchers(): void {
  for (const w of activeWatchers) {
    w.stop();
  }
  activeWatchers.clear();
}
