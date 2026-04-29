/**
 * Per-role Claude vs Codex telemetry aggregator.
 *
 * Aggregates task_telemetry rows over a date window, grouped by
 * (agent, runtime). Surfaces cost, duration, error rate, and loop
 * rate per role-runtime pair so the operator can spot quality drift
 * after a runtime flip and roll back if Codex regresses.
 *
 * Pure data → string formatting; no Discord/IO concerns. Used by
 * scripts/role-telemetry-report.ts (CLI) and the heartbeat wrapper.
 */

import { getDb } from "./db.js";

export interface RoleTelemetryRow {
  agent: string;
  runtime: string;          // 'claude' | 'codex' | 'unknown' (null collapsed)
  count: number;
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgDurationMs: number;
  errorCount: number;
  loopCount: number;
  totalTools: number;
}

export interface AggregateOptions {
  /** Start of window, inclusive. Defaults to 7 days ago. */
  since?: Date;
  /** End of window, exclusive. Defaults to now. */
  until?: Date;
  /** Limit rows considered (e.g. dev sandbox). */
  limit?: number;
}

export function aggregateByRoleRuntime(opts: AggregateOptions = {}): RoleTelemetryRow[] {
  const since = opts.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const until = opts.until ?? new Date();

  const db = getDb();

  const sql = `
    SELECT
      COALESCE(agent, 'unassigned')              AS agent,
      COALESCE(runtime, 'unknown')               AS runtime,
      COUNT(*)                                   AS count,
      COALESCE(SUM(est_cost_cents), 0)           AS totalCostCents,
      COALESCE(SUM(est_input_tokens), 0)         AS totalInputTokens,
      COALESCE(SUM(est_output_tokens), 0)        AS totalOutputTokens,
      COALESCE(ROUND(AVG(duration_ms)), 0)       AS avgDurationMs,
      SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errorCount,
      SUM(loop_detected)                         AS loopCount,
      COALESCE(SUM(total_tools), 0)              AS totalTools
    FROM task_telemetry
    WHERE started_at >= ?
      AND started_at <  ?
    GROUP BY agent, runtime
    ORDER BY agent ASC, runtime ASC
    ${opts.limit ? "LIMIT " + Math.max(1, Math.floor(opts.limit)) : ""}
  `;

  const rows = db.prepare(sql).all(since.toISOString(), until.toISOString()) as RoleTelemetryRow[];
  return rows;
}

export interface FormattedReport {
  /** Date range as human-readable string. */
  windowLabel: string;
  /** Markdown-style table for Discord/CLI. */
  table: string;
  /** One-line summary highlighting the largest cost / highest error rate. */
  summary: string;
  /** Empty if no data; "no telemetry rows in window". */
  emptyMessage?: string;
}

function fmtCents(c: number): string {
  if (c === 0) return "$0.00";
  return `$${(c / 100).toFixed(2)}`;
}

function fmtDuration(ms: number): string {
  if (ms === 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtPct(num: number, denom: number): string {
  if (denom === 0) return "—";
  const pct = (num / denom) * 100;
  return pct < 0.05 ? "0.0%" : `${pct.toFixed(1)}%`;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function formatReport(rows: RoleTelemetryRow[], opts: AggregateOptions = {}): FormattedReport {
  const since = opts.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const until = opts.until ?? new Date();
  const windowLabel = `${fmtDate(since)} → ${fmtDate(until)}`;

  if (rows.length === 0) {
    return {
      windowLabel,
      table: "",
      summary: "no telemetry rows in window",
      emptyMessage: "no telemetry rows in window",
    };
  }

  const header =
    "| agent           | runtime | count | cost   | avg dur | err%   | loop% | tools |";
  const sep =
    "|-----------------|---------|------:|-------:|--------:|-------:|------:|------:|";
  const lines = [header, sep];
  for (const r of rows) {
    const agent = r.agent.padEnd(15).slice(0, 15);
    const runtime = r.runtime.padEnd(7);
    const count = String(r.count).padStart(5);
    const cost = fmtCents(r.totalCostCents).padStart(6);
    const dur = fmtDuration(r.avgDurationMs).padStart(7);
    const errPct = fmtPct(r.errorCount, r.count).padStart(6);
    const loopPct = fmtPct(r.loopCount, r.count).padStart(5);
    const tools = String(r.totalTools).padStart(5);
    lines.push(`| ${agent} | ${runtime} | ${count} | ${cost} | ${dur} | ${errPct} | ${loopPct} | ${tools} |`);
  }
  const table = lines.join("\n");

  const totalCost = rows.reduce((s, r) => s + r.totalCostCents, 0);
  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  const claudeCost = rows.filter((r) => r.runtime === "claude").reduce((s, r) => s + r.totalCostCents, 0);
  const codexCount = rows.filter((r) => r.runtime === "codex").reduce((s, r) => s + r.count, 0);
  const codexShare = totalCount > 0 ? (codexCount / totalCount) * 100 : 0;

  // Highest error rate among rows with at least 5 calls (avoid noise)
  const candidates = rows.filter((r) => r.count >= 5);
  let warning = "";
  if (candidates.length > 0) {
    const sorted = candidates.slice().sort((a, b) => b.errorCount / b.count - a.errorCount / a.count);
    const worst = sorted[0];
    if (worst.errorCount / worst.count >= 0.1) {
      warning = ` ⚠ ${worst.agent}/${worst.runtime} error rate ${fmtPct(worst.errorCount, worst.count)} (${worst.errorCount}/${worst.count})`;
    }
  }

  const summary =
    `${totalCount} tasks, ${fmtCents(totalCost)} total, ${fmtCents(claudeCost)} on Claude, ` +
    `${codexShare.toFixed(0)}% on Codex.${warning}`;

  return { windowLabel, table, summary };
}
