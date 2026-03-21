/**
 * tmux Session Manager
 *
 * Thin wrapper around tmux CLI for parallel agent orchestration.
 * Manages a single tmux server session ("harness") with per-agent windows.
 * Graceful fallback: if tmux is unavailable, all functions return failures
 * and parallel tasks fall back to subprocess-only execution.
 *
 * Window naming: {agent}-{shortId} (e.g., "researcher-a1b2", "builder-c3d4")
 */

import { execSync } from "child_process";

const TMUX_BIN = process.env.TMUX_PATH || "/opt/homebrew/bin/tmux";
const TMUX_SESSION = "harness";
const CMD_TIMEOUT = 5000; // 5s — tmux commands are fast

// ─── Helpers ────────────────────────────────────────────────────────

function tmuxAvailable(): boolean {
  try {
    execSync(`${TMUX_BIN} -V`, { timeout: CMD_TIMEOUT, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function runTmux(args: string): string | null {
  try {
    return execSync(`${TMUX_BIN} ${args}`, {
      encoding: "utf-8",
      timeout: CMD_TIMEOUT,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err: any) {
    console.error(`[TMUX] Command failed: tmux ${args.slice(0, 80)} — ${err.message?.split("\n")[0]}`);
    return null;
  }
}

let _available: boolean | null = null;

function isAvailable(): boolean {
  if (_available === null) _available = tmuxAvailable();
  return _available;
}

// ─── Public API ─────────────────────────────────────────────────────

export interface TmuxWindow {
  name: string;
  active: boolean;
  index: number;
}

/**
 * Ensure the "harness" tmux session exists. Creates it if missing.
 * Called on bot startup.
 */
export function ensureSession(): boolean {
  if (!isAvailable()) {
    console.warn("[TMUX] tmux not available — parallel tasks will use subprocess fallback");
    return false;
  }

  // Check if session already exists (has-session exits 1 if missing — not an error)
  try {
    execSync(`${TMUX_BIN} has-session -t ${TMUX_SESSION} 2>/dev/null`, {
      timeout: CMD_TIMEOUT,
      stdio: "pipe",
    });
    console.log(`[TMUX] Session "${TMUX_SESSION}" already exists`);
    return true;
  } catch {
    // Session doesn't exist — create it below
  }

  // Create session with an idle window (detached)
  const result = runTmux(`new-session -d -s ${TMUX_SESSION} -n idle`);
  if (result !== null) {
    console.log(`[TMUX] Created session "${TMUX_SESSION}"`);
    return true;
  }

  // new-session returns empty string on success, so check again
  const verify = runTmux(`has-session -t ${TMUX_SESSION} 2>/dev/null`);
  if (verify !== null) {
    console.log(`[TMUX] Created session "${TMUX_SESSION}"`);
    return true;
  }

  console.error("[TMUX] Failed to create session");
  return false;
}

/**
 * Create a new tmux window that runs the given command.
 * The window starts detached (background).
 */
export function createWindow(
  name: string,
  command: string,
  env?: Record<string, string>,
): boolean {
  if (!isAvailable()) return false;

  // Set environment variables in the tmux session before creating window
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      runTmux(`setenv -t ${TMUX_SESSION} ${key} '${value.replace(/'/g, "'\\''")}'`);
    }
  }

  // Create window with command. Use shell -c to handle complex commands.
  const escapedCmd = command.replace(/'/g, "'\\''");
  const result = runTmux(
    `new-window -t ${TMUX_SESSION} -n '${name}' -d '/bin/sh -c "'"'"'${escapedCmd}'"'"'"'`
  );

  // new-window returns empty on success
  if (result === null) {
    // Verify it was created
    const windows = listWindows();
    if (windows.some((w) => w.name === name)) return true;
    console.error(`[TMUX] Failed to create window "${name}"`);
    return false;
  }
  return true;
}

/**
 * Kill a specific tmux window by name.
 */
export function killWindow(name: string): boolean {
  if (!isAvailable()) return false;
  const result = runTmux(`kill-window -t '${TMUX_SESSION}:${name}'`);
  return result !== null;
}

/**
 * List all windows in the harness tmux session.
 */
export function listWindows(): TmuxWindow[] {
  if (!isAvailable()) return [];
  const result = runTmux(
    `list-windows -t ${TMUX_SESSION} -F '#{window_index}||#{window_name}||#{window_active}'`
  );
  if (!result) return [];

  return result
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [index, name, active] = line.split("||");
      return {
        index: parseInt(index, 10),
        name: name || "",
        active: active === "1",
      };
    });
}

/**
 * Capture the last N lines of output from a tmux window.
 * Useful for debugging live agent sessions.
 */
export function capturePane(windowName: string, lines: number = 50): string | null {
  if (!isAvailable()) return null;
  return runTmux(`capture-pane -t '${TMUX_SESSION}:${windowName}' -p -S -${lines}`);
}

/**
 * Check if a specific window exists.
 */
export function hasWindow(name: string): boolean {
  return listWindows().some((w) => w.name === name);
}

/**
 * Kill orphaned windows whose parallel tasks are no longer running.
 * Called on bot startup and periodically for cleanup.
 */
export function cleanupDeadWindows(activeWindowNames: Set<string>): number {
  if (!isAvailable()) return 0;

  const windows = listWindows();
  let killed = 0;

  for (const win of windows) {
    // Skip the idle window and any active task windows
    if (win.name === "idle") continue;
    if (activeWindowNames.has(win.name)) continue;

    // This window has no matching active task — kill it
    killWindow(win.name);
    killed++;
  }

  if (killed > 0) {
    console.log(`[TMUX] Cleaned up ${killed} orphaned window(s)`);
  }
  return killed;
}

/**
 * Get the tmux session name for attach instructions.
 */
export function getAttachCommand(): string {
  return `tmux attach -t ${TMUX_SESSION}`;
}

/**
 * Check if the tmux session exists and is healthy.
 */
export function isSessionAlive(): boolean {
  if (!isAvailable()) return false;
  try {
    execSync(`${TMUX_BIN} has-session -t ${TMUX_SESSION} 2>/dev/null`, {
      timeout: CMD_TIMEOUT,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}
