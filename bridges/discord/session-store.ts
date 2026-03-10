import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

interface SessionEntry {
  sessionId: string;
  createdAt: string;
  lastUsed: string;
}

type SessionMap = Record<string, SessionEntry>;

function getStorePath(): string {
  return join(
    process.env.HARNESS_ROOT || ".",
    "bridges",
    "discord",
    "sessions.json"
  );
}

function load(): SessionMap {
  if (!existsSync(getStorePath())) return {};
  try {
    return JSON.parse(readFileSync(getStorePath(), "utf-8"));
  } catch {
    return {};
  }
}

function save(map: SessionMap): void {
  writeFileSync(getStorePath(), JSON.stringify(map, null, 2));
}

export function getSession(channelId: string): string | null {
  const map = load();
  const entry = map[channelId];
  if (!entry) return null;
  // Update last used
  entry.lastUsed = new Date().toISOString();
  save(map);
  return entry.sessionId;
}

export function setSession(channelId: string, sessionId: string): void {
  const map = load();
  map[channelId] = {
    sessionId,
    createdAt: map[channelId]?.createdAt || new Date().toISOString(),
    lastUsed: new Date().toISOString(),
  };
  save(map);
}

export function clearSession(channelId: string): boolean {
  const map = load();
  if (!map[channelId]) return false;
  delete map[channelId];
  save(map);
  return true;
}

export function listSessions(): SessionMap {
  return load();
}
