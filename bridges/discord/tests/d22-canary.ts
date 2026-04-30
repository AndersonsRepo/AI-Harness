/**
 * D2.1 + D2.2 Canary — exercises the buildCodexConfig + codex-runner.py
 * pipeline for reviewer and tester after routing them to Codex. Reviewer
 * has no MCP allowlist (validates the read-only sandbox path); tester
 * has vault MCP access (validates D5.1 fix on a second role beyond
 * researcher).
 *
 * Run with: tsx bridges/discord/tests/d22-canary.ts
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexConfig } from "../codex-config.js";
import {
  registerInstance,
  recordCodexResult,
  getCompletedSummary,
  finalizeInstance,
} from "../instance-monitor.js";

const HARNESS_ROOT = "/Users/andersonedmond/Desktop/AI-Harness-private-runtime";
process.env.HARNESS_ROOT = HARNESS_ROOT;
process.chdir(HARNESS_ROOT);

const CHANNEL_ID = "1499234537090322443";

interface CanaryCase {
  agent: string;
  prompt: string;
  expectMcp: boolean; // whether the agent's whitelist allows vault MCP
}

const CASES: CanaryCase[] = [
  {
    agent: "reviewer",
    prompt:
      "Look at bridges/discord/role-policy.ts. In one paragraph, summarize " +
      "what getPreferredRuntimeForAgent does and which agent names it routes " +
      "to Codex. Use Read or Grep — don't call any MCP tools.",
    expectMcp: false,
  },
  {
    agent: "tester",
    prompt:
      "Use mcp__vault__vault_search to find learnings tagged 'codex' (limit 2). " +
      "Then briefly state the count of results and the title of the first one.",
    expectMcp: true,
  },
];

interface CanaryResult {
  agent: string;
  rc: number;
  mcpEvents: number;
  mcpSucceeded: number;
  mcpCancelled: number;
  totalTools: number;
  toolNames: string[];
  responseLen: number;
  elapsedMs: number;
}

async function runCanary(c: CanaryCase): Promise<CanaryResult> {
  const taskId = `canary-d22-${c.agent}-${Date.now()}`;
  const cfg = await buildCodexConfig({
    channelId: CHANNEL_ID,
    prompt: c.prompt,
    agentName: c.agent,
    taskId,
    skipSessionResume: true,
  });

  const tmp = mkdtempSync(join(tmpdir(), `canary-d22-${c.agent}-`));
  const outFile = join(tmp, "out.json");
  const promptFile = join(tmp, "prompt.txt");
  const streamDir = join(tmp, "stream");
  writeFileSync(promptFile, cfg.prompt);

  registerInstance({
    taskId,
    channelId: CHANNEL_ID,
    agent: c.agent,
    runtime: "codex",
    prompt: c.prompt,
    pid: 0,
  });

  const runnerArgs = [
    `${HARNESS_ROOT}/bridges/discord/codex-runner.py`,
    outFile,
    "--timeout", "180",
    "--prompt-file", promptFile,
    "--stream-dir", streamDir,
    ...cfg.runnerArgs,
  ];

  const t0 = Date.now();
  const child = spawn("/opt/homebrew/bin/python3", runnerArgs, {
    env: cfg.env,
    cwd: cfg.cwd,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const rc: number = await new Promise((res) =>
    child.on("close", (code) => res(code ?? 1)),
  );
  const elapsedMs = Date.now() - t0;

  if (!existsSync(outFile)) {
    finalizeInstance(taskId, "failed");
    return {
      agent: c.agent, rc, mcpEvents: 0, mcpSucceeded: 0, mcpCancelled: 0,
      totalTools: 0, toolNames: [], responseLen: 0, elapsedMs,
    };
  }

  const result = JSON.parse(readFileSync(outFile, "utf-8"));
  const stdout: string = result.stdout || "";

  let mcpEvents = 0, mcpSucceeded = 0, mcpCancelled = 0;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: any;
    try { ev = JSON.parse(t); } catch { continue; }
    if (ev?.type === "item.completed" && ev.item?.type === "mcp_tool_call") {
      mcpEvents++;
      if (ev.item.status === "completed" && !ev.item.error) mcpSucceeded++;
      if (String(ev.item.error?.message || "").includes("user cancelled")) mcpCancelled++;
    }
  }

  recordCodexResult(taskId, stdout);
  const summary = getCompletedSummary(taskId);
  finalizeInstance(taskId, "completed");

  return {
    agent: c.agent,
    rc: result.returncode,
    mcpEvents,
    mcpSucceeded,
    mcpCancelled,
    totalTools: summary?.totalTools ?? 0,
    toolNames: summary?.toolCalls.map((t) => t.toolName) ?? [],
    responseLen: (result.lastMessage || "").length,
    elapsedMs,
  };
}

async function main() {
  const results: CanaryResult[] = [];
  for (const c of CASES) {
    console.log(`[CANARY] running ${c.agent} ...`);
    results.push(await runCanary(c));
  }

  console.log("");
  console.log("══ D2.x CANARY RESULTS ════════════════════════════════════════");
  for (const r of results) {
    console.log(
      `${r.agent.padEnd(10)} rc=${r.rc} mcp=${r.mcpEvents}(ok ${r.mcpSucceeded}, cancelled ${r.mcpCancelled}) ` +
      `tools=${r.totalTools} respLen=${r.responseLen} elapsed=${(r.elapsedMs / 1000).toFixed(1)}s`,
    );
    if (r.toolNames.length) console.log(`           toolNames=${JSON.stringify(r.toolNames)}`);
  }
  console.log("══════════════════════════════════════════════════════════════");

  const allOk = results.every((r, i) => {
    const c = CASES[i]!;
    if (r.rc !== 0) return false;
    if (r.mcpCancelled > 0) return false; // never want a cancellation
    if (c.expectMcp && r.mcpSucceeded === 0) return false;
    if (r.responseLen < 20) return false; // sanity: agent produced something
    return true;
  });

  console.log(allOk ? "PASS — D2.1 + D2.2 canary green" : "FAIL — see above");
  process.exit(allOk ? 0 : 2);
}

main().catch((err) => {
  console.error("[CANARY] uncaught:", err);
  process.exit(1);
});
