/**
 * Cross-platform abstractions for paths, processes, signals, and environment.
 *
 * Phase W1 of cross-platform plan.
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

  /** Terminate a process gracefully. Returns true if signal was sent. */
  terminate(pid: number): boolean {
    try {
      if (IS_WINDOWS) {
        execSync(`taskkill /PID ${pid} /F`, {
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        return true;
      }
      process.kill(pid, "SIGTERM");
      return true;
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
