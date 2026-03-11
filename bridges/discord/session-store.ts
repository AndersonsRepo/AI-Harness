import { getDb } from "./db.js";

interface SessionEntry {
  sessionId: string;
  createdAt: string;
  lastUsed: string;
}

type SessionMap = Record<string, SessionEntry>;

export function getSession(channelId: string): string | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT session_id FROM sessions WHERE channel_id = ?"
  ).get(channelId) as { session_id: string } | undefined;

  if (!row) return null;

  // Update last used
  db.prepare("UPDATE sessions SET last_used = datetime('now') WHERE channel_id = ?").run(channelId);
  return row.session_id;
}

export function setSession(channelId: string, sessionId: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO sessions (channel_id, session_id, created_at, last_used)
    VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET
      session_id = excluded.session_id,
      last_used = datetime('now')
  `).run(channelId, sessionId);
}

export function clearSession(channelId: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM sessions WHERE channel_id = ?").run(channelId);
  return result.changes > 0;
}

export function validateSession(channelId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT channel_id FROM sessions WHERE channel_id = ?").get(channelId);
  if (!row) return true; // No session = valid
  db.prepare("DELETE FROM sessions WHERE channel_id = ?").run(channelId);
  console.log(`[SESSION] Cleared stale session for channel ${channelId}`);
  return false;
}

export function listSessions(): SessionMap {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM sessions").all() as Array<{
    channel_id: string;
    session_id: string;
    created_at: string;
    last_used: string;
  }>;

  const map: SessionMap = {};
  for (const row of rows) {
    map[row.channel_id] = {
      sessionId: row.session_id,
      createdAt: row.created_at,
      lastUsed: row.last_used,
    };
  }
  return map;
}
