/**
 * Context Injection Daemon
 *
 * Deterministically assembles and injects relevant context into every Claude
 * invocation via --append-system-prompt. The LLM never decides what to look up —
 * it always receives a curated context window.
 *
 * Data sources (all deterministic, no LLM):
 *   - SQLite: projects, channel_configs, task_queue, dead_letter
 *   - Vault: learnings (keyword match on frontmatter), shared knowledge, conventions, gotchas
 *   - Filesystem: heartbeat state files, pending notifications
 */

import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { getDb } from "./db.js";
import { getProject, type ProjectConfig } from "./project-manager.js";
import { getChannelConfig, type ChannelConfig } from "./channel-config-store.js";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const VAULT_DIR = join(HARNESS_ROOT, "vault");
const LEARNINGS_DIR = join(VAULT_DIR, "learnings");
const SHARED_DIR = join(VAULT_DIR, "shared");
const PROJECT_KNOWLEDGE_DIR = join(SHARED_DIR, "project-knowledge");
const HEARTBEAT_DIR = join(HARNESS_ROOT, "heartbeat-tasks");
const NOTIFICATIONS_FILE = join(HEARTBEAT_DIR, "pending-notifications.jsonl");

// Token budget: target ~1000-2000 tokens. Each section has a max char limit.
const MAX_TOTAL_CHARS = 6000; // ~1500 tokens
const SECTION_LIMITS: Record<string, number> = {
  project: 400,
  channelState: 300,
  learnings: 1500,
  projectKnowledge: 800,
  taskHistory: 600,
  conventions: 600,
  gotchas: 600,
  heartbeats: 400,
  pendingWork: 300,
};

// Common English stopwords for keyword extraction
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "must", "can", "could", "of", "at", "by",
  "for", "with", "about", "against", "between", "through", "during",
  "before", "after", "above", "below", "to", "from", "up", "down",
  "in", "out", "on", "off", "over", "under", "again", "further",
  "then", "once", "here", "there", "when", "where", "why", "how",
  "all", "both", "each", "few", "more", "most", "other", "some",
  "such", "no", "nor", "not", "only", "own", "same", "so", "than",
  "too", "very", "just", "because", "as", "until", "while", "it",
  "its", "this", "that", "these", "those", "i", "me", "my", "we",
  "our", "you", "your", "he", "him", "his", "she", "her", "they",
  "them", "their", "what", "which", "who", "whom", "and", "but", "or",
  "if", "please", "help", "want", "need", "get", "make", "like",
]);

export interface AssembleContextParams {
  channelId: string;
  prompt: string;
  agentName: string;
  sessionKey: string;
  taskId: string;
}

interface VaultEntry {
  id: string;
  title: string;
  tags: string[];
  patternKey: string;
  type: string;
  status: string;
  summary: string;
  score: number;
}

// ─── Main Entry Point ────────────────────────────────────────────────

export async function assembleContext(params: AssembleContextParams): Promise<string> {
  try {
    const sections: string[] = [];
    let totalChars = 0;

    const project = getProject(params.channelId);
    const channelConfig = getChannelConfig(params.channelId);
    const keywords = extractKeywords(params.prompt);

    // Priority 1: Active project + channel config (always include)
    const projectSection = buildProjectSection(project, channelConfig, params.agentName);
    if (projectSection) {
      sections.push(projectSection);
      totalChars += projectSection.length;
    }

    // Priority 2: Relevant learnings (keyword match)
    if (totalChars < MAX_TOTAL_CHARS) {
      const learningsSection = buildLearningsSection(keywords);
      if (learningsSection) {
        sections.push(truncate(learningsSection, SECTION_LIMITS.learnings));
        totalChars += Math.min(learningsSection.length, SECTION_LIMITS.learnings);
      }
    }

    // Priority 3: Project-specific knowledge
    if (totalChars < MAX_TOTAL_CHARS && project) {
      const knowledgeSection = buildProjectKnowledgeSection(project.name);
      if (knowledgeSection) {
        sections.push(truncate(knowledgeSection, SECTION_LIMITS.projectKnowledge));
        totalChars += Math.min(knowledgeSection.length, SECTION_LIMITS.projectKnowledge);
      }
    }

    // Priority 4: Task history
    if (totalChars < MAX_TOTAL_CHARS) {
      const taskSection = buildTaskHistorySection(params.channelId);
      if (taskSection) {
        sections.push(truncate(taskSection, SECTION_LIMITS.taskHistory));
        totalChars += Math.min(taskSection.length, SECTION_LIMITS.taskHistory);
      }
    }

    // Priority 5: Conventions + tool gotchas (always load — small files)
    if (totalChars < MAX_TOTAL_CHARS) {
      const conventionsSection = buildConventionsSection();
      if (conventionsSection) {
        sections.push(truncate(conventionsSection, SECTION_LIMITS.conventions));
        totalChars += Math.min(conventionsSection.length, SECTION_LIMITS.conventions);
      }
    }

    if (totalChars < MAX_TOTAL_CHARS) {
      const gotchasSection = buildGotchasSection();
      if (gotchasSection) {
        sections.push(truncate(gotchasSection, SECTION_LIMITS.gotchas));
        totalChars += Math.min(gotchasSection.length, SECTION_LIMITS.gotchas);
      }
    }

    // Priority 6: Heartbeat status
    if (totalChars < MAX_TOTAL_CHARS) {
      const heartbeatSection = buildHeartbeatSection();
      if (heartbeatSection) {
        sections.push(truncate(heartbeatSection, SECTION_LIMITS.heartbeats));
        totalChars += Math.min(heartbeatSection.length, SECTION_LIMITS.heartbeats);
      }
    }

    // Priority 7: Pending work
    if (totalChars < MAX_TOTAL_CHARS) {
      const pendingSection = buildPendingWorkSection(params.channelId);
      if (pendingSection) {
        sections.push(truncate(pendingSection, SECTION_LIMITS.pendingWork));
        totalChars += Math.min(pendingSection.length, SECTION_LIMITS.pendingWork);
      }
    }

    if (sections.length === 0) return "";

    const contextBlock = `[CONTEXT — assembled by daemon]\n\n${sections.join("\n\n")}`;

    // Log for observability
    logContext(params.taskId, params.channelId, params.agentName, contextBlock);

    return contextBlock;
  } catch (err: any) {
    console.error(`[context-assembler] Error assembling context: ${err.message}`);
    return ""; // Fail open — never block a spawn because context assembly failed
  }
}

// ─── Section Builders ────────────────────────────────────────────────

function buildProjectSection(
  project: ProjectConfig | null,
  config: ChannelConfig | null,
  agentName: string
): string | null {
  if (!project && !config) return null;

  const lines: string[] = ["## Active Project"];

  if (project) {
    lines.push(`Name: ${project.name}`);
    lines.push(`Description: ${project.description}`);
    lines.push(`Agents: ${project.agents.join(", ")}`);
    lines.push(`Current agent: ${agentName}`);
    if (project.activeAgent && project.activeAgent !== agentName) {
      lines.push(`Last active agent: ${project.activeAgent}`);
    }
    lines.push(`Handoff depth: ${project.handoffDepth}/${project.maxHandoffDepth}`);
  } else {
    lines.push(`Channel: non-project`);
    lines.push(`Current agent: ${agentName || config?.agent || "default"}`);
  }

  if (config?.model) {
    lines.push(`Model: ${config.model}`);
  }

  return lines.join("\n");
}

function buildLearningsSection(keywords: string[]): string | null {
  if (!existsSync(LEARNINGS_DIR)) return null;

  const entries = searchVault(keywords, 5);
  if (entries.length === 0) return null;

  const lines: string[] = ["## Relevant Knowledge"];
  for (const entry of entries) {
    lines.push(`- [${entry.id}] ${entry.summary}`);
    if (entry.tags.length > 0) {
      lines.push(`  Tags: ${entry.tags.join(", ")}`);
    }
  }

  return lines.join("\n");
}

function buildProjectKnowledgeSection(projectName: string): string | null {
  // Try multiple filename patterns
  const candidates = [
    join(PROJECT_KNOWLEDGE_DIR, `${projectName}.md`),
    join(PROJECT_KNOWLEDGE_DIR, `${projectName.toLowerCase()}.md`),
    join(PROJECT_KNOWLEDGE_DIR, `${projectName.toLowerCase().replace(/\s+/g, "-")}.md`),
  ];

  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      // Strip YAML frontmatter
      const body = stripFrontmatter(content);
      if (body.trim()) {
        return `## Project Knowledge: ${projectName}\n${body.trim()}`;
      }
    }
  }

  return null;
}

function buildTaskHistorySection(channelId: string): string | null {
  try {
    const db = getDb();
    const tasks = db
      .prepare(
        `SELECT id, status, last_error, agent, created_at, step_count
         FROM task_queue
         WHERE channel_id = ?
         ORDER BY created_at DESC
         LIMIT 5`
      )
      .all(channelId) as any[];

    if (tasks.length === 0) return null;

    const lines: string[] = ["## Recent Tasks"];
    for (const t of tasks) {
      const error = t.last_error ? ` (error: "${t.last_error.slice(0, 80)}")` : "";
      const agent = t.agent ? ` [${t.agent}]` : "";
      lines.push(`- ${t.status}${agent}: ${t.step_count} steps${error} — ${t.created_at}`);
    }

    return lines.join("\n");
  } catch {
    return null;
  }
}

function buildConventionsSection(): string | null {
  const filePath = join(SHARED_DIR, "conventions.md");
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, "utf-8");
  const body = stripFrontmatter(content);
  if (!body.trim()) return null;

  return `## Conventions\n${body.trim()}`;
}

function buildGotchasSection(): string | null {
  const filePath = join(SHARED_DIR, "tool-gotchas.md");
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, "utf-8");
  const body = stripFrontmatter(content);
  if (!body.trim()) return null;

  return `## Tool Gotchas\n${body.trim()}`;
}

function buildHeartbeatSection(): string | null {
  try {
    const stateFiles = readdirSync(HEARTBEAT_DIR).filter((f) => f.endsWith(".state.json"));
    if (stateFiles.length === 0) return null;

    const lines: string[] = ["## Heartbeat Status"];
    for (const file of stateFiles) {
      try {
        const state = JSON.parse(readFileSync(join(HEARTBEAT_DIR, file), "utf-8"));
        const name = basename(file, ".state.json");
        const status = state.status || "unknown";
        const lastRun = state.last_run || state.lastRun || "never";
        lines.push(`- ${name}: ${status} (last: ${lastRun})`);
      } catch {
        // Skip malformed state files
      }
    }

    return lines.length > 1 ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

function buildPendingWorkSection(channelId: string): string | null {
  const parts: string[] = [];

  // Check pending notifications
  if (existsSync(NOTIFICATIONS_FILE)) {
    try {
      const content = readFileSync(NOTIFICATIONS_FILE, "utf-8").trim();
      if (content) {
        const notifications = content.split("\n").filter(Boolean);
        if (notifications.length > 0) {
          parts.push(`${notifications.length} pending notification(s)`);
        }
      }
    } catch {}
  }

  // Check dead letters for this channel
  try {
    const db = getDb();
    const deadLetters = db
      .prepare(
        `SELECT id, error FROM dead_letter WHERE channel_id = ? ORDER BY created_at DESC LIMIT 3`
      )
      .all(channelId) as any[];

    if (deadLetters.length > 0) {
      for (const dl of deadLetters) {
        parts.push(`Dead letter task ${dl.id}: "${dl.error.slice(0, 60)}"`);
      }
    }
  } catch {}

  if (parts.length === 0) return null;

  return `## Pending Work\n${parts.map((p) => `- ${p}`).join("\n")}`;
}

// ─── Keyword Extraction (deterministic, no LLM) ─────────────────────

function extractKeywords(prompt: string): string[] {
  // Split on non-word chars, lowercase, deduplicate
  const words = prompt
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

  return [...new Set(words)];
}

// ─── Vault Search (keyword-based) ────────────────────────────────────

function searchVault(keywords: string[], limit: number): VaultEntry[] {
  if (!existsSync(LEARNINGS_DIR)) return [];

  const files = readdirSync(LEARNINGS_DIR).filter((f) => f.endsWith(".md"));
  const entries: VaultEntry[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(LEARNINGS_DIR, file), "utf-8");
      const frontmatter = parseFrontmatter(content);
      if (!frontmatter) continue;

      const tags: string[] = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
      const patternKey: string = frontmatter["pattern-key"] || "";
      const id: string = frontmatter.id || basename(file, ".md");
      const type: string = frontmatter.type || "unknown";
      const status: string = frontmatter.status || "unknown";

      // Score by keyword overlap with tags + pattern-key
      const searchableTokens = [
        ...tags,
        ...patternKey.split("-"),
        ...(frontmatter.area || "").split("-"),
        ...(frontmatter.category || "").split("-"),
      ].map((t: string) => t.toLowerCase());

      let score = 0;
      for (const kw of keywords) {
        for (const token of searchableTokens) {
          if (token.includes(kw) || kw.includes(token)) {
            score++;
          }
        }
      }

      // Always include critical learnings with non-zero match
      if (frontmatter.priority === "critical" && score > 0) {
        score += 3;
      }

      if (score > 0) {
        // Extract first non-frontmatter heading as summary
        const body = stripFrontmatter(content);
        const heading = body.match(/^#\s+(.+)$/m);
        const summary = heading ? heading[1] : body.slice(0, 100).trim();

        entries.push({ id, title: summary, tags, patternKey, type, status, summary, score });
      }
    } catch {
      // Skip malformed files
    }
  }

  // Sort by score descending, take top-k
  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, limit);
}

// ─── YAML Frontmatter Parsing ────────────────────────────────────────

function parseFrontmatter(content: string): Record<string, any> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result: Record<string, any> = {};

  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value: any = line.slice(colonIdx + 1).trim();

    // Parse arrays: [item1, item2, item3]
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s: string) => s.trim().replace(/^["']|["']$/g, ""));
    }

    result[key] = value;
  }

  return result;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n*/, "");
}

// ─── Utilities ───────────────────────────────────────────────────────

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + "...";
}

// ─── Logging ─────────────────────────────────────────────────────────

function logContext(taskId: string, channelId: string, agent: string, context: string): void {
  try {
    const logDir = join(HARNESS_ROOT, "context-log");
    mkdirSync(logDir, { recursive: true });
    const file = join(logDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const entry = JSON.stringify({
      taskId,
      channelId,
      agent,
      timestamp: Date.now(),
      sections: context.split("\n\n## ").length,
      chars: context.length,
    });
    appendFileSync(file, entry + "\n");
  } catch {
    // Logging should never block execution
  }
}
