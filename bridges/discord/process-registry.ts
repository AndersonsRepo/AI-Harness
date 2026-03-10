import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export interface SubagentEntry {
  id: string;
  parentChannelId: string;
  description: string;
  agent?: string;
  outputFile: string;
  pid: number;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  streamMessageId?: string;
}

type RegistryMap = Record<string, SubagentEntry>;

// In-memory cache
let cache: RegistryMap | null = null;

function getStorePath(): string {
  return join(
    process.env.HARNESS_ROOT || ".",
    "bridges",
    "discord",
    "subagents.json"
  );
}

function load(): RegistryMap {
  if (cache) return cache;
  if (!existsSync(getStorePath())) {
    cache = {};
    return cache;
  }
  try {
    cache = JSON.parse(readFileSync(getStorePath(), "utf-8"));
    return cache!;
  } catch {
    cache = {};
    return cache;
  }
}

function save(): void {
  if (!cache) return;
  writeFileSync(getStorePath(), JSON.stringify(cache, null, 2));
}

export function register(entry: SubagentEntry): void {
  const map = load();
  map[entry.id] = entry;
  save();
}

export function update(
  id: string,
  updates: Partial<SubagentEntry>
): SubagentEntry | null {
  const map = load();
  if (!map[id]) return null;
  Object.assign(map[id], updates);
  save();
  return map[id];
}

export function get(id: string): SubagentEntry | null {
  const map = load();
  return map[id] || null;
}

export function getRunning(): SubagentEntry[] {
  const map = load();
  return Object.values(map).filter((e) => e.status === "running");
}

export function getByChannel(channelId: string): SubagentEntry[] {
  const map = load();
  return Object.values(map).filter((e) => e.parentChannelId === channelId);
}

export function cleanupStale(): number {
  const map = load();
  let cleaned = 0;
  for (const [id, entry] of Object.entries(map)) {
    if (entry.status !== "running") continue;
    try {
      process.kill(entry.pid, 0); // Check if process exists
    } catch {
      // Process is dead — mark as failed
      map[id].status = "failed";
      map[id].completedAt = new Date().toISOString();
      cleaned++;
    }
  }
  if (cleaned > 0) save();
  return cleaned;
}

export function invalidateCache(): void {
  cache = null;
}
