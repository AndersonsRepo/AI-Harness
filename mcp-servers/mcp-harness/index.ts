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
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
      const launchdLoaded = safeExec(`launchctl list com.aiharness.heartbeat.${task.name} 2>/dev/null`);
      const loaded = !launchdLoaded.includes("unavailable") && !launchdLoaded.includes("Could not find");

      lines.push(`## ${task.name}`);
      lines.push(`Description: ${task.description}`);
      lines.push(`Type: ${task.type} | Schedule: ${task.schedule} | Enabled: ${task.enabled}`);
      lines.push(`Launchd: ${loaded ? "loaded" : "not loaded"}`);
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
      return {
        content: [{
          type: "text" as const,
          text: `Task "${name}" ${enabled ? "enabled" : "disabled"}. Note: launchctl load/unload may be needed for the change to take effect.`,
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
