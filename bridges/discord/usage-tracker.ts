/**
 * Usage / rate-limit tracker.
 *
 * The Claude subscription CLI exposes NO remaining-quota number and NO reset
 * time — `classifyClaudeError` deliberately refuses to guess the bucket. So the
 * honest, deterministic thing we CAN track is *occurrence*: when we last hit a
 * usage limit / rate limit, which runtime, and how many times today. That tells
 * you whether you're currently burning into limits without pretending to know a
 * percentage.
 *
 * Recorded at the single failover chokepoint (runtime-failover.ts) so both the
 * task-runner and subagent paths feed it. Pure file I/O, no AI, no tokens. State
 * lives in `$HARNESS_ROOT/.usage-state.json` (gitignored, transient).
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export type LimitKind = "usage_limit" | "rate_limit" | "credit_balance";

const TRACKED: LimitKind[] = ["usage_limit", "rate_limit", "credit_balance"];

let stateFile = join(process.env.HARNESS_ROOT || ".", ".usage-state.json");

/** Redirect the state file to a temp path in tests (keep the live panel data clean). */
export function setUsageStateFileForTests(path: string | null): void {
  stateFile = path || join(process.env.HARNESS_ROOT || ".", ".usage-state.json");
}

interface LimitEvent {
  at: number; // epoch ms
  runtime: string;
}

interface UsageState {
  lastByKind: Partial<Record<LimitKind, LimitEvent>>;
  today: { date: string; counts: Partial<Record<LimitKind, number>> };
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyState(): UsageState {
  return { lastByKind: {}, today: { date: todayStr(), counts: {} } };
}

function read(): UsageState {
  try {
    if (!existsSync(stateFile)) return emptyState();
    const parsed = JSON.parse(readFileSync(stateFile, "utf-8"));
    if (!parsed || typeof parsed !== "object") return emptyState();
    return {
      lastByKind: parsed.lastByKind ?? {},
      today:
        parsed.today?.date === todayStr()
          ? { date: parsed.today.date, counts: parsed.today.counts ?? {} }
          : { date: todayStr(), counts: {} },
    };
  } catch {
    return emptyState();
  }
}

/** Record a usage/rate/credit limit hit. Best-effort; never throws. */
export function recordLimitEvent(kind: string, runtime: string): void {
  if (!TRACKED.includes(kind as LimitKind)) return;
  const k = kind as LimitKind;
  try {
    const state = read();
    state.lastByKind[k] = { at: Date.now(), runtime };
    state.today.counts[k] = (state.today.counts[k] ?? 0) + 1;
    writeFileSync(stateFile, JSON.stringify(state), "utf-8");
  } catch {
    /* best-effort */
  }
}

export function getUsageState(): UsageState {
  return read();
}

function ago(ms: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 90) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 90) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const LABEL: Record<LimitKind, string> = {
  usage_limit: "🚫 Usage limit",
  rate_limit: "⏳ Rate limit",
  credit_balance: "💳 Credit balance",
};

/** One-line-per-kind status for the control panel. */
export function formatUsageStatus(state: UsageState = read()): string {
  const lines: string[] = [];
  for (const kind of TRACKED) {
    const last = state.lastByKind[kind];
    const count = state.today.counts[kind] ?? 0;
    if (!last && count === 0) continue;
    const parts: string[] = [];
    if (last) parts.push(`last ${ago(last.at)} (${last.runtime})`);
    if (count) parts.push(`${count}× today`);
    lines.push(`${LABEL[kind]}: ${parts.join(", ")}`);
  }
  return lines.length ? lines.join("\n") : "🟢 No usage/rate limits recorded today.";
}
