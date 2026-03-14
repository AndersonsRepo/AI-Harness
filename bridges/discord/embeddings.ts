/**
 * Embedding Pipeline for Semantic Vault Search
 *
 * Generates embeddings via Ollama (nomic-embed-text) and stores them
 * in a JSON file. Provides hybrid search: vector similarity + keyword matching.
 *
 * Architecture:
 *   - Ollama runs locally on localhost:11434
 *   - Embeddings stored in vault/vault-embeddings.json (~300KB for 100 files)
 *   - Brute-force cosine similarity (sub-millisecond for <1000 entries)
 *   - Upgrade path: swap JSON store for sqlite-vec when vault exceeds 500 files
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, watch, FSWatcher } from "fs";
import { join, relative } from "path";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const VAULT_DIR = join(HARNESS_ROOT, "vault");
const EMBEDDINGS_FILE = join(VAULT_DIR, "vault-embeddings.json");
const OLLAMA_URL = "http://localhost:11434/api/embeddings";
const MODEL = "nomic-embed-text";

export interface EmbeddingEntry {
  path: string;         // Relative to vault dir (e.g. "learnings/LRN-20250309-001.md")
  hash: string;         // Content hash for cache invalidation
  embedding: number[];  // 768-dimensional vector (nomic-embed-text)
  text: string;         // The text that was embedded (for display)
  updatedAt: number;    // Timestamp
}

export interface SearchResult {
  path: string;
  text: string;
  score: number;         // Cosine similarity (0-1)
  matchType: "semantic" | "keyword" | "hybrid";
}

// ─── Embedding Store ─────────────────────────────────────────────────

function loadStore(): EmbeddingEntry[] {
  if (!existsSync(EMBEDDINGS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(EMBEDDINGS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveStore(entries: EmbeddingEntry[]): void {
  writeFileSync(EMBEDDINGS_FILE, JSON.stringify(entries, null, 2));
}

function simpleHash(content: string): string {
  // Fast non-crypto hash — just need cache invalidation, not security
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) - h + content.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

// ─── Ollama Embedding Generation ─────────────────────────────────────

async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt: text }),
    });

    if (!response.ok) {
      console.error(`[embeddings] Ollama returned ${response.status}`);
      return null;
    }

    const data = await response.json() as { embedding: number[] };
    return data.embedding;
  } catch (err: any) {
    console.error(`[embeddings] Ollama unavailable: ${err.message}`);
    return null;
  }
}

// ─── Vault File Discovery ────────────────────────────────────────────

function discoverVaultFiles(): string[] {
  const files: string[] = [];
  const dirs = [
    "learnings",
    "shared",
    join("shared", "project-knowledge"),
    join("shared", "scouted"),
    join("shared", "course-notes", "numerical-methods"),
    join("shared", "course-notes", "philosophy"),
    join("shared", "course-notes", "systems-programming"),
    join("shared", "course-notes", "comp-society"),
    "agents",
    "daily",
  ];

  for (const dir of dirs) {
    const fullDir = join(VAULT_DIR, dir);
    if (!existsSync(fullDir)) continue;

    try {
      for (const file of readdirSync(fullDir)) {
        if (!file.endsWith(".md")) continue;
        files.push(join(dir, file));
      }
    } catch {}
  }

  return files;
}

function prepareText(content: string): string {
  // Strip YAML frontmatter, keep meaningful text for embedding
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
  // Truncate to fit nomic-embed-text context window (8192 tokens ≈ 6000 chars safe)
  return body.slice(0, 6000).trim();
}

// ─── Sync Pipeline ───────────────────────────────────────────────────

export async function syncEmbeddings(): Promise<{ added: number; updated: number; removed: number }> {
  const store = loadStore();
  const storeMap = new Map(store.map((e) => [e.path, e]));
  const currentFiles = discoverVaultFiles();
  const currentSet = new Set(currentFiles);

  let added = 0;
  let updated = 0;
  let removed = 0;

  const newStore: EmbeddingEntry[] = [];

  for (const relPath of currentFiles) {
    const fullPath = join(VAULT_DIR, relPath);
    const content = readFileSync(fullPath, "utf-8");
    const hash = simpleHash(content);
    const existing = storeMap.get(relPath);

    if (existing && existing.hash === hash) {
      // File unchanged — keep existing embedding
      newStore.push(existing);
      continue;
    }

    // New or modified file — generate embedding
    const text = prepareText(content);
    if (!text) continue;

    const embedding = await generateEmbedding(text);
    if (!embedding) {
      // Ollama unavailable — keep existing if we have one, skip otherwise
      if (existing) newStore.push(existing);
      continue;
    }

    newStore.push({
      path: relPath,
      hash,
      embedding: normalizeVector(embedding),
      text: text.slice(0, 200), // Store preview for display
      updatedAt: Date.now(),
    });

    if (existing) updated++;
    else added++;
  }

  // Count removed (files that no longer exist)
  for (const entry of store) {
    if (!currentSet.has(entry.path)) removed++;
  }

  saveStore(newStore);
  console.log(`[embeddings] Sync complete: +${added} ~${updated} -${removed} (${newStore.length} total)`);

  return { added, updated, removed };
}

// ─── Embed Single File (for post-write hooks) ───────────────────────

// Mutex to prevent concurrent load/modify/save races on the embedding store
let embedLock: Promise<void> = Promise.resolve();

export async function embedFile(relPath: string): Promise<boolean> {
  // Serialize access to the embedding store
  const prev = embedLock;
  let resolve: () => void;
  embedLock = new Promise<void>((r) => { resolve = r; });

  try {
    await prev; // Wait for any in-flight embedFile to finish

    const fullPath = join(VAULT_DIR, relPath);
    if (!existsSync(fullPath)) return false;

    const content = readFileSync(fullPath, "utf-8");
    const text = prepareText(content);
    if (!text) return false;

    const embedding = await generateEmbedding(text);
    if (!embedding) return false;

    const store = loadStore();
    const hash = simpleHash(content);
    const idx = store.findIndex((e) => e.path === relPath);
    const entry: EmbeddingEntry = {
      path: relPath,
      hash,
      embedding: normalizeVector(embedding),
      text: text.slice(0, 200),
      updatedAt: Date.now(),
    };

    if (idx >= 0) store[idx] = entry;
    else store.push(entry);

    saveStore(store);
    return true;
  } finally {
    resolve!();
  }
}

// ─── Semantic Search ─────────────────────────────────────────────────

export async function semanticSearch(query: string, limit: number = 5): Promise<SearchResult[]> {
  const store = loadStore();
  if (store.length === 0) return [];

  const queryEmbedding = await generateEmbedding(query);
  if (!queryEmbedding) return [];

  const normalized = normalizeVector(queryEmbedding);

  const scored: SearchResult[] = store.map((entry) => ({
    path: entry.path,
    text: entry.text,
    score: dotProduct(normalized, entry.embedding),
    matchType: "semantic" as const,
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ─── Temporal Decay ──────────────────────────────────────────────────
// Recent learnings rank higher. score × e^(-λ × ageInDays)
// Half-life of 30 days: λ = ln(2) / 30 ≈ 0.0231

const DECAY_HALF_LIFE_DAYS = 30;
const DECAY_LAMBDA = Math.LN2 / DECAY_HALF_LIFE_DAYS;

// Files exempt from temporal decay (always relevant regardless of age)
const EVERGREEN_PATTERNS = [
  /^shared\//, // shared knowledge, project knowledge, course notes
  /^agents\//, // agent working memory
];

function applyTemporalDecay(score: number, updatedAt: number, path: string): number {
  // Skip decay for evergreen files
  for (const pattern of EVERGREEN_PATTERNS) {
    if (pattern.test(path)) return score;
  }

  const ageMs = Date.now() - updatedAt;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return score;

  return score * Math.exp(-DECAY_LAMBDA * ageDays);
}

// ─── Hybrid Search (semantic + keyword) ──────────────────────────────

export async function hybridSearch(
  query: string,
  keywords: string[],
  limit: number = 5
): Promise<SearchResult[]> {
  const store = loadStore();
  if (store.length === 0) return [];

  // Semantic scoring
  const queryEmbedding = await generateEmbedding(query);
  const semanticScores = new Map<string, number>();

  if (queryEmbedding) {
    const normalized = normalizeVector(queryEmbedding);
    for (const entry of store) {
      semanticScores.set(entry.path, dotProduct(normalized, entry.embedding));
    }
  }

  // Keyword scoring (against the full file content for precision)
  const keywordScores = new Map<string, number>();
  if (keywords.length > 0) {
    for (const entry of store) {
      const fullPath = join(VAULT_DIR, entry.path);
      let content = "";
      try {
        content = readFileSync(fullPath, "utf-8").toLowerCase();
      } catch {
        content = entry.text.toLowerCase();
      }

      let kwScore = 0;
      for (const kw of keywords) {
        if (content.includes(kw.toLowerCase())) kwScore++;
      }
      if (kwScore > 0) {
        keywordScores.set(entry.path, kwScore / keywords.length);
      }
    }
  }

  // Build path→entry lookup for temporal decay
  const entryMap = new Map(store.map((e) => [e.path, e]));

  // Merge: 70% semantic + 30% keyword (when both available), then apply temporal decay
  const allPaths = new Set([...semanticScores.keys(), ...keywordScores.keys()]);
  const results: SearchResult[] = [];

  for (const path of allPaths) {
    const sem = semanticScores.get(path) || 0;
    const kw = keywordScores.get(path) || 0;
    const hasBoth = semanticScores.has(path) && keywordScores.has(path);

    let score: number;
    let matchType: "semantic" | "keyword" | "hybrid";

    if (hasBoth) {
      score = sem * 0.7 + kw * 0.3;
      matchType = "hybrid";
    } else if (semanticScores.has(path)) {
      score = sem * 0.7;
      matchType = "semantic";
    } else {
      score = kw * 0.3;
      matchType = "keyword";
    }

    // Apply temporal decay — recent entries rank higher
    const entry = entryMap.get(path);
    if (entry) {
      score = applyTemporalDecay(score, entry.updatedAt, path);
    }

    results.push({
      path,
      text: entry?.text || "",
      score,
      matchType,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ─── Vector Math ─────────────────────────────────────────────────────

function normalizeVector(v: number[]): number[] {
  let magnitude = 0;
  for (const x of v) magnitude += x * x;
  magnitude = Math.sqrt(magnitude);
  if (magnitude === 0) return v;
  return v.map((x) => x / magnitude);
}

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

// ─── Utility ─────────────────────────────────────────────────────────

export function isOllamaAvailable(): Promise<boolean> {
  return fetch("http://localhost:11434/api/tags")
    .then((r) => r.ok)
    .catch(() => false);
}

export function getStoreStats(): { fileCount: number; lastSync: number | null } {
  const store = loadStore();
  const lastSync = store.length > 0 ? Math.max(...store.map((e) => e.updatedAt)) : null;
  return { fileCount: store.length, lastSync };
}

// ─── Vault File Watcher ──────────────────────────────────────────────

// Track watchers and intervals for clean shutdown
const activeWatchers: FSWatcher[] = [];
let debounceInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Watches vault directories for new/changed .md files and auto-generates
 * embeddings. Uses fs.watch with debouncing to avoid duplicate events.
 */
export function watchVaultForEmbeddings(): void {
  const watchDirs = [
    join(VAULT_DIR, "learnings"),
    join(VAULT_DIR, "shared"),
    join(VAULT_DIR, "shared", "project-knowledge"),
    join(VAULT_DIR, "shared", "scouted"),
    join(VAULT_DIR, "shared", "course-notes", "numerical-methods"),
    join(VAULT_DIR, "shared", "course-notes", "philosophy"),
    join(VAULT_DIR, "shared", "course-notes", "systems-programming"),
    join(VAULT_DIR, "shared", "course-notes", "comp-society"),
    join(VAULT_DIR, "agents"),
    join(VAULT_DIR, "daily"),
  ];

  // Debounce: track recently processed files to avoid duplicate fs.watch events
  const recentlyProcessed = new Map<string, number>();
  const DEBOUNCE_MS = 3000;

  for (const dir of watchDirs) {
    if (!existsSync(dir)) continue;

    try {
      const watcher = watch(dir, (eventType, filename) => {
        if (!filename || !filename.endsWith(".md")) return;

        const relPath = join(relative(VAULT_DIR, dir), filename);
        const now = Date.now();
        const lastProcessed = recentlyProcessed.get(relPath) || 0;

        if (now - lastProcessed < DEBOUNCE_MS) return;
        recentlyProcessed.set(relPath, now);

        // Async embed — fire and forget
        embedFile(relPath).then((ok) => {
          if (ok) console.log(`[EMBEDDINGS] Auto-embedded: ${relPath}`);
        }).catch(() => {
          // Silently fail — will be caught on next full sync
        });
      });

      activeWatchers.push(watcher);
      console.log(`[EMBEDDINGS] Watching: ${relative(VAULT_DIR, dir)}/`);
    } catch (err: any) {
      console.error(`[EMBEDDINGS] Failed to watch ${dir}: ${err.message}`);
    }
  }

  // Clean up debounce map periodically
  debounceInterval = setInterval(() => {
    const cutoff = Date.now() - 60000;
    for (const [key, ts] of recentlyProcessed) {
      if (ts < cutoff) recentlyProcessed.delete(key);
    }
  }, 60000);
}

/**
 * Stop all vault embedding watchers and intervals. Call on shutdown.
 */
export function stopEmbeddingWatchers(): void {
  for (const watcher of activeWatchers) {
    watcher.close();
  }
  activeWatchers.length = 0;
  if (debounceInterval) {
    clearInterval(debounceInterval);
    debounceInterval = null;
  }
  console.log("[EMBEDDINGS] All watchers stopped");
}
