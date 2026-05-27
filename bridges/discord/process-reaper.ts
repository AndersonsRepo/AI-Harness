/**
 * Process Reaper
 *
 * Deterministic cleanup for WEDGED harness runner processes (codex/claude
 * agent spawns) that hung past their timeout and orphaned. Runners are spawned
 * `detached + unref()` (runtime-invocation.ts), so a hung one survives bot
 * restarts and accumulates indefinitely — see
 * vault/learnings/ERR-orphaned-agent-spawns-survive-timeout.md.
 *
 * This module is PURE infrastructure: it shells out to `ps`, matches harness
 * runner signatures, and SIGTERM/SIGKILLs the wedged ones. It spawns no AI and
 * costs no tokens — safe to wire to a Discord button, a heartbeat, and startup.
 *
 * Safety: only processes that BOTH (a) match an unambiguous harness-runner
 * signature AND (b) are older than `maxAgeSecs` are killed. The age floor is far
 * above any real task timeout, so an in-flight task can never be reaped. The
 * signatures specifically exclude interactive Claude Code, `--bg-spare` pools,
 * and unrelated codex/Cursor usage.
 */
import { execFileSync } from "child_process";

export interface RunnerProcess {
  pid: number;
  ageSecs: number;
  kind: "codex" | "claude";
  command: string;
}

export interface ReapReport {
  scannedRunners: number;
  maxAgeSecs: number;
  reaped: { pid: number; ageSecs: number; kind: RunnerProcess["kind"] }[];
  failed: { pid: number; error: string }[];
  skippedYoung: number;
  dryRun: boolean;
}

/**
 * Default: 30 minutes. The runtime-invocation default timeout is 600s (10 min)
 * and subagents cap lower, so a runner alive >30 min is wedged by definition.
 * Override with HARNESS_REAPER_MAX_AGE_SECS.
 */
function defaultMaxAgeSecs(): number {
  const raw = Number(process.env.HARNESS_REAPER_MAX_AGE_SECS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1800;
}

// ─── Injectable seams (tests) ───────────────────────────────────────────

let psLister: () => string = defaultPsList;
let killer: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) =>
  process.kill(pid, signal);

export function setReaperPsForTests(fn: (() => string) | null): void {
  psLister = fn || defaultPsList;
}
export function setReaperKillForTests(
  fn: ((pid: number, signal: NodeJS.Signals) => void) | null,
): void {
  killer = fn || ((pid, signal) => process.kill(pid, signal));
}

function defaultPsList(): string {
  try {
    // etimes = elapsed seconds (single integer) → no MM:SS/DD-HH parsing.
    return execFileSync("ps", ["-axo", "pid=,etimes=,command="], {
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

// ─── Classification ─────────────────────────────────────────────────────

/** The temp dir every harness runner reads/writes; a strong harness marker. */
const HARNESS_TMP = "/bridges/discord/.tmp/";

/**
 * Identify a harness runner from its command line, or null if it is not one.
 * Deliberately conservative — must never match interactive Claude Code, the
 * `--bg-spare` pool, Cursor, or a user's own codex/claude usage.
 */
export function classifyRunner(command: string): RunnerProcess["kind"] | null {
  // Harness codex agent: `codex exec ...` carrying the harness MCP env
  // injection (`-c mcp_servers.harness.env.HARNESS_*`). A user's own codex
  // would not inject the harness MCP servers.
  if (command.includes("codex") && /\bexec\b/.test(command) && command.includes("mcp_servers.harness")) {
    return "codex";
  }
  // Harness claude: headless `-p` with `--dangerously-skip-permissions`. Only
  // the harness runs claude this way; interactive Claude Code and `--bg-spare`
  // never combine `-p` with skip-permissions.
  if (
    command.includes("claude") &&
    command.includes("--dangerously-skip-permissions") &&
    (/\s-p\b/.test(command) || command.includes("--print"))
  ) {
    return "claude";
  }
  // The python wrapper that launches the above (also harness-only).
  if (command.includes("claude-runner.py") || command.includes("codex-runner.py")) {
    return command.includes("codex-runner.py") ? "codex" : "claude";
  }
  return null;
}

export function listHarnessRunners(): RunnerProcess[] {
  const out = psLister();
  const runners: RunnerProcess[] = [];
  const selfPid = process.pid;
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ageSecs = Number(m[2]);
    const command = m[3] ?? "";
    if (pid === selfPid) continue; // never target ourselves
    if (command.includes("/bridges/discord/process-reaper")) continue; // nor the reaper CLI
    const kind = classifyRunner(command);
    if (kind) runners.push({ pid, ageSecs, kind, command });
  }
  return runners;
}

// ─── Reaper ─────────────────────────────────────────────────────────────

/**
 * Kill a process GROUP. Harness runners are spawned `detached`, so the child
 * is its own session/group leader (pgid == pid); negating the pid reaps the
 * whole tree (the runner + its child MCP servers). Falls back to the bare pid.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!pid || pid <= 0) return;
  try {
    killer(-pid, signal);
  } catch {
    try {
      killer(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export interface ReapOptions {
  maxAgeSecs?: number;
  dryRun?: boolean;
}

/**
 * Reap harness runners older than maxAgeSecs. Returns a structured report.
 * Sends SIGTERM (which cleared all observed orphans in practice); persistently
 * wedged processes can be re-reaped on the next pass, escalating to SIGKILL.
 */
export function reapOrphanedRunners(opts: ReapOptions = {}): ReapReport {
  const maxAgeSecs = opts.maxAgeSecs ?? defaultMaxAgeSecs();
  const dryRun = Boolean(opts.dryRun);
  const runners = listHarnessRunners();

  const report: ReapReport = {
    scannedRunners: runners.length,
    maxAgeSecs,
    reaped: [],
    failed: [],
    skippedYoung: 0,
    dryRun,
  };

  for (const proc of runners) {
    if (proc.ageSecs < maxAgeSecs) {
      report.skippedYoung++;
      continue;
    }
    if (dryRun) {
      report.reaped.push({ pid: proc.pid, ageSecs: proc.ageSecs, kind: proc.kind });
      continue;
    }
    try {
      killProcessGroup(proc.pid, "SIGTERM");
      report.reaped.push({ pid: proc.pid, ageSecs: proc.ageSecs, kind: proc.kind });
    } catch (err: any) {
      report.failed.push({ pid: proc.pid, error: err?.message || String(err) });
    }
  }
  return report;
}

export function formatReapReport(report: ReapReport): string {
  const verb = report.dryRun ? "would reap" : "reaped";
  if (report.reaped.length === 0) {
    return `Reaper: scanned ${report.scannedRunners} runner(s), none older than ${report.maxAgeSecs}s — nothing to ${report.dryRun ? "reap" : "kill"}.`;
  }
  const lines = report.reaped.map(
    (r) => `  • pid ${r.pid} (${r.kind}, ${Math.floor(r.ageSecs / 60)}m old)`,
  );
  let out = `Reaper: ${verb} ${report.reaped.length} wedged runner(s) (>${Math.floor(report.maxAgeSecs / 60)}m):\n${lines.join("\n")}`;
  if (report.failed.length) {
    out += `\n  ⚠ ${report.failed.length} failed: ${report.failed.map((f) => f.pid).join(", ")}`;
  }
  return out;
}

// ─── CLI ────────────────────────────────────────────────────────────────
// `npx tsx bridges/discord/process-reaper.ts [--dry-run] [--max-age-secs N]`
// Lets a Python heartbeat / cron run the same logic without an AI in the loop.
const isMain = (() => {
  try {
    return process.argv[1] ? import.meta.url === `file://${process.argv[1]}` : false;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const ageIdx = args.indexOf("--max-age-secs");
  const maxAgeSecs = ageIdx >= 0 ? Number(args[ageIdx + 1]) : undefined;
  const report = reapOrphanedRunners({ dryRun, maxAgeSecs });
  console.log(formatReapReport(report));
  process.exit(0);
}
