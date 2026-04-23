import { getDb } from "./db.js";

type RuntimeTag = "claude" | "codex";

interface SessionEntry {
  sessionId: string;
  createdAt: string;
  lastUsed: string;
  runtime: RuntimeTag;
}

type SessionMap = Record<string, SessionEntry>;

export function getSession(channelId: string, runtime?: RuntimeTag): string | null {
  const db = getDb();
  if (runtime) {
    const row = db.prepare(
      "SELECT session_id FROM sessions WHERE channel_id = ? AND runtime = ?"
    ).get(channelId, runtime) as { session_id: string } | undefined;
    if (!row) return null;
    db.prepare("UPDATE sessions SET last_used = datetime('now') WHERE channel_id = ? AND runtime = ?").run(channelId, runtime);
    return row.session_id;
  }

  const latest = db.prepare(
    "SELECT session_id, runtime FROM sessions WHERE channel_id = ? ORDER BY last_used DESC LIMIT 1"
  ).get(channelId) as { session_id: string; runtime: string } | undefined;
  if (!latest) return null;

  db.prepare("UPDATE sessions SET last_used = datetime('now') WHERE channel_id = ? AND runtime = ?").run(channelId, latest.runtime);
  return latest.session_id;
}

export function setSession(channelId: string, sessionId: string, runtime: RuntimeTag = "claude"): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO sessions (channel_id, session_id, runtime, created_at, last_used)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(channel_id, runtime) DO UPDATE SET
      session_id = excluded.session_id,
      last_used = datetime('now')
  `).run(channelId, sessionId, runtime);
}

export function clearSession(channelId: string, runtime?: RuntimeTag): boolean {
  const db = getDb();
  const result = runtime
    ? db.prepare("DELETE FROM sessions WHERE channel_id = ? AND runtime = ?").run(channelId, runtime)
    : db.prepare("DELETE FROM sessions WHERE channel_id = ?").run(channelId);
  return result.changes > 0;
}

/**
 * Clear all sessions for a channel, including compound keys (channelId:agentName).
 * Used by /new in project channels where each agent has its own session.
 */
export function clearChannelSessions(channelId: string): number {
  const db = getDb();
  // Clear exact match + compound keys starting with channelId:
  const result = db.prepare(
    "DELETE FROM sessions WHERE channel_id = ? OR channel_id LIKE ?"
  ).run(channelId, `${channelId}:%`);
  return result.changes;
}

export function validateSession(channelId: string, runtime?: RuntimeTag): boolean {
  const db = getDb();
  const row = runtime
    ? db.prepare("SELECT channel_id FROM sessions WHERE channel_id = ? AND runtime = ?").get(channelId, runtime)
    : db.prepare("SELECT channel_id FROM sessions WHERE channel_id = ?").get(channelId);
  if (!row) return true; // No session = valid
  clearSession(channelId, runtime);
  console.log(`[SESSION] Cleared stale session for channel ${channelId}${runtime ? ` (${runtime})` : ""}`);
  return false;
}

export function listSessions(): SessionMap {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM sessions").all() as Array<{
    channel_id: string;
    session_id: string;
    runtime?: string;
    created_at: string;
    last_used: string;
  }>;

  const map: SessionMap = {};
  for (const row of rows) {
    const entry: SessionEntry = {
      sessionId: row.session_id,
      createdAt: row.created_at,
      lastUsed: row.last_used,
      runtime: row.runtime === "codex" ? "codex" : "claude",
    };

    if (entry.runtime === "claude" && !map[row.channel_id]) {
      map[row.channel_id] = entry;
    }
    map[`${row.channel_id}:${entry.runtime}`] = entry;
  }
  return map;
}
