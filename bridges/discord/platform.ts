/**
 * Cross-platform abstractions for paths, processes, signals, environment, and scheduling.
 *
 * Phases W1+W2 of cross-platform plan.
 * All platform-specific logic in the TypeScript bot code funnels through here.
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir, platform, tmpdir } from "os";
import { execSync } from "child_process";

export const IS_WINDOWS = platform() === "win32";
export const IS_MACOS = platform() === "darwin";
export const IS_LINUX = platform() === "linux";

// ─── Paths ─────────────────────────────────────────────────────────────

export const paths = {
  /** User home directory. */
  home(): string {
    return process.env.HOME || process.env.USERPROFILE || homedir();
  },

  /** Path to Python 3 interpreter. */
  python(): string {
    if (process.env.PYTHON_PATH) return process.env.PYTHON_PATH;

    if (IS_MACOS) {
      const brew = "/opt/homebrew/bin/python3";
      if (existsSync(brew)) return brew;
    }

    // Fallback: assume it's in PATH
    return IS_WINDOWS ? "python" : "python3";
  },

  /** Path to Claude CLI binary. */
  claudeCli(): string {
    if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;

    if (IS_WINDOWS) {
      const localApp = process.env.LOCALAPPDATA || "";
      const candidates = [
        join(localApp, "claude", "claude.exe"),
        join(localApp, "Programs", "claude", "claude.exe"),
      ];
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
      return "claude"; // hope it's in PATH
    }

    return join(paths.home(), ".local", "bin", "claude");
  },

  /** Platform temp directory. */
  tempDir(): string {
    return tmpdir();
  },

  /** PATH separator (: on Unix, ; on Windows). */
  pathSeparator(): string {
    return IS_WINDOWS ? ";" : ":";
  },

  /** Build a PATH string from directory components. */
  buildPath(...dirs: string[]): string {
    return dirs.filter(Boolean).join(paths.pathSeparator());
  },

  /** Reasonable default PATH for clean subprocess environments. */
  defaultPath(): string {
    const home = paths.home();
    if (IS_WINDOWS) {
      const sysRoot = process.env.SystemRoot || "C:\\Windows";
      return paths.buildPath(
        join(home, ".local", "bin"),
        join(sysRoot, "System32"),
        sysRoot,
      );
    }
    return paths.buildPath(
      join(home, ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    );
  },

  /** Default shell for the platform. */
  defaultShell(): string {
    if (IS_WINDOWS) {
      return process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
    }
    return process.env.SHELL || "/bin/zsh";
  },

  /** macOS LaunchAgents directory. Null on other platforms. */
  launchAgentsDir(): string | null {
    if (IS_MACOS) return join(paths.home(), "Library", "LaunchAgents");
    return null;
  },
};

// ─── Process Management ────────────────────────────────────────────────

export const proc = {
  /** Check if a process is running. */
  isAlive(pid: number): boolean {
    try {
      if (IS_WINDOWS) {
        const result = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        return result.includes(String(pid));
      }
      // Unix: signal 0
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Terminate a process and its descendants. Returns true if a kill signal
   * was successfully delivered (not whether anything actually died — kernel
   * delivery semantics).
   *
   * On Unix: tries process-group kill first (negative pid = group). The bot
   * spawns task runners with `detached: true` so the python child becomes
   * the group leader; group kill cascades to its `subprocess.Popen`-spawned
   * `claude` / `codex` CLI grandchild. Without group kill, signaling only
   * the leader leaves the CLI grandchild orphaned (reparented to init/launchd)
   * and continuing to spend API credits — which is exactly the bug
   * /stop hit pre-fix. Falls back to direct-pid kill if the spawn wasn't
   * detached (e.g., heartbeat scripts spawned without process-group).
   *
   * On Windows: `taskkill /F /T` already kills the tree, no change needed.
   */
  terminate(pid: number): boolean {
    try {
      if (IS_WINDOWS) {
        execSync(`taskkill /PID ${pid} /F /T`, {
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        return true;
      }
      // Try group kill first; the negative-pid form signals the whole
      // process group whose leader is `pid`.
      try {
        process.kill(-pid, "SIGTERM");
        return true;
      } catch {
        // Group kill can fail with ESRCH if `pid` isn't a group leader
        // (spawn wasn't detached) or with EPERM if we don't own it. Fall
        // back to direct-pid kill — better than nothing.
        process.kill(pid, "SIGTERM");
        return true;
      }
    } catch {
      return false;
    }
  },

  /**
   * Open a URL in the default browser.
   * Uses 'open' on macOS, 'start' on Windows, 'xdg-open' on Linux.
   */
  openUrl(url: string): void {
    const cmd = IS_MACOS ? "open" : IS_WINDOWS ? "start" : "xdg-open";
    try {
      execSync(`${cmd} "${url}"`, { stdio: "ignore" });
    } catch {
      console.error(`[PLATFORM] Failed to open URL: ${url}`);
    }
  },
};

// ─── Environment ───────────────────────────────────────────────────────

export const env = {
  /**
   * Build a clean subprocess environment.
   * Strips CLAUDE* vars, sets sensible cross-platform defaults.
   */
  cleanEnv(passthrough?: string[]): Record<string, string> {
    const home = paths.home();
    const result: Record<string, string> = {
      HOME: home,
      USERPROFILE: home,
      USER: process.env.USER || process.env.USERNAME || "",
      PATH: paths.defaultPath(),
      SHELL: paths.defaultShell(),
      LANG: process.env.LANG || "en_US.UTF-8",
      TERM: "dumb",
      HARNESS_ROOT: process.env.HARNESS_ROOT || "",
    };

    if (IS_WINDOWS) {
      for (const key of ["SystemRoot", "COMSPEC", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA"]) {
        if (process.env[key]) result[key] = process.env[key]!;
      }
    }

    if (passthrough) {
      for (const key of passthrough) {
        if (process.env[key]) result[key] = process.env[key]!;
      }
    }

    // Remove empty values
    for (const [k, v] of Object.entries(result)) {
      if (!v) delete result[k];
    }

    return result;
  },

  /** Return env dict with all CLAUDE* vars removed. */
  stripClaudeVars(baseEnv?: Record<string, string>): Record<string, string> {
    const source = baseEnv || { ...process.env } as Record<string, string>;
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(source)) {
      if (!k.startsWith("CLAUDE") && v !== undefined) result[k] = v;
    }
    return result;
  },
};

// ─── Scheduler ────────────────────────────────────────────────────────

export interface TaskStatus {
  label: string;
  loaded: boolean;
  pid?: number;
  exitCode?: number;
  state: "running" | "loaded" | "not-loaded" | "stale" | "unknown";
}

export const scheduler = {
  LABEL_PREFIX: "com.aiharness.heartbeat",

  /** Name of the platform scheduler. */
  name(): string {
    if (IS_MACOS) return "launchd";
    if (IS_WINDOWS) return "task-scheduler";
    return "systemd";
  },

  /** Full label for a task. */
  taskLabel(taskName: string): string {
    return `${scheduler.LABEL_PREFIX}.${taskName}`;
  },

  /** Get status of a specific scheduled task. */
  status(label: string): TaskStatus {
    if (IS_MACOS) {
      try {
        const result = execSync(`launchctl list ${label} 2>/dev/null`, {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let pid: number | undefined;
        for (const line of result.split("\n")) {
          if (line.includes('"PID"')) {
            const m = line.match(/=\s*(\d+)/);
            if (m) pid = parseInt(m[1], 10);
          }
        }
        return {
          label,
          loaded: true,
          pid,
          state: pid ? "running" : "loaded",
        };
      } catch {
        return { label, loaded: false, state: "not-loaded" };
      }
    }

    if (IS_WINDOWS) {
      const schtaskName = `\\${label.replace(/\./g, "\\")}`;
      try {
        const result = execSync(
          `schtasks /Query /TN "${schtaskName}" /FO CSV /V /NH 2>nul`,
          { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
        );
        const running = result.includes("Running");
        return { label, loaded: true, state: running ? "running" : "loaded" };
      } catch {
        return { label, loaded: false, state: "not-loaded" };
      }
    }

    return { label, loaded: false, state: "unknown" };
  },

  /** List all tasks with the given prefix. */
  listTasks(prefix?: string): TaskStatus[] {
    const pfx = prefix || scheduler.LABEL_PREFIX;
    if (IS_MACOS) {
      try {
        const result = execSync("launchctl list 2>/dev/null", {
          encoding: "utf-8",
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const tasks: TaskStatus[] = [];
        for (const line of result.trim().split("\n")) {
          const parts = line.split("\t");
          if (parts.length < 3) continue;
          const [pidStr, exitStr, label] = [parts[0].trim(), parts[1].trim(), parts[2].trim()];
          if (!label.startsWith(pfx)) continue;
          const pid = pidStr !== "-" ? parseInt(pidStr, 10) : undefined;
          const exitCode = exitStr !== "-" ? parseInt(exitStr, 10) : undefined;
          const state = pid ? "running" : exitCode === 78 ? "stale" : "loaded";
          tasks.push({ label, loaded: true, pid, exitCode, state });
        }
        return tasks;
      } catch {
        return [];
      }
    }
    return [];
  },

  /** Reload (stop + start) a task. */
  reload(labelOrName: string): boolean {
    const label = labelOrName.includes(".") ? labelOrName : scheduler.taskLabel(labelOrName);
    if (IS_MACOS) {
      const launchDir = paths.launchAgentsDir();
      if (!launchDir) return false;
      const plistPath = join(launchDir, `${label}.plist`);
      if (!existsSync(plistPath)) return false;
      try {
        execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "pipe", timeout: 10000 });
        execSync(`launchctl load "${plistPath}"`, { stdio: "pipe", timeout: 10000 });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  },
};

// ─── Signal Handling ───────────────────────────────────────────────────

/**
 * Register graceful shutdown handlers.
 * On Unix: SIGINT + SIGTERM. On Windows: SIGINT only (SIGTERM not supported).
 */
export function onShutdown(handler: () => void): void {
  process.on("SIGINT", handler);
  if (!IS_WINDOWS) {
    process.on("SIGTERM", handler);
  }
}
