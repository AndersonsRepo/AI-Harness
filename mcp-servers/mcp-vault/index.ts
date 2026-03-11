#!/usr/bin/env node
/**
 * MCP Vault Server
 *
 * Exposes the AI Harness vault (Obsidian-compatible markdown with YAML frontmatter)
 * as MCP tools. Provides semantic search via Ollama embeddings, CRUD operations,
 * and vault analytics.
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
  writeFileSync,
  readdirSync,
  mkdirSync,
} from "fs";
import { join, basename } from "path";

// ─── Configuration ───────────────────────────────────────────────────

const VAULT_DIR = process.env.VAULT_DIR || join(process.env.HARNESS_ROOT || ".", "vault");
const LEARNINGS_DIR = join(VAULT_DIR, "learnings");
const SHARED_DIR = join(VAULT_DIR, "shared");
const EMBEDDINGS_FILE = join(VAULT_DIR, "vault-embeddings.json");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/embeddings";
const EMBED_MODEL = "nomic-embed-text";

// ─── Embedding Types ─────────────────────────────────────────────────

interface EmbeddingEntry {
  path: string;
  hash: string;
  embedding: number[];
  text: string;
  updatedAt: number;
}

// ─── Vault Helpers ───────────────────────────────────────────────────

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
    }
    result[key] = value;
  }
  return result;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n*/, "");
}

function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

// ─── Embedding Helpers ───────────────────────────────────────────────

function loadEmbeddings(): EmbeddingEntry[] {
  if (!existsSync(EMBEDDINGS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(EMBEDDINGS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveEmbeddings(entries: EmbeddingEntry[]): void {
  writeFileSync(EMBEDDINGS_FILE, JSON.stringify(entries, null, 2));
}

function simpleHash(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) - h + content.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
  } catch {
    return null;
  }
}

function normalizeVector(v: number[]): number[] {
  let mag = 0;
  for (const x of v) mag += x * x;
  mag = Math.sqrt(mag);
  if (mag === 0) return v;
  return v.map((x) => x / mag);
}

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

// ─── Server Setup ────────────────────────────────────────────────────

const server = new McpServer({
  name: "mcp-vault",
  version: "1.0.0",
});

// ─── Tool: vault_search ──────────────────────────────────────────────

server.tool(
  "vault_search",
  "Search the vault using semantic similarity (via embeddings) and/or keyword matching. Returns the most relevant learnings, errors, and knowledge entries.",
  {
    query: z.string().describe("Natural language search query"),
    limit: z.number().optional().default(5).describe("Max results to return"),
    type: z.string().optional().describe("Filter by type: learning, error, scout, or all"),
  },
  async ({ query, limit, type }) => {
    const store = loadEmbeddings();

    // Semantic search
    let results: { path: string; text: string; score: number }[] = [];
    const queryEmbed = await generateEmbedding(query);

    if (queryEmbed && store.length > 0) {
      const normalized = normalizeVector(queryEmbed);
      results = store.map((entry) => ({
        path: entry.path,
        text: entry.text,
        score: dotProduct(normalized, entry.embedding),
      }));
    } else {
      // Fallback: keyword search
      const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      for (const file of listMarkdownFiles(LEARNINGS_DIR)) {
        const content = readFileSync(join(LEARNINGS_DIR, file), "utf-8").toLowerCase();
        let score = 0;
        for (const kw of keywords) {
          if (content.includes(kw)) score++;
        }
        if (score > 0) {
          const raw = readFileSync(join(LEARNINGS_DIR, file), "utf-8");
          results.push({
            path: `learnings/${file}`,
            text: stripFrontmatter(raw).slice(0, 200),
            score: score / keywords.length,
          });
        }
      }
    }

    // Type filter
    if (type && type !== "all") {
      results = results.filter((r) => {
        const fullPath = join(VAULT_DIR, r.path);
        if (!existsSync(fullPath)) return false;
        const fm = parseFrontmatter(readFileSync(fullPath, "utf-8"));
        return fm?.type === type;
      });
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, limit);

    if (top.length === 0) {
      return { content: [{ type: "text" as const, text: "No relevant vault entries found." }] };
    }

    const formatted = top.map((r) => {
      const name = r.path.split("/").pop()?.replace(".md", "") || r.path;
      return `[${name}] (score: ${r.score.toFixed(3)})\n${r.text}`;
    }).join("\n\n");

    return { content: [{ type: "text" as const, text: formatted }] };
  }
);

// ─── Tool: vault_read ────────────────────────────────────────────────

server.tool(
  "vault_read",
  "Read a specific vault entry by its ID (e.g., LRN-20250309-001) or file path.",
  {
    id: z.string().describe("Learning ID (e.g., LRN-20250309-001) or relative path (e.g., learnings/LRN-20250309-001.md)"),
  },
  async ({ id }) => {
    // Try as direct path first
    let filePath = join(VAULT_DIR, id);
    if (!existsSync(filePath)) {
      // Try as ID in learnings dir
      filePath = join(LEARNINGS_DIR, `${id}.md`);
    }
    if (!existsSync(filePath)) {
      return { content: [{ type: "text" as const, text: `Vault entry not found: ${id}` }] };
    }

    const content = readFileSync(filePath, "utf-8");
    return { content: [{ type: "text" as const, text: content }] };
  }
);

// ─── Tool: vault_write ───────────────────────────────────────────────

server.tool(
  "vault_write",
  "Create a new vault learning entry with proper YAML frontmatter. Validates the required fields.",
  {
    id: z.string().describe("Entry ID (e.g., LRN-20260312-001 or ERR-20260312-001)"),
    type: z.enum(["learning", "error"]).describe("Entry type"),
    title: z.string().describe("Short title for the heading"),
    area: z.string().describe("Area: infra, architecture, business, etc."),
    tags: z.array(z.string()).describe("Tags for searchability"),
    patternKey: z.string().describe("Unique kebab-case pattern identifier"),
    body: z.string().describe("Full markdown body (sections: What happened, What was learned, Why it matters)"),
    severity: z.string().optional().describe("For errors: critical, high, medium, low"),
    priority: z.string().optional().describe("For learnings: critical, medium, low"),
    project: z.string().optional().default("ai-harness").describe("Project name"),
  },
  async ({ id, type, title, area, tags, patternKey, body, severity, priority, project }) => {
    mkdirSync(LEARNINGS_DIR, { recursive: true });

    // --- Dedup: check for existing entry with same pattern-key ---
    if (patternKey) {
      try {
        const existingFiles = readdirSync(LEARNINGS_DIR).filter((f) => f.endsWith(".md"));
        for (const file of existingFiles) {
          const fullPath = join(LEARNINGS_DIR, file);
          const content = readFileSync(fullPath, "utf-8");
          const pkMatch = content.match(/^pattern-key:\s*(.+)$/m);
          if (pkMatch && pkMatch[1].trim() === patternKey) {
            // Found duplicate — increment recurrence-count and update last-seen
            const today = new Date().toISOString().slice(0, 10);
            const countMatch = content.match(/^recurrence-count:\s*(\d+)$/m);
            const currentCount = countMatch ? parseInt(countMatch[1], 10) : 1;
            const newCount = currentCount + 1;

            let updated = content
              .replace(/^recurrence-count:\s*\d+$/m, `recurrence-count: ${newCount}`)
              .replace(/^last-seen:\s*[\d-]+$/m, `last-seen: ${today}`);

            // Bump status from "new" to "recurring"
            if (/^status:\s*new$/m.test(updated)) {
              updated = updated.replace(/^status:\s*new$/m, "status: recurring");
            }

            writeFileSync(fullPath, updated);
            const matchId = file.replace(/\.md$/, "");
            return {
              content: [{
                type: "text" as const,
                text: `Duplicate pattern-key "${patternKey}" — incremented recurrence on ${matchId} (count: ${newCount}). No new file created.`,
              }],
            };
          }
        }
      } catch {
        // If dedup check fails, fall through to create new entry
      }
    }

    const filePath = join(LEARNINGS_DIR, `${id}.md`);

    if (existsSync(filePath)) {
      return { content: [{ type: "text" as const, text: `Entry ${id} already exists. Use vault_read to check it.` }] };
    }

    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    let frontmatter = `---\nid: ${id}\nlogged: ${now}\ntype: ${type}\n`;
    if (type === "error" && severity) frontmatter += `severity: ${severity}\n`;
    if (type === "learning" && priority) frontmatter += `priority: ${priority}\n`;
    frontmatter += `status: resolved\ncategory: best_practice\narea: ${area}\nagent: main\nproject: ${project}\n`;
    frontmatter += `pattern-key: ${patternKey}\nrecurrence-count: 1\nfirst-seen: ${today}\nlast-seen: ${today}\n`;
    frontmatter += `tags: [${tags.join(", ")}]\nrelated: []\n---\n\n`;

    const content = `${frontmatter}# ${title}\n\n${body}\n`;
    writeFileSync(filePath, content);

    // Generate embedding for the new entry
    const embedding = await generateEmbedding(stripFrontmatter(content));
    if (embedding) {
      const store = loadEmbeddings();
      const relPath = `learnings/${id}.md`;
      store.push({
        path: relPath,
        hash: simpleHash(content),
        embedding: normalizeVector(embedding),
        text: stripFrontmatter(content).slice(0, 200),
        updatedAt: Date.now(),
      });
      saveEmbeddings(store);
    }

    return { content: [{ type: "text" as const, text: `Created vault entry: ${id}\nPath: ${filePath}` }] };
  }
);

// ─── Tool: vault_list ────────────────────────────────────────────────

server.tool(
  "vault_list",
  "List vault entries, optionally filtered by type, status, area, or tag.",
  {
    type: z.string().optional().describe("Filter by type: learning, error, scout"),
    status: z.string().optional().describe("Filter by status: resolved, open, pending"),
    tag: z.string().optional().describe("Filter by tag"),
    area: z.string().optional().describe("Filter by area: infra, architecture, etc."),
  },
  async ({ type, status, tag, area }) => {
    const files = listMarkdownFiles(LEARNINGS_DIR);
    const entries: string[] = [];

    for (const file of files) {
      const content = readFileSync(join(LEARNINGS_DIR, file), "utf-8");
      const fm = parseFrontmatter(content);
      if (!fm) continue;

      if (type && fm.type !== type) continue;
      if (status && fm.status !== status) continue;
      if (area && fm.area !== area) continue;
      if (tag) {
        const tags = Array.isArray(fm.tags) ? fm.tags : [];
        if (!tags.includes(tag)) continue;
      }

      const heading = stripFrontmatter(content).match(/^#\s+(.+)$/m);
      const title = heading ? heading[1] : file;
      const id = fm.id || file.replace(".md", "");
      entries.push(`- [${id}] ${title} (${fm.type}, ${fm.status}, area:${fm.area})`);
    }

    if (entries.length === 0) {
      return { content: [{ type: "text" as const, text: "No matching vault entries found." }] };
    }

    return { content: [{ type: "text" as const, text: `${entries.length} entries:\n${entries.join("\n")}` }] };
  }
);

// ─── Tool: vault_promote_candidates ──────────────────────────────────

server.tool(
  "vault_promote_candidates",
  "Find learnings with recurrence-count >= 3 that should be promoted to CLAUDE.md.",
  {},
  async () => {
    const files = listMarkdownFiles(LEARNINGS_DIR);
    const candidates: string[] = [];

    for (const file of files) {
      const content = readFileSync(join(LEARNINGS_DIR, file), "utf-8");
      const fm = parseFrontmatter(content);
      if (!fm) continue;

      const count = parseInt(fm["recurrence-count"] || "0", 10);
      if (count >= 3) {
        const heading = stripFrontmatter(content).match(/^#\s+(.+)$/m);
        const title = heading ? heading[1] : file;
        candidates.push(`- [${fm.id}] ${title} (recurrence: ${count})`);
      }
    }

    if (candidates.length === 0) {
      return { content: [{ type: "text" as const, text: "No promotion candidates found (need recurrence-count >= 3)." }] };
    }

    return { content: [{ type: "text" as const, text: `Promotion candidates:\n${candidates.join("\n")}` }] };
  }
);

// ─── Tool: vault_sync_embeddings ─────────────────────────────────────

server.tool(
  "vault_sync_embeddings",
  "Re-sync all vault embeddings. Run this after adding/modifying vault files outside of vault_write.",
  {},
  async () => {
    const dirs = ["learnings", "shared", join("shared", "project-knowledge"), join("shared", "scouted")];
    const allFiles: { relPath: string; fullPath: string }[] = [];

    for (const dir of dirs) {
      const fullDir = join(VAULT_DIR, dir);
      if (!existsSync(fullDir)) continue;
      for (const file of listMarkdownFiles(fullDir)) {
        allFiles.push({ relPath: join(dir, file), fullPath: join(fullDir, file) });
      }
    }

    const store = loadEmbeddings();
    const storeMap = new Map(store.map((e) => [e.path, e]));
    const newStore: EmbeddingEntry[] = [];
    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const { relPath, fullPath } of allFiles) {
      const content = readFileSync(fullPath, "utf-8");
      const hash = simpleHash(content);
      const existing = storeMap.get(relPath);

      if (existing && existing.hash === hash) {
        newStore.push(existing);
        skipped++;
        continue;
      }

      const text = content.replace(/^---\n[\s\S]*?\n---\n*/, "").slice(0, 6000).trim();
      if (!text) continue;

      const embedding = await generateEmbedding(text);
      if (!embedding) {
        if (existing) newStore.push(existing);
        continue;
      }

      newStore.push({
        path: relPath,
        hash,
        embedding: normalizeVector(embedding),
        text: text.slice(0, 200),
        updatedAt: Date.now(),
      });

      if (existing) updated++;
      else added++;
    }

    saveEmbeddings(newStore);

    return {
      content: [{
        type: "text" as const,
        text: `Embedding sync complete:\n- Added: ${added}\n- Updated: ${updated}\n- Unchanged: ${skipped}\n- Total: ${newStore.length}`,
      }],
    };
  }
);

// ─── Tool: vault_stats ───────────────────────────────────────────────

server.tool(
  "vault_stats",
  "Get vault statistics: file counts, embedding coverage, type breakdown.",
  {},
  async () => {
    const files = listMarkdownFiles(LEARNINGS_DIR);
    const store = loadEmbeddings();

    const typeCounts: Record<string, number> = {};
    const areaCounts: Record<string, number> = {};

    for (const file of files) {
      const content = readFileSync(join(LEARNINGS_DIR, file), "utf-8");
      const fm = parseFrontmatter(content);
      if (!fm) continue;
      typeCounts[fm.type] = (typeCounts[fm.type] || 0) + 1;
      areaCounts[fm.area] = (areaCounts[fm.area] || 0) + 1;
    }

    const lines = [
      `Vault Statistics:`,
      `- Learnings directory: ${files.length} files`,
      `- Embeddings: ${store.length} vectors`,
      `- Coverage: ${store.length > 0 && files.length > 0 ? Math.round((store.length / files.length) * 100) : 0}%`,
      ``,
      `By type:`,
      ...Object.entries(typeCounts).map(([t, c]) => `  - ${t}: ${c}`),
      ``,
      `By area:`,
      ...Object.entries(areaCounts).map(([a, c]) => `  - ${a}: ${c}`),
    ];

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Start Server ────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-vault] Server started");
}

main().catch((err) => {
  console.error("[mcp-vault] Fatal:", err);
  process.exit(1);
});
