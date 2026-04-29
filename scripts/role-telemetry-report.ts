/**
 * Per-role Claude vs Codex telemetry report.
 *
 * Surfaces actual cost/duration/error-rate per (agent, runtime) over a
 * date window so the operator can spot quality drift after a runtime
 * flip and decide whether to roll back.
 *
 * Usage:
 *   HARNESS_ROOT=$(pwd) npx tsx scripts/role-telemetry-report.ts
 *   HARNESS_ROOT=$(pwd) npx tsx scripts/role-telemetry-report.ts --days 14
 *   HARNESS_ROOT=$(pwd) npx tsx scripts/role-telemetry-report.ts --since 2026-04-15 --until 2026-04-29
 */

import { aggregateByRoleRuntime, formatReport } from "../bridges/discord/role-telemetry.js";

function parseArgs(argv: string[]): { since?: Date; until?: Date } {
  let days: number | undefined;
  let since: Date | undefined;
  let until: Date | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") days = Number(argv[++i]);
    else if (a === "--since") since = new Date(argv[++i]);
    else if (a === "--until") until = new Date(argv[++i]);
  }
  if (days != null && !Number.isNaN(days) && days > 0) {
    since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }
  return { since, until };
}

const { since, until } = parseArgs(process.argv.slice(2));

const rows = aggregateByRoleRuntime({ since, until });
const report = formatReport(rows, { since, until });

console.log(`Role telemetry — ${report.windowLabel}`);
console.log("");
if (report.emptyMessage) {
  console.log(report.emptyMessage);
} else {
  console.log(report.table);
  console.log("");
  console.log(report.summary);
}
