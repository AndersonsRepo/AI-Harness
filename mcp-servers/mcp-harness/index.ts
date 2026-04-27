#!/usr/bin/env node
/**
 * MCP Harness Server
 *
 * Exposes AI Harness infrastructure as MCP tools: health checks, learning
 * digests, heartbeat task management, context preview, skill/agent discovery.
 *
 * Separate from mcp-vault (which handles vault CRUD + semantic search).
 * This server handles everything else — the operational layer.
 *
 * IMPORTANT: Never use console.log in stdio MCP servers — it corrupts the
 * JSON-RPC stream. Use console.error for debug logging.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
} from "fs";
import { join, basename } from "path";
import { execSync } from "child_process";

// ─── Configuration ───────────────────────────────────────────────────

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const VAULT_DIR = join(HARNESS_ROOT, "vault");
const LEARNINGS_DIR = join(VAULT_DIR, "learnings");
const SKILLS_DIR = join(HARNESS_ROOT, ".claude", "skills");
const AGENTS_DIR = join(HARNESS_ROOT, ".claude", "agents");
const HEARTBEAT_DIR = join(HARNESS_ROOT, "heartbeat-tasks");
const HEARTBEAT_SCRIPTS = join(HEARTBEAT_DIR, "scripts");
const HEARTBEAT_LOGS = join(HEARTBEAT_DIR, "logs");
const CONTEXT_LOG_DIR = join(HARNESS_ROOT, "context-log");
const DB_PATH = join(HARNESS_ROOT, "bridges", "discord", "harness.db");
const PID_FILE = join(HARNESS_ROOT, "bridges", "discord", ".bot.pid");

// ─── Helpers ─────────────────────────────────────────────────────────

function parseFrontmatter(content: string): Record<string, any> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const result: Record<string, any> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: any = line.slice(colonIdx + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((s: string) => s.trim().replace(/^["']|["']$/g, ""));
    } else if (/^\d+$/.test(value)) {
      value = parseInt(value, 10);
    }
    result[key] = value;
  }
  return result;
}

function safeExec(cmd: string, timeoutMs: number = 10000): string {
  try {
    return execSync(cmd, { timeout: timeoutMs, encoding: "utf-8" }).trim();
  } catch {
    return "(unavailable)";
  }
}

function isPidAlive(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const { execSync } = require("child_process");
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: "utf-8", timeout: 5000 });
      return out.includes(String(pid));
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getSchedulerStatus(taskName: string): boolean {
  const label = `com.aiharness.heartbeat.${taskName}`;
  if (process.platform === "darwin") {
    const out = safeExec(`launchctl list ${label} 2>/dev/null`);
    return !out.includes("unavailable") && !out.includes("Could not find");
  }
  if (process.platform === "win32") {
    const schtaskName = `\\${label.replace(/\./g, "\\")}`;
    const out = safeExec(`schtasks /Query /TN "${schtaskName}" 2>nul`);
    return !out.includes("unavailable") && !out.includes("ERROR");
  }
  return false;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n*/, "");
}

// ─── Server Setup ────────────────────────────────────────────────────

const server = new McpServer({
  name: "harness",
  version: "1.0.0",
});

// ─── Tool: harness_health ────────────────────────────────────────────

server.tool(
  "harness_health",
  "Run a health check of the AI Harness system. Returns bot status, database info, heartbeat task states, vault stats, and truncation metrics.",
  {
    scope: z.enum(["full", "quick", "bot", "db", "heartbeat", "vault", "truncation"])
      .optional()
      .default("full")
      .describe("Which subsystems to check"),
  },
  async ({ scope }) => {
    const sections: string[] = [];

    // Bot check
    if (["full", "quick", "bot"].includes(scope)) {
      let botStatus = "STOPPED";
      let botPid = "—";
      if (existsSync(PID_FILE)) {
        const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
        if (pid && isPidAlive(pid)) {
          botStatus = "RUNNING";
          botPid = String(pid);
        } else {
          botStatus = "STALE PID";
        }
      }
      sections.push(`## Bot\nStatus: ${botStatus}\nPID: ${botPid}`);
    }

    // Database check
    if (["full", "db"].includes(scope)) {
      if (existsSync(DB_PATH)) {
        const size = statSync(DB_PATH).size;
        const sizeStr = size > 1024 * 1024
          ? `${(size / 1024 / 1024).toFixed(1)}MB`
          : `${(size / 1024).toFixed(0)}KB`;
        const tables = safeExec(`sqlite3 "${DB_PATH}" "SELECT name FROM sqlite_master WHERE type='table'" 2>/dev/null`);
        const tableList = tables.split("\n").filter(Boolean);

        const counts: string[] = [];
        for (const table of tableList) {
          // Validate table name: alphanumeric + underscore only (prevents SQL injection)
          if (!/^[a-zA-Z_]\w*$/.test(table)) continue;
          const count = safeExec(`sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM ${table}" 2>/dev/null`);
          counts.push(`  ${table}: ${count} rows`);
        }
        sections.push(`## Database\nPath: harness.db (${sizeStr})\nTables: ${tableList.length}\n${counts.join("\n")}`);
      } else {
        sections.push("## Database\nStatus: NOT FOUND");
      }
    }

    // Heartbeat check
    if (["full", "quick", "heartbeat"].includes(scope)) {
      const tasks = getHeartbeatStates();
      const failures = tasks.filter((t) => t.consecutiveFailures > 0);
      const lines = [`## Heartbeat Tasks (${tasks.length} total, ${failures.length} with failures)`];
      for (const t of tasks) {
        const failStr = t.consecutiveFailures > 0 ? ` [${t.consecutiveFailures} failures]` : "";
        lines.push(`  ${t.name}: last run ${t.lastRun || "never"}${failStr}`);
      }
      sections.push(lines.join("\n"));
    }

    // Vault check
    if (["full", "quick", "vault"].includes(scope)) {
      const stats = getVaultStats();
      const lines = [
        `## Vault`,
        `Total learnings: ${stats.total}`,
        `By type: ${Object.entries(stats.byType).map(([k, v]) => `${k}: ${v}`).join(", ")}`,
        `By status: ${Object.entries(stats.byStatus).map(([k, v]) => `${k}: ${v}`).join(", ")}`,
        `Promotion candidates: ${stats.promotionCandidates}`,
      ];
      if (stats.topRecurring.length > 0) {
        lines.push(`Top recurring:`);
        for (const r of stats.topRecurring) {
          lines.push(`  ${r.id}: "${r.title}" (count: ${r.recurrence})`);
        }
      }
      sections.push(lines.join("\n"));
    }

    // Truncation check
    if (["full", "truncation"].includes(scope)) {
      const statsFile = join(CONTEXT_LOG_DIR, "truncation-stats.json");
      if (existsSync(statsFile)) {
        try {
          const stats = JSON.parse(readFileSync(statsFile, "utf-8"));
          const lines = [`## Truncation Monitor`];
          let totalCritical = 0;
          for (const [source, data] of Object.entries(stats.bySource) as any) {
            const status = data.criticalCount > 0 ? "WARN" : "OK";
            lines.push(`  ${source}: ${data.count} events, avg ${data.avgPercentLost}% lost, ${data.criticalCount} critical [${status}]`);
            totalCritical += data.criticalCount;
          }
          lines.push(`Total critical: ${totalCritical}`);
          sections.push(lines.join("\n"));
        } catch {
          sections.push("## Truncation Monitor\nNo data available");
        }
      } else {
        sections.push("## Truncation Monitor\nNo data yet (stats file not created)");
      }
    }

    const report = `# AI Harness Health Report\n\n${sections.join("\n\n")}`;
    return { content: [{ type: "text" as const, text: report }] };
  }
);

// ─── Tool: harness_digest ────────────────────────────────────────────

server.tool(
  "harness_digest",
  "Generate a summary of vault learnings for a date range. Returns counts, categories, key learnings, and promotion candidates.",
  {
    startDate: z.string().optional().describe("Start date (YYYY-MM-DD). Defaults to today."),
    endDate: z.string().optional().describe("End date (YYYY-MM-DD). Defaults to today."),
    includeContent: z.boolean().optional().default(false).describe("Include full learning content (not just summaries)"),
  },
  async ({ startDate, endDate, includeContent }) => {
    const today = new Date().toISOString().slice(0, 10);
    const start = startDate || today;
    const end = endDate || today;

    if (!existsSync(LEARNINGS_DIR)) {
      return { content: [{ type: "text" as const, text: "No learnings directory found." }] };
    }

    const files = readdirSync(LEARNINGS_DIR).filter((f) => f.endsWith(".md"));
    const inRange: Array<{ id: string; fm: Record<string, any>; body: string }> = [];
    const byCategory: Record<string, number> = {};
    const byType: Record<string, number> = {};

    for (const file of files) {
      const content = readFileSync(join(LEARNINGS_DIR, file), "utf-8");
      const fm = parseFrontmatter(content);
      if (!fm) continue;

      const lastSeen = fm["last-seen"] || fm["logged"]?.slice(0, 10) || "";
      if (lastSeen >= start && lastSeen <= end) {
        const body = stripFrontmatter(content).trim();
        inRange.push({ id: fm.id || file, fm, body });
        const cat = fm.category || "unknown";
        const type = fm.type || "unknown";
        byCategory[cat] = (byCategory[cat] || 0) + 1;
        byType[type] = (byType[type] || 0) + 1;
      }
    }

    const lines: string[] = [
      `# Learning Digest: ${start}${start !== end ? ` to ${end}` : ""}`,
      "",
      `**${inRange.length} entries** in range`,
      "",
      `### By Type`,
      ...Object.entries(byType).map(([k, v]) => `- ${k}: ${v}`),
      "",
      `### By Category`,
      ...Object.entries(byCategory).map(([k, v]) => `- ${k}: ${v}`),
    ];

    if (inRange.length > 0) {
      lines.push("", "### Entries");
      // Sort by recurrence descending
      inRange.sort((a, b) => ((b.fm["recurrence-count"] || 1) as number) - ((a.fm["recurrence-count"] || 1) as number));

      for (const entry of inRange) {
        const recurrence = entry.fm["recurrence-count"] || 1;
        const heading = entry.body.match(/^#\s+(.+)$/m);
        const title = heading ? heading[1] : entry.id;
        const promotable = recurrence >= 3 && entry.fm.status !== "promoted" ? " [PROMOTE CANDIDATE]" : "";

        if (includeContent) {
          lines.push(`\n#### ${entry.id} (recurrence: ${recurrence})${promotable}`);
          lines.push(entry.body.slice(0, 800));
        } else {
          lines.push(`- **${entry.id}**: ${title} (recurrence: ${recurrence})${promotable}`);
        }
      }
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Tool: harness_heartbeat_list ────────────────────────────────────

server.tool(
  "harness_heartbeat_list",
  "List all heartbeat (scheduled background) tasks with their configuration, state, and last run info.",
  {},
  async () => {
    const tasks = getHeartbeatConfigs();
    if (tasks.length === 0) {
      return { content: [{ type: "text" as const, text: "No heartbeat tasks found." }] };
    }

    const lines = ["# Heartbeat Tasks", ""];
    for (const task of tasks) {
      const state = getTaskState(task.name);
      const schedulerLoaded = getSchedulerStatus(task.name);

      lines.push(`## ${task.name}`);
      lines.push(`Description: ${task.description}`);
      lines.push(`Type: ${task.type} | Schedule: ${task.schedule} | Enabled: ${task.enabled}`);
      lines.push(`Scheduler: ${schedulerLoaded ? "loaded" : "not loaded"}`);
      if (state) {
        lines.push(`Last run: ${state.lastRun || "never"}`);
        lines.push(`Last result: ${state.lastResult || "unknown"}`);
        lines.push(`Total runs: ${state.totalRuns || 0}`);
        if (state.consecutiveFailures > 0) {
          lines.push(`Consecutive failures: ${state.consecutiveFailures}`);
        }
        if (state.lastOutputSummary) {
          lines.push(`Last output: ${state.lastOutputSummary.slice(0, 200)}`);
        }
      }
      lines.push("");
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Tool: harness_heartbeat_toggle ──────────────────────────────────

server.tool(
  "harness_heartbeat_toggle",
  "Enable or disable a heartbeat task by updating its config file.",
  {
    name: z.string().describe("Task name (e.g., 'deploy-monitor')"),
    enabled: z.boolean().describe("Set to true to enable, false to disable"),
  },
  async ({ name, enabled }) => {
    const configFile = join(HEARTBEAT_DIR, `${name}.json`);
    if (!existsSync(configFile)) {
      return { content: [{ type: "text" as const, text: `Task "${name}" not found.` }] };
    }

    try {
      const config = JSON.parse(readFileSync(configFile, "utf-8"));
      config.enabled = enabled;
      writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");

      // Reset failure counter on re-enable so task doesn't immediately auto-pause
      if (enabled) {
        const stateFile = join(HEARTBEAT_DIR, `${name}.state.json`);
        if (existsSync(stateFile)) {
          try {
            const state = JSON.parse(readFileSync(stateFile, "utf-8"));
            state.consecutive_failures = 0;
            writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
          } catch { /* state file parse error is non-fatal */ }
        }
      }

      // Sync scheduler (launchd/schtasks) state with JSON config
      let schedulerMsg = "";
      const label = `com.aiharness.heartbeat.${name}`;

      if (process.platform === "darwin") {
        const home = process.env.HOME || "";
        const plistPath = join(home, "Library", "LaunchAgents", `${label}.plist`);
        if (existsSync(plistPath)) {
          if (enabled) {
            const result = safeExec(`launchctl load "${plistPath}"`);
            schedulerMsg = result === "(unavailable)" ? " (warning: plist load failed)" : " Plist loaded.";
          } else {
            safeExec(`launchctl unload "${plistPath}"`);
            schedulerMsg = " Plist unloaded.";
          }
        } else {
          schedulerMsg = " (no plist found — run generate-plist.py to create one)";
        }
      } else if (process.platform === "win32") {
        const schtaskName = `\\${label.replace(/\./g, "\\")}`;
        if (enabled) {
          safeExec(`schtasks /Change /TN "${schtaskName}" /ENABLE`);
          schedulerMsg = " Scheduled task enabled.";
        } else {
          safeExec(`schtasks /Change /TN "${schtaskName}" /DISABLE`);
          schedulerMsg = " Scheduled task disabled.";
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: `Task "${name}" ${enabled ? "enabled" : "disabled"}.${schedulerMsg}`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error updating task: ${err.message}` }] };
    }
  }
);

// ─── Tool: harness_heartbeat_run ─────────────────────────────────────

server.tool(
  "harness_heartbeat_run",
  "Manually trigger a heartbeat task and return its output.",
  {
    name: z.string().describe("Task name to run (e.g., 'health-check')"),
  },
  async ({ name }) => {
    const configFile = join(HEARTBEAT_DIR, `${name}.json`);
    if (!existsSync(configFile)) {
      return { content: [{ type: "text" as const, text: `Task "${name}" not found.` }] };
    }

    try {
      const config = JSON.parse(readFileSync(configFile, "utf-8"));
      if (config.type === "script") {
        const scriptPath = join(HEARTBEAT_SCRIPTS, config.script);
        if (!existsSync(scriptPath)) {
          return { content: [{ type: "text" as const, text: `Script not found: ${config.script}` }] };
        }
        const output = safeExec(
          `HARNESS_ROOT="${HARNESS_ROOT}" python3 "${scriptPath}" 2>&1`,
          30000
        );
        return { content: [{ type: "text" as const, text: `# ${name} output\n\n\`\`\`\n${output}\n\`\`\`` }] };
      } else {
        return { content: [{ type: "text" as const, text: `Task type "${config.type}" cannot be run directly via MCP.` }] };
      }
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error running task: ${err.message}` }] };
    }
  }
);

// ─── Tool: harness_heartbeat_create ─────────────────────────────────

server.tool(
  "harness_heartbeat_create",
  "Create a new heartbeat (scheduled background) task. Writes JSON config and optionally generates + installs the launchd plist.",
  {
    name: z.string().describe("Task name (kebab-case, e.g., 'my-task')"),
    description: z.string().describe("Short description of what this task does"),
    type: z.enum(["script", "prompt"]).describe("'script' runs a Python script, 'prompt' runs a Claude prompt"),
    schedule: z.string().describe("Interval (e.g., '30m', '6h', '24h') or cron expression (e.g., '0 8 * * 1-5')"),
    scriptOrPrompt: z.string().describe("For type=script: script filename in heartbeat-tasks/scripts/. For type=prompt: the Claude prompt text"),
    notify: z.enum(["discord", "none"]).optional().default("discord").describe("Notification target"),
    discordChannel: z.string().optional().default("heartbeat-status").describe("Discord channel name for notifications"),
    allowedTools: z.array(z.string()).optional().describe("Allowed tools for prompt-type tasks"),
    activeHours: z.object({
      start: z.string(),
      end: z.string(),
    }).optional().describe("Active hours window, e.g., {start: '07:00', end: '23:00'}"),
    installPlist: z.boolean().optional().default(true).describe("Generate and load the launchd plist"),
  },
  async ({ name, description, type, schedule, scriptOrPrompt, notify, discordChannel, allowedTools, activeHours, installPlist }) => {
    const configFile = join(HEARTBEAT_DIR, `${name}.json`);
    if (existsSync(configFile)) {
      return { content: [{ type: "text" as const, text: `Task "${name}" already exists. Delete it first or choose a different name.` }] };
    }

    try {
      // Build task config
      const isCron = schedule.includes(" ") && schedule.split(" ").length === 5;
      const config: Record<string, any> = {
        name,
        description,
        type,
        notify,
        discord_channel: discordChannel,
        enabled: true,
      };

      if (isCron) {
        config.cron = schedule;
      } else {
        config.schedule = schedule;
      }

      if (type === "script") {
        config.script = scriptOrPrompt;
      } else {
        config.prompt = scriptOrPrompt;
        if (allowedTools?.length) {
          config.allowed_tools = allowedTools;
        }
      }

      if (activeHours) {
        config.activeHours = activeHours;
      }

      writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");

      // Generate and install plist if requested
      let plistMsg = "";
      if (installPlist) {
        const generateScript = join(HEARTBEAT_SCRIPTS, "generate-plist.py");
        if (existsSync(generateScript)) {
          const result = safeExec(
            `HARNESS_ROOT="${HARNESS_ROOT}" python3 "${generateScript}" "${name}" --install 2>&1`,
            15000
          );
          plistMsg = result.includes("unavailable") || result.includes("Error")
            ? ` Warning: plist generation issue: ${result.slice(0, 200)}`
            : " Plist generated and loaded.";
        } else {
          plistMsg = " (generate-plist.py not found — create plist manually)";
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: `Task "${name}" created successfully.${plistMsg}\n\nConfig: ${configFile}`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error creating task: ${err.message}` }] };
    }
  }
);

// ─── Tool: harness_heartbeat_delete ─────────────────────────────────

server.tool(
  "harness_heartbeat_delete",
  "Delete a heartbeat task: unload plist, remove config/state/plist files.",
  {
    name: z.string().describe("Task name to delete"),
    confirm: z.boolean().describe("Must be true to confirm deletion"),
  },
  async ({ name, confirm }) => {
    if (!confirm) {
      return { content: [{ type: "text" as const, text: `Deletion not confirmed. Set confirm=true to delete "${name}".` }] };
    }

    const configFile = join(HEARTBEAT_DIR, `${name}.json`);
    if (!existsSync(configFile)) {
      return { content: [{ type: "text" as const, text: `Task "${name}" not found.` }] };
    }

    try {
      const removed: string[] = [];
      const label = `com.aiharness.heartbeat.${name}`;
      const home = process.env.HOME || "";
      const plistPath = join(home, "Library", "LaunchAgents", `${label}.plist`);

      // Unload and remove plist
      if (existsSync(plistPath)) {
        safeExec(`launchctl unload "${plistPath}"`);
        const { unlinkSync } = require("fs");
        unlinkSync(plistPath);
        removed.push("plist (unloaded + removed)");
      }

      // Remove config
      const { unlinkSync } = require("fs");
      unlinkSync(configFile);
      removed.push("config");

      // Remove state file
      const stateFile = join(HEARTBEAT_DIR, `${name}.state.json`);
      if (existsSync(stateFile)) {
        unlinkSync(stateFile);
        removed.push("state");
      }

      return {
        content: [{
          type: "text" as const,
          text: `Task "${name}" deleted. Removed: ${removed.join(", ")}.`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error deleting task: ${err.message}` }] };
    }
  }
);

// ─── Tool: harness_heartbeat_logs ───────────────────────────────────

server.tool(
  "harness_heartbeat_logs",
  "Read the last N lines of a heartbeat task's log file.",
  {
    name: z.string().describe("Task name"),
    lines: z.number().optional().default(50).describe("Number of lines to read (default 50)"),
  },
  async ({ name, lines }) => {
    const logFile = join(HEARTBEAT_LOGS, `${name}.log`);
    if (!existsSync(logFile)) {
      return { content: [{ type: "text" as const, text: `No log file found for "${name}".` }] };
    }

    try {
      const output = safeExec(`tail -n ${lines} "${logFile}"`, 5000);
      return {
        content: [{
          type: "text" as const,
          text: `# ${name} logs (last ${lines} lines)\n\n\`\`\`\n${output}\n\`\`\``,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error reading logs: ${err.message}` }] };
    }
  }
);

// ─── Tool: harness_heartbeat_status ─────────────────────────────────

server.tool(
  "harness_heartbeat_status",
  "Comprehensive heartbeat health dashboard. Cross-references task configs with launchd state, flags mismatches, failures, and staleness.",
  {},
  async () => {
    try {
      const configs = getHeartbeatConfigs();
      if (configs.length === 0) {
        return { content: [{ type: "text" as const, text: "No heartbeat tasks found." }] };
      }

      const now = Date.now();
      const STALE_MS = 48 * 60 * 60 * 1000;

      const failing: string[] = [];
      const staleList: string[] = [];
      const mismatched: string[] = [];
      const healthy: string[] = [];
      const disabled: string[] = [];

      for (const task of configs) {
        const state = getTaskState(task.name);
        const plistLoaded = getSchedulerStatus(task.name);
        const lastRunTs = state?.lastRun ? new Date(state.lastRun).getTime() : 0;
        const shortDate = state?.lastRun ? state.lastRun.slice(0, 16).replace("T", " ") : "never";
        const failures = state?.consecutiveFailures || 0;

        // Check config/plist mismatch
        if (task.enabled && !plistLoaded) {
          mismatched.push(`- ${task.name}: enabled=true but plist NOT loaded`);
        } else if (!task.enabled && plistLoaded) {
          mismatched.push(`- ${task.name}: enabled=false but plist IS loaded`);
        }

        if (!task.enabled) {
          disabled.push(`- ${task.name}: disabled (last: ${shortDate}, failures: ${failures})`);
        } else if (failures >= 2) {
          failing.push(`- ${task.name}: ${failures} consecutive failures (last: ${shortDate})`);
        } else if (lastRunTs > 0 && now - lastRunTs > STALE_MS) {
          staleList.push(`- ${task.name}: no run in ${Math.round((now - lastRunTs) / 3600000)}h (last: ${shortDate})`);
        } else {
          healthy.push(`- ${task.name}: OK (last: ${shortDate}, runs: ${state?.totalRuns || 0})`);
        }
      }

      const lines: string[] = ["# Heartbeat Status Dashboard", ""];

      if (failing.length > 0) {
        lines.push(`## Failing (${failing.length})`, ...failing, "");
      }
      if (mismatched.length > 0) {
        lines.push(`## Config/Plist Mismatches (${mismatched.length})`, ...mismatched, "");
      }
      if (staleList.length > 0) {
        lines.push(`## Stale >48h (${staleList.length})`, ...staleList, "");
      }
      if (disabled.length > 0) {
        lines.push(`## Disabled (${disabled.length})`, ...disabled, "");
      }
      if (healthy.length > 0) {
        lines.push(`## Healthy (${healthy.length})`, ...healthy, "");
      }

      lines.push(`---`, `Total: ${configs.length} tasks | Healthy: ${healthy.length} | Failing: ${failing.length} | Stale: ${staleList.length} | Disabled: ${disabled.length} | Mismatched: ${mismatched.length}`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error building status: ${err.message}` }] };
    }
  }
);

// ─── Tool: harness_context_preview ───────────────────────────────────

server.tool(
  "harness_context_preview",
  "Preview what context the daemon would inject for a given prompt. Useful for debugging why the agent does or doesn't know something.",
  {
    prompt: z.string().describe("The prompt to preview context for"),
    channelId: z.string().optional().default("preview").describe("Simulated channel ID"),
  },
  async ({ prompt, channelId }) => {
    // Extract keywords the same way context-assembler does
    const stopwords = new Set([
      "a", "an", "the", "is", "are", "was", "were", "be", "been", "have", "has",
      "had", "do", "does", "did", "will", "would", "shall", "should", "may",
      "might", "must", "can", "could", "of", "at", "by", "for", "with", "about",
      "to", "from", "in", "out", "on", "off", "up", "down", "and", "but", "or",
      "if", "please", "help", "want", "need", "get", "make", "like", "it", "this",
      "that", "what", "which", "who", "how", "why", "when", "where", "not", "no",
    ]);

    const keywords = prompt
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((w) => w.length > 2 && !stopwords.has(w));

    // Search vault for relevant learnings (keyword-based — we don't have Ollama access here)
    const matches: Array<{ id: string; title: string; score: number; tags: string[] }> = [];

    if (existsSync(LEARNINGS_DIR)) {
      const files = readdirSync(LEARNINGS_DIR).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        try {
          const content = readFileSync(join(LEARNINGS_DIR, file), "utf-8");
          const fm = parseFrontmatter(content);
          if (!fm) continue;

          const tags: string[] = Array.isArray(fm.tags) ? fm.tags : [];
          const searchable = [
            ...tags,
            ...(fm["pattern-key"] || "").split("-"),
            ...(fm.area || "").split("-"),
            ...(fm.category || "").split("-"),
          ].map((t: string) => t.toLowerCase());

          let score = 0;
          for (const kw of keywords) {
            for (const token of searchable) {
              if (token.includes(kw) || kw.includes(token)) score++;
            }
          }

          if (score > 0) {
            const body = stripFrontmatter(content);
            const heading = body.match(/^#\s+(.+)$/m);
            matches.push({
              id: fm.id || file,
              title: heading ? heading[1] : file,
              score,
              tags,
            });
          }
        } catch {}
      }
    }

    matches.sort((a, b) => b.score - a.score);
    const top = matches.slice(0, 5);

    const lines = [
      `# Context Preview`,
      "",
      `**Prompt**: "${prompt.slice(0, 200)}"`,
      `**Keywords extracted**: ${keywords.join(", ") || "(none)"}`,
      `**Channel**: ${channelId}`,
      "",
      `## Keyword Matches (${matches.length} total, showing top 5)`,
      "",
      ...(top.length > 0
        ? top.map((m) => `- **${m.id}** (score: ${m.score}): ${m.title}\n  Tags: ${m.tags.join(", ")}`)
        : ["(no keyword matches)"]),
      "",
      `## Notes`,
      `- This is keyword-only preview. The actual daemon also runs semantic search via Ollama.`,
      `- Semantic results often surface entries that keyword search misses.`,
      `- Full context also includes: active project, task history, conventions, gotchas, heartbeat status, pending work.`,
    ];

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Tool: harness_skills ────────────────────────────────────────────

server.tool(
  "harness_skills",
  "List all available skills with their metadata: name, description, invocability, agent routing, model, and key features.",
  {},
  async () => {
    if (!existsSync(SKILLS_DIR)) {
      return { content: [{ type: "text" as const, text: "Skills directory not found." }] };
    }

    const skillDirs = readdirSync(SKILLS_DIR).filter((d) => {
      const skillFile = join(SKILLS_DIR, d, "SKILL.md");
      return existsSync(skillFile);
    });

    const lines = ["# Available Skills", ""];
    const invocable: string[] = [];
    const auto: string[] = [];

    for (const dir of skillDirs) {
      const content = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf-8");
      const fm = parseFrontmatter(content);
      if (!fm) continue;

      const name = fm.name || dir;
      const desc = fm.description || "(no description)";
      const userInvocable = fm["user-invocable"] === "true" || fm["user-invocable"] === true;
      const context = fm.context || "—";
      const agent = fm.agent || "—";
      const model = fm.model || "default";
      const argHint = fm["argument-hint"] || "";

      const meta: string[] = [];
      if (context !== "—") meta.push(`context: ${context}`);
      if (agent !== "—") meta.push(`agent: ${agent}`);
      if (model !== "default") meta.push(`model: ${model}`);

      const metaStr = meta.length > 0 ? ` (${meta.join(", ")})` : "";

      if (userInvocable) {
        invocable.push(`- **/${name}** ${argHint ? `\`${argHint}\`` : ""} — ${desc}${metaStr}`);
      } else {
        auto.push(`- **${name}** — ${desc}${metaStr}`);
      }
    }

    lines.push("## User-Invocable", "");
    lines.push(...(invocable.length > 0 ? invocable : ["(none)"]));
    lines.push("", "## Auto-Triggered", "");
    lines.push(...(auto.length > 0 ? auto : ["(none)"]));

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Tool: harness_agents ────────────────────────────────────────────

server.tool(
  "harness_agents",
  "List all available agent personalities with their descriptions and specializations.",
  {},
  async () => {
    if (!existsSync(AGENTS_DIR)) {
      return { content: [{ type: "text" as const, text: "Agents directory not found." }] };
    }

    const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
    const lines = ["# Available Agents", ""];

    for (const file of files) {
      const name = basename(file, ".md");
      const content = readFileSync(join(AGENTS_DIR, file), "utf-8");

      // Extract the first paragraph after any frontmatter as the description
      const body = stripFrontmatter(content).trim();
      const firstParagraph = body.split("\n\n")[0]?.replace(/^#.*\n/, "").trim() || "(no description)";

      // Check which skills route to this agent
      const routedSkills: string[] = [];
      if (existsSync(SKILLS_DIR)) {
        for (const skillDir of readdirSync(SKILLS_DIR)) {
          const skillFile = join(SKILLS_DIR, skillDir, "SKILL.md");
          if (!existsSync(skillFile)) continue;
          const skillContent = readFileSync(skillFile, "utf-8");
          const skillFm = parseFrontmatter(skillContent);
          if (skillFm?.agent === name) {
            routedSkills.push(skillFm.name || skillDir);
          }
        }
      }

      lines.push(`## ${name}`);
      lines.push(firstParagraph.slice(0, 300));
      if (routedSkills.length > 0) {
        lines.push(`\nSkills routed here: ${routedSkills.map((s) => `/${s}`).join(", ")}`);
      }
      lines.push("");
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Tool: harness_truncation_report ─────────────────────────────────

server.tool(
  "harness_truncation_report",
  "Show detailed truncation monitoring data — which subsystems are losing data, severity, and recent events.",
  {
    recentEvents: z.number().optional().default(10).describe("Number of recent events to show"),
  },
  async ({ recentEvents }) => {
    const statsFile = join(CONTEXT_LOG_DIR, "truncation-stats.json");
    const eventsFile = join(CONTEXT_LOG_DIR, "truncation-events.jsonl");
    const lines = ["# Truncation Report", ""];

    // Stats summary
    if (existsSync(statsFile)) {
      try {
        const stats = JSON.parse(readFileSync(statsFile, "utf-8"));
        lines.push(`Last updated: ${new Date(stats.lastUpdated).toISOString()}`);
        lines.push("");
        lines.push("| Source | Events | Avg % Lost | Critical |");
        lines.push("|--------|--------|-----------|----------|");

        for (const [source, data] of Object.entries(stats.bySource) as any) {
          lines.push(`| ${source} | ${data.count} | ${data.avgPercentLost}% | ${data.criticalCount} |`);
        }
      } catch {
        lines.push("Stats file exists but could not be parsed.");
      }
    } else {
      lines.push("No truncation stats file yet.");
    }

    // Recent events
    if (existsSync(eventsFile)) {
      try {
        const allLines = readFileSync(eventsFile, "utf-8").trim().split("\n").filter(Boolean);
        const recent = allLines.slice(-recentEvents);

        lines.push("", `## Recent Events (last ${recent.length})`, "");
        for (const line of recent) {
          try {
            const event = JSON.parse(line);
            const time = new Date(event.timestamp).toISOString().slice(11, 19);
            const dmg = event.structureDamaged ? " [DAMAGED]" : "";
            lines.push(
              `- **${event.severity}** ${time} ${event.source}: ${event.originalLength}→${event.truncatedLength} chars (${event.percentLost}% lost)${dmg}`
            );
          } catch {}
        }
      } catch {
        lines.push("Could not read events file.");
      }
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Heartbeat Helpers ───────────────────────────────────────────────

interface HeartbeatConfig {
  name: string;
  description: string;
  type: string;
  schedule: string;
  enabled: boolean;
}

interface HeartbeatState {
  lastRun: string | null;
  lastResult: string | null;
  lastOutputSummary: string | null;
  consecutiveFailures: number;
  totalRuns: number;
}

function getHeartbeatConfigs(): HeartbeatConfig[] {
  if (!existsSync(HEARTBEAT_DIR)) return [];
  return readdirSync(HEARTBEAT_DIR)
    .filter((f) => f.endsWith(".json") && !f.includes(".state"))
    .map((f) => {
      try {
        const config = JSON.parse(readFileSync(join(HEARTBEAT_DIR, f), "utf-8"));
        return {
          name: config.name || basename(f, ".json"),
          description: config.description || "",
          type: config.type || "unknown",
          schedule: config.schedule || config.interval_minutes ? `${config.interval_minutes}m` : "unknown",
          enabled: config.enabled !== false,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as HeartbeatConfig[];
}

function getTaskState(name: string): HeartbeatState | null {
  const stateFile = join(HEARTBEAT_DIR, `${name}.state.json`);
  if (!existsSync(stateFile)) return null;
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    return {
      lastRun: state.last_run || null,
      lastResult: state.last_result || null,
      lastOutputSummary: state.last_output_summary || null,
      consecutiveFailures: state.consecutive_failures || 0,
      totalRuns: state.total_runs || 0,
    };
  } catch {
    return null;
  }
}

function getHeartbeatStates(): Array<{ name: string; lastRun: string | null; consecutiveFailures: number }> {
  const configs = getHeartbeatConfigs();
  return configs.map((c) => {
    const state = getTaskState(c.name);
    return {
      name: c.name,
      lastRun: state?.lastRun || null,
      consecutiveFailures: state?.consecutiveFailures || 0,
    };
  });
}

// ─── Vault Helpers ───────────────────────────────────────────────────

function getVaultStats() {
  if (!existsSync(LEARNINGS_DIR)) {
    return { total: 0, byStatus: {}, byType: {}, promotionCandidates: 0, topRecurring: [] as any[] };
  }

  const files = readdirSync(LEARNINGS_DIR).filter((f) => f.endsWith(".md"));
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let promotionCandidates = 0;
  const recurring: Array<{ id: string; title: string; recurrence: number }> = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(LEARNINGS_DIR, file), "utf-8");
      const fm = parseFrontmatter(content);
      if (!fm) continue;

      const status = fm.status || "unknown";
      const type = fm.type || "unknown";
      byStatus[status] = (byStatus[status] || 0) + 1;
      byType[type] = (byType[type] || 0) + 1;

      const recurrence = (fm["recurrence-count"] || 1) as number;
      if (recurrence >= 3 && status !== "promoted" && status !== "archived") {
        promotionCandidates++;
      }

      if (recurrence >= 2) {
        const body = stripFrontmatter(content);
        const heading = body.match(/^#\s+(.+)$/m);
        recurring.push({
          id: fm.id || file,
          title: heading ? heading[1] : file,
          recurrence,
        });
      }
    } catch {}
  }

  recurring.sort((a, b) => b.recurrence - a.recurrence);
  return { total: files.length, byStatus, byType, promotionCandidates, topRecurring: recurring.slice(0, 5) };
}

// ─── Tool: harness_telemetry ──────────────────────────────────────────

server.tool(
  "harness_telemetry",
  "Query task execution telemetry — tool calls, timing, cost estimates, interventions. Use for analyzing agent performance and debugging.",
  {
    limit: z.number().optional().default(10).describe("Max results (default 10)"),
    agent: z.string().optional().describe("Filter by agent name"),
    channel_id: z.string().optional().describe("Filter by channel ID"),
  },
  async ({ limit, agent, channel_id }) => {
    const dbPath = join(HARNESS_ROOT, "bridges", "discord", "harness.db");
    if (!existsSync(dbPath)) {
      return { content: [{ type: "text" as const, text: "Database not found." }] };
    }

    try {
      let whereClause = "";
      const conditions: string[] = [];
      if (agent) conditions.push(`agent = '${agent.replace(/'/g, "''")}'`);
      if (channel_id) conditions.push(`channel_id = '${channel_id.replace(/'/g, "''")}'`);
      if (conditions.length > 0) whereClause = " WHERE " + conditions.join(" AND ");

      const query = `SELECT * FROM task_telemetry${whereClause} ORDER BY started_at DESC LIMIT ${limit}`;
      const raw = execSync(`sqlite3 -json "${dbPath}" "${query.replace(/"/g, '\\"')}"`, {
        encoding: "utf-8",
        timeout: 10000,
      }).trim();

      const rows = raw ? JSON.parse(raw) as any[] : [];

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: "No telemetry data found." }] };
      }

      const lines = ["# Task Telemetry", ""];
      for (const row of rows) {
        const cost = row.est_cost_cents ? `$${(row.est_cost_cents / 100).toFixed(4)}` : "n/a";
        const duration = row.duration_ms ? `${(row.duration_ms / 1000).toFixed(1)}s` : "n/a";
        lines.push(`## ${row.task_id}`);
        lines.push(`- **Agent**: ${row.agent || "default"}`);
        lines.push(`- **Status**: ${row.status}`);
        lines.push(`- **Duration**: ${duration}`);
        lines.push(`- **Tools**: ${row.total_tools}`);
        lines.push(`- **Tokens**: ~${row.est_input_tokens || 0} in / ~${row.est_output_tokens || 0} out`);
        lines.push(`- **Cost**: ${cost}`);
        lines.push(`- **Prompt**: ${(row.prompt || "").slice(0, 100)}`);
        if (row.intervention) lines.push(`- **Intervention**: ${row.intervention}`);
        if (row.error) lines.push(`- **Error**: ${row.error.slice(0, 200)}`);
        lines.push("");
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error querying telemetry: ${err.message}` }] };
    }
  }
);

// ─── Tool: harness_channels ─────────────────────────────────────────

server.tool(
  "harness_channels",
  "Check the status of Discord bot channels — running tasks, recent completions, elapsed time, live output preview, and process health. Use this to monitor what agents are working on.",
  {
    channel: z.string().optional().describe("Filter by channel name or ID (shows all if omitted)"),
    status: z.enum(["running", "completed", "failed", "all"]).optional().default("running").describe("Task status filter"),
    limit: z.number().optional().default(5).describe("Max tasks to show"),
    live: z.boolean().optional().default(true).describe("Include live stream output preview for running tasks"),
  },
  async ({ channel, status, limit, live }) => {
    if (!existsSync(DB_PATH)) {
      return { content: [{ type: "text" as const, text: "Database not found at " + DB_PATH }] };
    }

    try {
      // Build channel name map from projects table
      const channelMap = new Map<string, string>();
      try {
        const projRaw = execSync(
          `sqlite3 -json "${DB_PATH}" "SELECT channel_id, name FROM projects"`,
          { encoding: "utf-8", timeout: 5000 }
        );
        const projects = JSON.parse(projRaw) as Array<{ channel_id: string; name: string }>;
        for (const p of projects) channelMap.set(p.channel_id, p.name);
      } catch { /* no projects table or empty */ }

      // Build WHERE clause
      const conditions: string[] = [];
      if (status !== "all") conditions.push(`status = '${status}'`);
      if (channel) {
        // Match by name (via project map) or direct ID
        const matchingIds: string[] = [];
        for (const [id, name] of channelMap) {
          if (name.toLowerCase().includes(channel.toLowerCase())) matchingIds.push(id);
        }
        if (/^\d+$/.test(channel)) matchingIds.push(channel);
        if (matchingIds.length > 0) {
          conditions.push(`channel_id IN (${matchingIds.map(id => `'${id}'`).join(",")})`);
        } else {
          return { content: [{ type: "text" as const, text: `No channel found matching "${channel}".` }] };
        }
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const query = `SELECT id, channel_id, status, agent, step_count, max_steps, pid, output_file, substr(prompt, 1, 200) as prompt, created_at, updated_at, last_error FROM task_queue ${where} ORDER BY created_at DESC LIMIT ${limit}`;

      const raw = execSync(`sqlite3 -json "${DB_PATH}" "${query.replace(/"/g, '\\"')}"`, {
        encoding: "utf-8",
        timeout: 10000,
      });

      const tasks = JSON.parse(raw || "[]") as Array<{
        id: string;
        channel_id: string;
        status: string;
        agent: string;
        step_count: number;
        max_steps: number;
        pid: number;
        output_file: string;
        prompt: string;
        created_at: string;
        updated_at: string;
        last_error: string;
      }>;

      if (tasks.length === 0) {
        return { content: [{ type: "text" as const, text: `No ${status === "all" ? "" : status + " "}tasks found.` }] };
      }

      const lines: string[] = [`# Channel Status (${status})\n`];

      for (const task of tasks) {
        const channelName = channelMap.get(task.channel_id) || `channel-${task.channel_id.slice(-6)}`;
        const elapsed = task.created_at
          ? `${((Date.now() - new Date(task.created_at).getTime()) / 60000).toFixed(1)}min`
          : "?";

        // Check process health
        let processStatus = "";
        if (task.status === "running" && task.pid) {
          processStatus = isPidAlive(task.pid) ? "alive" : "DEAD";
        }

        lines.push(`## #${channelName}`);
        lines.push(`- **Task**: ${task.id}`);
        lines.push(`- **Status**: ${task.status}${processStatus ? ` (PID ${task.pid}: ${processStatus})` : ""}`);
        lines.push(`- **Agent**: ${task.agent || "default"}`);
        lines.push(`- **Steps**: ${task.step_count}/${task.max_steps}`);
        lines.push(`- **Elapsed**: ${elapsed}`);
        lines.push(`- **Prompt**: ${task.prompt}`);
        if (task.last_error) lines.push(`- **Error**: ${task.last_error.slice(0, 200)}`);

        // Read live stream output for running tasks
        if (live && task.status === "running" && task.output_file) {
          // output_file: .../bridges/discord/.tmp/response-TIMESTAMP-ID.json
          // stream dir:  .../bridges/discord/.tmp/streams/TIMESTAMP-ID/
          const streamDir = task.output_file
            .replace(/response-/, "streams/")
            .replace(/\.json$/, "");

          if (existsSync(streamDir)) {
            try {
              const chunks = readdirSync(streamDir).filter(f => f.startsWith("chunk-")).sort();
              lines.push(`- **Stream**: ${chunks.length} chunks`);

              // Find the last result chunk for a summary
              for (let i = chunks.length - 1; i >= 0; i--) {
                try {
                  const chunkData = JSON.parse(readFileSync(join(streamDir, chunks[i]), "utf-8"));
                  if (chunkData.type === "result" && chunkData.result) {
                    const preview = chunkData.result.slice(0, 500);
                    lines.push(`- **Latest output**:\n\`\`\`\n${preview}${chunkData.result.length > 500 ? "\n..." : ""}\n\`\`\``);
                    if (chunkData.num_turns) lines.push(`- **Turns**: ${chunkData.num_turns}`);
                    if (chunkData.total_cost_usd) lines.push(`- **Cost**: $${chunkData.total_cost_usd.toFixed(4)}`);
                    break;
                  }
                  // Show latest text delta if no result yet
                  if (chunkData.type === "content_block_delta" && chunkData.delta?.text) {
                    lines.push(`- **Live text**: ...${chunkData.delta.text.slice(-200)}`);
                    break;
                  }
                } catch { continue; }
              }
            } catch { /* stream dir unreadable */ }
          }
        }

        // Check for completed output file
        if (task.status !== "running" && task.output_file) {
          const outPath = task.output_file.startsWith("/")
            ? task.output_file
            : join(HARNESS_ROOT, "bridges", "discord", ".tmp", basename(task.output_file));
          if (existsSync(outPath)) {
            try {
              const output = JSON.parse(readFileSync(outPath, "utf-8"));
              if (output.result) {
                const preview = typeof output.result === "string"
                  ? output.result.slice(0, 300)
                  : JSON.stringify(output.result).slice(0, 300);
                lines.push(`- **Result**: ${preview}${preview.length >= 300 ? "..." : ""}`);
              }
              if (output.total_cost_usd) lines.push(`- **Cost**: $${output.total_cost_usd.toFixed(4)}`);
            } catch { /* output unreadable */ }
          }
        }

        lines.push("");
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error querying channels: ${err.message}` }] };
    }
  }
);

// ─── Tool: harness_handoff ──────────────────────────────────────────

function sqlEscape(s: string): string {
  // SQLite uses single-quote string literals; doubled single quote is the escape.
  return s.replace(/'/g, "''");
}

server.tool(
  "harness_handoff",
  [
    "Hand off the current task to another specialist agent in the project. Use this when the task needs role-specialized context, deterministic review/test gates, cross-runtime cost optimization (e.g. builder→Codex), Discord visibility per step, or auditable replay.",
    "",
    "Use the native Agent tool instead for quick read-only investigation (codebase exploration, doc fetching, plan synthesis) where in-process speed matters.",
    "",
    "After this tool call returns, finish your response normally — the handoff fires when your task completes. The receiving agent gets fresh role-tuned context, runs in its own process, and may chain further (e.g. builder → reviewer → tester via auto-injected post-chain gates).",
    "",
    "Restrictions: target_agent must be a member of the current project's agent list. Self-handoff is rejected. Depth limit applies (default 20).",
  ].join("\n"),
  {
    target_agent: z.string().describe("Name of the agent to hand off to (e.g. 'builder', 'reviewer', 'researcher')."),
    task_description: z.string().describe("What you want the receiving agent to do. Be specific — include scope, expected output, and any constraints they need to know about. Vague delegation degrades chain quality."),
    pre_handoff_text: z.string().optional().describe("Optional message to post to Discord under your name before the handoff transition (e.g. summary of what you've done so far). Leave empty if not needed."),
  },
  async ({ target_agent, task_description, pre_handoff_text }) => {
    const channelId = process.env.HARNESS_CHANNEL_ID;
    const sessionKey = process.env.HARNESS_SESSION_KEY;
    const fromAgent = process.env.HARNESS_FROM_AGENT;

    if (!channelId || !sessionKey || !fromAgent) {
      return {
        content: [{
          type: "text" as const,
          text: "Handoff unavailable: harness env vars (HARNESS_CHANNEL_ID, HARNESS_SESSION_KEY, HARNESS_FROM_AGENT) are not set. This tool requires the bot's spawn-time env to identify the chain context.",
        }],
        isError: true,
      };
    }

    if (!existsSync(DB_PATH)) {
      return {
        content: [{ type: "text" as const, text: `Database not found at ${DB_PATH}` }],
        isError: true,
      };
    }

    if (target_agent === fromAgent) {
      return {
        content: [{
          type: "text" as const,
          text: `Self-handoff rejected: ${fromAgent} cannot hand off to itself.`,
        }],
        isError: true,
      };
    }

    const sql = `
INSERT INTO handoff_queue (
  session_key, channel_id, from_agent, target_agent,
  task_description, pre_handoff_text, status
) VALUES (
  '${sqlEscape(sessionKey)}',
  '${sqlEscape(channelId)}',
  '${sqlEscape(fromAgent)}',
  '${sqlEscape(target_agent)}',
  '${sqlEscape(task_description)}',
  '${sqlEscape(pre_handoff_text ?? "")}',
  'pending'
);
SELECT last_insert_rowid();
`;

    let queuedId: string;
    try {
      const out = execSync(`sqlite3 "${DB_PATH}"`, {
        input: sql,
        encoding: "utf-8",
        timeout: 5000,
      });
      queuedId = out.trim().split("\n").pop() || "?";
    } catch (err: any) {
      return {
        content: [{
          type: "text" as const,
          text: `Failed to queue handoff: ${err.message}`,
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: [
          `Handoff queued (id=${queuedId}): ${fromAgent} → ${target_agent}`,
          ``,
          `Task: ${task_description.slice(0, 200)}${task_description.length > 200 ? "..." : ""}`,
          ``,
          `The handoff will execute when your current response completes. ${target_agent} will run in a fresh process with role-tuned context. Continue with whatever you need to communicate to the user (or leave it terse — your "pre_handoff_text" already covers what gets posted).`,
        ].join("\n"),
      }],
    };
  }
);

// ─── Start Server ────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-harness] Server started");
}

main().catch((err) => {
  console.error("[mcp-harness] Fatal:", err);
  process.exit(1);
});
