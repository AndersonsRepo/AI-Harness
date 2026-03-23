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
import { execSync } from "child_process";
import { join, basename } from "path";
import { getDb } from "./db.js";
import { getProject, resolveProjectWorkdir, type ProjectConfig } from "./project-manager.js";
import { getChannelConfig, type ChannelConfig } from "./channel-config-store.js";
import { hybridSearch, type SearchResult } from "./embeddings.js";
import { monitor } from "./truncation-monitor.js";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const VAULT_DIR = join(HARNESS_ROOT, "vault");
const LEARNINGS_DIR = join(VAULT_DIR, "learnings");
const SHARED_DIR = join(VAULT_DIR, "shared");
const PROJECT_KNOWLEDGE_DIR = join(SHARED_DIR, "project-knowledge");
const HEARTBEAT_DIR = join(HARNESS_ROOT, "heartbeat-tasks");
const NOTIFICATIONS_FILE = join(HEARTBEAT_DIR, "pending-notifications.jsonl");

// Token budget: ~5000-6000 tokens. Cost is negligible on Max subscription.
// Learnings get the lion's share — that's the whole point of the system.
const MAX_TOTAL_CHARS = 25000; // ~6000 tokens
const COURSE_NOTES_DIR = join(SHARED_DIR, "course-notes");

const SECTION_LIMITS: Record<string, number> = {
  project: 600,
  channelState: 400,
  learnings: 12000,
  projectKnowledge: 3000,
  taskHistory: 1200,
  recentOutlook: 800,
  recentAcademic: 1200,
  conventions: 2000,
  gotchas: 2000,
  heartbeats: 800,
  pendingWork: 600,
  workQueue: 400,
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

    // Priority 2: Relevant learnings (hybrid: semantic + keyword)
    if (totalChars < MAX_TOTAL_CHARS) {
      const learningsSection = await buildLearningsSection(params.prompt, keywords, {
        agentName: params.agentName,
        channelId: params.channelId,
        taskId: params.taskId,
        projectName: project?.name,
      });
      if (learningsSection) {
        let finalLearnings = monitor.truncate(learningsSection, SECTION_LIMITS.learnings, "context:learnings");

        // Check if any learnings were significantly truncated and notify the LLM
        const truncationEvents = monitor.drainRecentEvents("context:learnings");
        if (truncationEvents.length > 0) {
          const significantCount = truncationEvents.filter((e) => e.severity === "significant" || e.severity === "critical").length;
          if (significantCount > 0) {
            finalLearnings += `\n\n> ⚠ ${significantCount} learning(s) were significantly truncated (>30% content lost). Use vault_read to fetch full content for any entry you need details from.`;
          }
        }

        sections.push(finalLearnings);
        totalChars += finalLearnings.length;
      }
    }

    // Priority 3: Project-specific knowledge
    if (totalChars < MAX_TOTAL_CHARS && project) {
      const knowledgeSection = buildProjectKnowledgeSection(project.name);
      if (knowledgeSection) {
        sections.push(monitor.truncate(knowledgeSection, SECTION_LIMITS.projectKnowledge, "context:project-knowledge"));
        totalChars += Math.min(knowledgeSection.length, SECTION_LIMITS.projectKnowledge);
      }
    }

    // Priority 4: Task history
    if (totalChars < MAX_TOTAL_CHARS) {
      const taskSection = buildTaskHistorySection(params.channelId);
      if (taskSection) {
        sections.push(monitor.truncate(taskSection, SECTION_LIMITS.taskHistory, "context:task-history"));
        totalChars += Math.min(taskSection.length, SECTION_LIMITS.taskHistory);
      }
    }

    // Priority 5: Recent Outlook (email + calendar digest)
    if (totalChars < MAX_TOTAL_CHARS) {
      const outlookSection = buildRecentOutlookSection();
      if (outlookSection) {
        sections.push(monitor.truncate(outlookSection, SECTION_LIMITS.recentOutlook, "context:recent-outlook"));
        totalChars += Math.min(outlookSection.length, SECTION_LIMITS.recentOutlook);
      }
    }

    // Priority 5.5: Recent academic notes (course-specific if in a course channel)
    if (totalChars < MAX_TOTAL_CHARS) {
      const academicSection = buildRecentAcademicSection(params.channelId);
      if (academicSection) {
        sections.push(monitor.truncate(academicSection, SECTION_LIMITS.recentAcademic, "context:recent-academic"));
        totalChars += Math.min(academicSection.length, SECTION_LIMITS.recentAcademic);
      }
    }

    // Priority 6: Conventions + tool gotchas (always load — small files)
    if (totalChars < MAX_TOTAL_CHARS) {
      const conventionsSection = buildConventionsSection();
      if (conventionsSection) {
        sections.push(monitor.truncate(conventionsSection, SECTION_LIMITS.conventions, "context:conventions"));
        totalChars += Math.min(conventionsSection.length, SECTION_LIMITS.conventions);
      }
    }

    if (totalChars < MAX_TOTAL_CHARS) {
      const gotchasSection = buildGotchasSection();
      if (gotchasSection) {
        sections.push(monitor.truncate(gotchasSection, SECTION_LIMITS.gotchas, "context:gotchas"));
        totalChars += Math.min(gotchasSection.length, SECTION_LIMITS.gotchas);
      }
    }

    // Priority 7: Heartbeat status
    if (totalChars < MAX_TOTAL_CHARS) {
      const heartbeatSection = buildHeartbeatSection();
      if (heartbeatSection) {
        sections.push(monitor.truncate(heartbeatSection, SECTION_LIMITS.heartbeats, "context:heartbeats"));
        totalChars += Math.min(heartbeatSection.length, SECTION_LIMITS.heartbeats);
      }
    }

    // Priority 8: Pending work
    if (totalChars < MAX_TOTAL_CHARS) {
      const pendingSection = buildPendingWorkSection(params.channelId);
      if (pendingSection) {
        sections.push(monitor.truncate(pendingSection, SECTION_LIMITS.pendingWork, "context:pending-work"));
        totalChars += Math.min(pendingSection.length, SECTION_LIMITS.pendingWork);
      }
    }

    // Priority 9: Autonomous work queue status
    if (totalChars < MAX_TOTAL_CHARS) {
      const workQueueSection = buildWorkQueueSection();
      if (workQueueSection) {
        sections.push(monitor.truncate(workQueueSection, SECTION_LIMITS.workQueue, "context:work-queue"));
        totalChars += Math.min(workQueueSection.length, SECTION_LIMITS.workQueue);
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
    const projectPath = resolveProjectWorkdir(project.name);
    if (projectPath) {
      lines.push(`Working directory: ${projectPath}`);
    }
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

async function buildLearningsSection(
  prompt: string,
  keywords: string[],
  params: { agentName: string; channelId: string; taskId: string; projectName?: string },
): Promise<string | null> {
  // Try hybrid search (semantic + keyword) first, fall back to keyword-only
  let results: SearchResult[] = [];
  try {
    results = await hybridSearch(prompt, keywords, 10);
  } catch {
    // Ollama unavailable — fall back to keyword-only via old searchVault
    const entries = searchVault(keywords, 5);
    if (entries.length === 0) return null;
    const lines: string[] = ["## Relevant Knowledge"];
    for (const entry of entries) {
      lines.push(`- [${entry.id}] ${entry.summary}`);
    }
    return lines.join("\n");
  }

  // --- P3: Self-RAG relevance filter ---
  // Compute composite relevance score instead of flat threshold
  const relevant = results
    .map((r) => {
      let relevance = r.score * 0.6; // Base: hybrid search score (60% weight)

      // Keyword overlap boost: fraction of prompt keywords found in result text
      const resultText = r.text.toLowerCase();
      const keywordHits = keywords.filter((k) => resultText.includes(k.toLowerCase())).length;
      const keywordOverlap = keywords.length > 0 ? keywordHits / keywords.length : 0;
      relevance += keywordOverlap * 0.2;

      // Project affinity boost
      if (params.projectName && resultText.includes(params.projectName.toLowerCase())) {
        relevance += 0.1;
      }

      // Recency boost: files modified in last 7 days
      try {
        const fullPath = join(VAULT_DIR, r.path);
        if (existsSync(fullPath)) {
          const stat = require("fs").statSync(fullPath);
          const ageMs = Date.now() - stat.mtimeMs;
          if (ageMs < 7 * 86400_000) relevance += 0.1;
        }
      } catch {}

      return { ...r, compositeScore: relevance };
    })
    .filter((r) => r.compositeScore > 0.25)
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, 8); // Fewer but higher-quality results

  if (relevant.length === 0) return null;

  // --- P1: Log retrieval hits ---
  logRetrievalHits(
    relevant.map((r) => ({
      path: r.path,
      agent: params.agentName,
      channelId: params.channelId,
      taskId: params.taskId,
      score: r.compositeScore,
      matchType: r.matchType,
    })),
  );

  // --- P5: Graph neighbor expansion ---
  // For top results, pull 1-hop graph neighbors and add if not already present
  const resultPaths = new Set(relevant.map((r) => r.path));
  const graphNeighbors = getGraphNeighbors(
    relevant.slice(0, 3).map((r) => r.path.split("/").pop()?.replace(".md", "") || ""),
  );
  for (const neighbor of graphNeighbors) {
    const neighborPath = `learnings/${neighbor}.md`;
    if (!resultPaths.has(neighborPath) && relevant.length < 10) {
      // Add graph neighbor as a lightweight entry
      const neighborFullPath = join(VAULT_DIR, neighborPath);
      if (existsSync(neighborFullPath)) {
        relevant.push({
          path: neighborPath,
          text: "",
          score: 0.3,
          matchType: "graph" as any,
          compositeScore: 0.3,
        });
        resultPaths.add(neighborPath);
      }
    }
  }

  const lines: string[] = ["## Relevant Knowledge"];
  for (const r of relevant) {
    const fileName = r.path.split("/").pop()?.replace(".md", "") || r.path;
    const matchTag = r.matchType === "hybrid" ? " [hybrid]"
      : r.matchType === "semantic" ? " [semantic]"
      : (r as any).matchType === "graph" ? " [graph]"
      : "";

    // Load full file content for high-relevance results
    const fullPath = join(VAULT_DIR, r.path);
    let body = "";
    let compressed = "";
    let frontmatter = "";
    try {
      if (existsSync(fullPath)) {
        const rawContent = readFileSync(fullPath, "utf-8");
        body = stripFrontmatter(rawContent).trim();
        frontmatter = rawContent.split("---")[1] || "";

        // --- P4: Prefer compressed version if available ---
        const compressedMatch = frontmatter.match(/^compressed:\s*"?(.+?)"?\s*$/m);
        if (compressedMatch) {
          compressed = compressedMatch[1].trim();
        }

        // Skip superseded entries (P2)
        if (/^status:\s*superseded/m.test(frontmatter)) continue;
      }
    } catch {}

    if (compressed && compressed.length > 20) {
      // Use compressed version — fits more entries in budget
      lines.push(`### [${fileName}]${matchTag} (score: ${r.compositeScore.toFixed(2)})`);
      lines.push(compressed);
    } else if (body && body.length > 40) {
      lines.push(`### [${fileName}]${matchTag} (score: ${r.compositeScore.toFixed(2)})`);
      lines.push(monitor.truncate(body, 1500, "context:learnings"));
    } else {
      lines.push(`- [${fileName}] ${r.text.slice(0, 200)}${matchTag}`);
    }
  }

  return lines.join("\n");
}

// --- P1: Retrieval hit logging ---
function logRetrievalHits(hits: { path: string; agent: string; channelId: string; taskId: string; score: number; matchType: string }[]): void {
  try {
    const db = getDb();
    const stmt = db.prepare(
      "INSERT INTO retrieval_hits (learning_path, agent, channel_id, task_id, score, match_type) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const insertMany = db.transaction((items: typeof hits) => {
      for (const h of items) {
        stmt.run(h.path, h.agent, h.channelId, h.taskId, h.score, h.matchType);
      }
    });
    insertMany(hits);
  } catch {
    // Non-critical — don't break context assembly if logging fails
  }
}

// --- P5: Graph neighbor expansion ---
function getGraphNeighbors(learningIds: string[]): string[] {
  if (learningIds.length === 0) return [];
  try {
    const db = getDb();
    const placeholders = learningIds.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT DISTINCT CASE WHEN source_id IN (${placeholders}) THEN target_id ELSE source_id END as neighbor
       FROM learning_edges
       WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
       ORDER BY weight DESC LIMIT 3`
    ).all(...learningIds, ...learningIds, ...learningIds) as { neighbor: string }[];
    return rows.map((r) => r.neighbor).filter((n) => !learningIds.includes(n));
  } catch {
    return [];
  }
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

function buildWorkQueueSection(): string | null {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT status, COUNT(*) as c FROM work_queue WHERE status IN ('pending', 'gated', 'running') GROUP BY status"
    ).all() as { status: string; c: number }[];

    if (rows.length === 0) return null;

    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = row.c;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) return null;

    const parts: string[] = [`${total} work queue item(s): ${Object.entries(counts).map(([s, c]) => `${c} ${s}`).join(", ")}`];

    // Show next few pending items (source + priority only — never inject raw prompts
    // into agent context, as they can be confused with user instructions)
    const pending = db.prepare(
      "SELECT source, priority, agent FROM work_queue WHERE status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT 3"
    ).all() as { source: string; priority: number; agent: string | null }[];

    for (const item of pending) {
      const agent = item.agent ? ` → ${item.agent}` : "";
      parts.push(`Queued: [P${item.priority}] ${item.source}${agent}`);
    }

    return `## Work Queue\n${parts.map((p) => `- ${p}`).join("\n")}`;
  } catch {
    return null;
  }
}

function buildRecentOutlookSection(): string | null {
  try {
    const db = getDb();

    // Check if email_index table exists (v2 migration)
    const tableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='email_index'")
      .get();
    if (!tableCheck) return null;

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Email summary: count by sender, unread count
    const emailStats = db
      .prepare(
        `SELECT sender_name, COUNT(*) as count, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread
         FROM email_index WHERE received_at >= ? GROUP BY sender_email ORDER BY count DESC LIMIT 5`
      )
      .all(since) as any[];

    const totalUnread = db
      .prepare("SELECT COUNT(*) as c FROM email_index WHERE received_at >= ? AND is_read = 0")
      .get(since) as { c: number };

    // Watched sender alerts
    const watchedAlerts = db
      .prepare(
        `SELECT e.sender_name, e.subject, w.label
         FROM email_index e JOIN watched_senders w ON e.sender_email = w.email
         WHERE e.received_at >= ? ORDER BY e.received_at DESC LIMIT 3`
      )
      .all(since) as any[];

    // Only include if there's actual data
    if (emailStats.length === 0 && watchedAlerts.length === 0) return null;

    const lines: string[] = ["## Recent Outlook (24h)"];

    if (totalUnread.c > 0) {
      lines.push(`Unread: ${totalUnread.c}`);
    }

    if (emailStats.length > 0) {
      for (const e of emailStats) {
        const unreadNote = e.unread > 0 ? ` (${e.unread} new)` : "";
        lines.push(`- ${e.sender_name}: ${e.count} email(s)${unreadNote}`);
      }
    }

    if (watchedAlerts.length > 0) {
      lines.push("Watched:");
      for (const a of watchedAlerts) {
        lines.push(`- [${a.label}] ${a.sender_name}: "${a.subject}"`);
      }
    }

    return lines.join("\n");
  } catch {
    return null;
  }
}

// ─── Academic Notes Section ──────────────────────────────────────────

// Map Discord channel names to course-notes subdirectories
const COURSE_CHANNEL_MAP: Record<string, string> = {
  "numerical-methods": "numerical-methods",
  "philosophy": "philosophy",
  "systems-programming": "systems-programming",
  "comp-society": "comp-society",
};

function buildRecentAcademicSection(channelId: string): string | null {
  if (!existsSync(COURSE_NOTES_DIR)) return null;

  // Try to resolve channel name from Discord cache (via channel config or project)
  // For now, check all course dirs and summarize what's available
  const channelConfig = getChannelConfig(channelId);

  // Determine if we're in a course-specific channel
  let targetCourse: string | null = null;

  // Check if the channel has a topic or name matching a course
  // We can also check by looking up the channel name from projects table
  try {
    const db = getDb();
    const row = db.prepare(
      "SELECT name FROM projects WHERE channel_id = ?"
    ).get(channelId) as { name: string } | undefined;
    if (row) {
      const projectName = row.name.toLowerCase();
      for (const [chanName, dir] of Object.entries(COURSE_CHANNEL_MAP)) {
        if (projectName === chanName || projectName.includes(dir)) {
          targetCourse = dir;
          break;
        }
      }
    }
  } catch {}

  // Also check by iterating channel configs for name match
  // (channels created under School category aren't projects, so check by channelId directly)
  // We'll build a summary of all courses with note counts, and detail for the target course

  const lines: string[] = ["## Academic Notes"];
  let hasContent = false;

  try {
    const courseDirs = readdirSync(COURSE_NOTES_DIR).filter((d) => {
      try {
        return existsSync(join(COURSE_NOTES_DIR, d)) &&
          readdirSync(join(COURSE_NOTES_DIR, d)).some((f) => f.endsWith(".md"));
      } catch { return false; }
    });

    if (courseDirs.length === 0) return null;

    // Summary line: note counts per course
    const counts: string[] = [];
    for (const dir of courseDirs) {
      const noteFiles = readdirSync(join(COURSE_NOTES_DIR, dir)).filter((f) => f.endsWith(".md"));
      counts.push(`${dir}: ${noteFiles.length} notes`);
    }
    lines.push(`Courses: ${counts.join(", ")}`);
    hasContent = true;

    // If in a course channel, list recent notes for that course
    if (targetCourse && courseDirs.includes(targetCourse)) {
      const courseDir = join(COURSE_NOTES_DIR, targetCourse);
      const noteFiles = readdirSync(courseDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .slice(-5); // last 5

      if (noteFiles.length > 0) {
        lines.push(`\nRecent ${targetCourse} notes:`);
        for (const f of noteFiles) {
          const title = f.replace(".md", "").replace(/-/g, " ");
          lines.push(`- ${title}`);
        }
      }
    }
  } catch {
    return null;
  }

  return hasContent ? lines.join("\n") : null;
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
