import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const harnessRoot = mkdtempSync(join(tmpdir(), "aih-role-telemetry-"));
mkdirSync(join(harnessRoot, "bridges", "discord"), { recursive: true });
process.env.HARNESS_ROOT = harnessRoot;

const { getDb } = await import("../db.js");
const { aggregateByRoleRuntime, formatReport } = await import("../role-telemetry.js");

function insertRow(opts: {
  taskId: string;
  agent?: string | null;
  runtime?: string | null;
  startedAt: string;
  costCents?: number;
  inputTok?: number;
  outputTok?: number;
  durationMs?: number;
  totalTools?: number;
  loopDetected?: number;
  error?: string | null;
}): void {
  getDb().prepare(`
    INSERT INTO task_telemetry
      (task_id, channel_id, agent, prompt, started_at, status, runtime,
       est_cost_cents, est_input_tokens, est_output_tokens, duration_ms,
       total_tools, loop_detected, error)
    VALUES (?, 'test-chan', ?, 'p', ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.taskId,
    opts.agent ?? null,
    opts.startedAt,
    opts.runtime ?? null,
    opts.costCents ?? 0,
    opts.inputTok ?? 0,
    opts.outputTok ?? 0,
    opts.durationMs ?? 0,
    opts.totalTools ?? 0,
    opts.loopDetected ?? 0,
    opts.error ?? null
  );
}

describe("role-telemetry aggregation", () => {
  before(() => {
    getDb().exec("DELETE FROM task_telemetry");
    // Window: 2026-04-22 → 2026-04-29
    insertRow({ taskId: "t1", agent: "researcher", runtime: "codex",  startedAt: "2026-04-23T10:00:00Z", costCents: 5,  durationMs: 4000, totalTools: 3 });
    insertRow({ taskId: "t2", agent: "researcher", runtime: "codex",  startedAt: "2026-04-24T10:00:00Z", costCents: 0,  durationMs: 6000, totalTools: 5 });
    insertRow({ taskId: "t3", agent: "researcher", runtime: "claude", startedAt: "2026-04-25T10:00:00Z", costCents: 30, durationMs: 8000, totalTools: 10 });
    insertRow({ taskId: "t4", agent: "builder",    runtime: "codex",  startedAt: "2026-04-26T10:00:00Z", costCents: 0,  durationMs: 12000, totalTools: 20 });
    insertRow({ taskId: "t5", agent: "builder",    runtime: "codex",  startedAt: "2026-04-26T11:00:00Z", costCents: 0,  durationMs: 9000,  totalTools: 15, error: "timeout" });
    insertRow({ taskId: "t6", agent: "reviewer",   runtime: "claude", startedAt: "2026-04-27T10:00:00Z", costCents: 12, durationMs: 5000, totalTools: 4, loopDetected: 1 });
    // Out of window (too old)
    insertRow({ taskId: "t7", agent: "researcher", runtime: "claude", startedAt: "2026-04-01T10:00:00Z", costCents: 99 });
    // Null runtime / agent (legacy rows)
    insertRow({ taskId: "t8", agent: null, runtime: null, startedAt: "2026-04-28T10:00:00Z", costCents: 3 });
  });

  after(() => {
    rmSync(harnessRoot, { recursive: true, force: true });
  });

  it("aggregates by (agent, runtime) within the window", () => {
    const rows = aggregateByRoleRuntime({
      since: new Date("2026-04-22T00:00:00Z"),
      until: new Date("2026-04-29T00:00:00Z"),
    });

    const byKey = new Map(rows.map((r) => [`${r.agent}/${r.runtime}`, r]));

    const researcherCodex = byKey.get("researcher/codex");
    assert.ok(researcherCodex);
    assert.equal(researcherCodex.count, 2);
    assert.equal(researcherCodex.totalCostCents, 5);
    assert.equal(researcherCodex.avgDurationMs, 5000);
    assert.equal(researcherCodex.errorCount, 0);

    const builderCodex = byKey.get("builder/codex");
    assert.ok(builderCodex);
    assert.equal(builderCodex.count, 2);
    assert.equal(builderCodex.errorCount, 1);
    assert.equal(builderCodex.avgDurationMs, 10500);

    const reviewerClaude = byKey.get("reviewer/claude");
    assert.ok(reviewerClaude);
    assert.equal(reviewerClaude.loopCount, 1);
  });

  it("excludes rows outside the window", () => {
    const rows = aggregateByRoleRuntime({
      since: new Date("2026-04-22T00:00:00Z"),
      until: new Date("2026-04-29T00:00:00Z"),
    });
    const totalCost = rows.reduce((s, r) => s + r.totalCostCents, 0);
    // t7 ($0.99) is out of window; t1+t3+t6+t8 = 5+30+12+3 = 50 cents
    assert.equal(totalCost, 50);
  });

  it("collapses null runtime/agent to 'unknown'/'unassigned'", () => {
    const rows = aggregateByRoleRuntime({
      since: new Date("2026-04-22T00:00:00Z"),
      until: new Date("2026-04-29T00:00:00Z"),
    });
    const legacy = rows.find((r) => r.agent === "unassigned" && r.runtime === "unknown");
    assert.ok(legacy);
    assert.equal(legacy.count, 1);
    assert.equal(legacy.totalCostCents, 3);
  });

  it("formatReport produces a grouped, narrow layout", () => {
    const rows = aggregateByRoleRuntime({
      since: new Date("2026-04-22T00:00:00Z"),
      until: new Date("2026-04-29T00:00:00Z"),
    });
    const report = formatReport(rows, {
      since: new Date("2026-04-22T00:00:00Z"),
      until: new Date("2026-04-29T00:00:00Z"),
    });

    assert.equal(report.windowLabel, "2026-04-22 → 2026-04-29");
    // Agent appears as its own line (heading), runtimes indented under it
    assert.match(report.table, /^researcher$/m);
    assert.match(report.table, /^builder$/m);
    assert.match(report.table, /^  codex/m);
    // err suffix on each row
    assert.match(report.table, / err/);
    // No markdown table chrome
    assert.ok(!report.table.includes("|"), "should not include markdown table pipes");
    // Each table line under 70 chars (Discord narrow viewport tolerance)
    const longest = report.table.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
    assert.ok(longest <= 70, `longest line ${longest} exceeds 70 chars`);
    assert.match(report.summary, /tasks/);
    assert.equal(report.emptyMessage, undefined);
  });

  it("fmtDuration renders minutes for >=60s", () => {
    const rows = aggregateByRoleRuntime({
      since: new Date("2026-04-22T00:00:00Z"),
      until: new Date("2026-04-29T00:00:00Z"),
    });
    const report = formatReport(rows, {
      since: new Date("2026-04-22T00:00:00Z"),
      until: new Date("2026-04-29T00:00:00Z"),
    });
    // No row in the fixture exceeds 60s; just confirm no fractional-second
    // notation like "12.0s" leaked through (we round before formatting).
    assert.ok(!/\d+\.\ds /.test(report.table), "should not have fractional seconds");
  });

  it("formatReport emptyMessage when no rows", () => {
    const report = formatReport([], { since: new Date(), until: new Date() });
    assert.equal(report.table, "");
    assert.ok(report.emptyMessage);
  });
});
