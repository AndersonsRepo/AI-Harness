/**
 * Autorun Mode — the human-operated AI kill-switch behind the control panel.
 *
 * A single mode persisted to `$HARNESS_ROOT/.autorun-mode` (absence = normal).
 * It is read at every autonomous AI spawn chokepoint and written ONLY by the
 * deterministic control-panel button handlers — never by an agent. Toggling it
 * costs no tokens and is fully reversible from the panel buttons (which are
 * Discord interactions, not messages, so they keep working even under `full`).
 *
 *   normal      — everything runs (default; flag file absent).
 *   autonomous  — autonomous AI is paused: agent chains (subagent/handoff/
 *                 parallel), AI heartbeats, and the work-queue dispatcher are
 *                 gated. You can still chat with the bot directly.
 *   full        — also freezes the bot's response to your own messages. The
 *                 panel buttons still work, so you can switch back.
 *
 * This module has NO harness imports so it can be pulled into hot-path files
 * (runtime-invocation, work-queue) without circular-dependency risk.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

export type AutorunMode = "normal" | "autonomous" | "full";

let modeFile = join(process.env.HARNESS_ROOT || ".", ".autorun-mode");

/**
 * Redirect the mode file to a temp path in tests, so test get/set never touches
 * the LIVE `.autorun-mode` flag the running bot reads (which would freeze it).
 */
export function setAutorunModeFileForTests(path: string | null): void {
  modeFile = path || join(process.env.HARNESS_ROOT || ".", ".autorun-mode");
}

export function getAutorunMode(): AutorunMode {
  try {
    if (!existsSync(modeFile)) return "normal";
    const value = readFileSync(modeFile, "utf-8").trim();
    return value === "autonomous" || value === "full" ? value : "normal";
  } catch {
    return "normal";
  }
}

export function setAutorunMode(mode: AutorunMode): void {
  if (mode === "normal") {
    try {
      if (existsSync(modeFile)) unlinkSync(modeFile);
    } catch {
      /* best-effort */
    }
    return;
  }
  writeFileSync(modeFile, `${mode}\n`, "utf-8");
}

/** True when autonomous AI (chains, AI heartbeats, work-queue) must be gated. */
export function isAutonomousPaused(): boolean {
  const mode = getAutorunMode();
  return mode === "autonomous" || mode === "full";
}

/** True when even direct user-message → AI responses must be gated. */
export function isFullyFrozen(): boolean {
  return getAutorunMode() === "full";
}

export function describeAutorunMode(mode: AutorunMode = getAutorunMode()): string {
  switch (mode) {
    case "autonomous":
      return "⏸ Autonomous paused — chains, AI heartbeats & work-queue gated. Direct chat still works.";
    case "full":
      return "🧊 Full freeze — all AI gated, including replies to your messages. Buttons still work.";
    default:
      return "🟢 Normal — all AI running.";
  }
}
