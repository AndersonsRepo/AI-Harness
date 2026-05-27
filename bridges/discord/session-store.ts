import { getDb } from "./db.js";

type RuntimeTag = "claude" | "codex" | "ollama";

interface SessionEntry {
  sessionId: string;
  createdAt: string;
  lastUsed: string;
  runtime: RuntimeTag;
}

type SessionMap = Record<string, SessionEntry>;

type SessionsKeyShape = "channel-runtime" | "channel-only" | "unknown";

function getSessionsKeyShape(): SessionsKeyShape {
  const db = getDb();
  const rows = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
    name: string;
    pk: number;
  }>;

  const pkCols = rows
    .filter((row) => row.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((row) => row.name);

  if (pkCols.length === 2 && pkCols[0] === "channel_id" && pkCols[1] === "runtime") {
    return "channel-runtime";
  }

  if (pkCols.length === 1 && pkCols[0] === "channel_id") {
    return "channel-only";
  }

  return "unknown";
}

/**
 * Default age beyond which a stored session id is considered stale and
 * skipped on resume — `codex exec resume <stale-id>` hangs silently for
 * 10+ minutes on some stale threads instead of failing fast, so we'd
 * rather cold-start a fresh thread once a day's gone by. Both runtimes
 * use the same default; override per-runtime via env if needed.
 */
const SESSION_RESUME_MAX_AGE_HOURS = parseFloat(
  process.env.SESSION_RESUME_MAX_AGE_HOURS || "24",
);
export const SESSION_RESUME_MAX_AGE_MS = SESSION_RESUME_MAX_AGE_HOURS * 60 * 60 * 1000;

export interface GetSessionOptions {
  /** When set, return null if last_response_at is older than this many ms. */
  maxAgeMs?: number;
}

function isFreshEnough(lastResponseAt: string | null | undefined, maxAgeMs: number | undefined): boolean {
  if (maxAgeMs === undefined) return true;
  if (!lastResponseAt) return false;
  // SQLite datetime('now') stores 'YYYY-MM-DD HH:MM:SS' in UTC. Append 'Z'
  // so Date.parse treats it as UTC instead of local time.
  const ts = Date.parse(lastResponseAt.replace(" ", "T") + "Z");
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts <= maxAgeMs;
}

export function getSession(
  channelId: string,
  runtime?: RuntimeTag,
  opts?: GetSessionOptions,
): string | null {
  const db = getDb();
  const keyShape = getSessionsKeyShape();
  const maxAgeMs = opts?.maxAgeMs;
  // Older schemas don't have last_response_at; only filter by age when
  // the column exists, otherwise fall back to "always fresh" (no-op).
  const hasResponseAt = columnExistsSafe(db, "sessions", "last_response_at");
  const selectCols = hasResponseAt ? "session_id, last_response_at" : "session_id";

  if (runtime) {
    if (keyShape === "channel-runtime") {
      const row = db.prepare(
        `SELECT ${selectCols} FROM sessions WHERE channel_id = ? AND runtime = ?`,
      ).get(channelId, runtime) as { session_id: string; last_response_at?: string } | undefined;
      if (!row) return null;
      if (hasResponseAt && !isFreshEnough(row.last_response_at, maxAgeMs)) return null;
      db.prepare("UPDATE sessions SET last_used = datetime('now') WHERE channel_id = ? AND runtime = ?").run(channelId, runtime);
      return row.session_id;
    }

    if (keyShape === "channel-only") {
      const row = db.prepare(
        `SELECT ${selectCols} FROM sessions WHERE channel_id = ?`,
      ).get(channelId) as { session_id: string; last_response_at?: string } | undefined;
      if (!row) return null;
      if (hasResponseAt && !isFreshEnough(row.last_response_at, maxAgeMs)) return null;
      db.prepare("UPDATE sessions SET last_used = datetime('now') WHERE channel_id = ?").run(channelId);
      return row.session_id;
    }

    try {
      const row = db.prepare(
        `SELECT ${selectCols} FROM sessions WHERE channel_id = ? AND runtime = ?`,
      ).get(channelId, runtime) as { session_id: string; last_response_at?: string } | undefined;
      if (!row) return null;
      if (hasResponseAt && !isFreshEnough(row.last_response_at, maxAgeMs)) return null;
      db.prepare("UPDATE sessions SET last_used = datetime('now') WHERE channel_id = ? AND runtime = ?").run(channelId, runtime);
      return row.session_id;
    } catch {
      const row = db.prepare(
        `SELECT ${selectCols} FROM sessions WHERE channel_id = ?`,
      ).get(channelId) as { session_id: string; last_response_at?: string } | undefined;
      if (!row) return null;
      if (hasResponseAt && !isFreshEnough(row.last_response_at, maxAgeMs)) return null;
      db.prepare("UPDATE sessions SET last_used = datetime('now') WHERE channel_id = ?").run(channelId);
      return row.session_id;
    }
  }

  if (keyShape === "channel-runtime") {
    const latest = db.prepare(
      `SELECT ${selectCols}, runtime FROM sessions WHERE channel_id = ? ORDER BY last_used DESC LIMIT 1`,
    ).get(channelId) as { session_id: string; runtime: string; last_response_at?: string } | undefined;
    if (!latest) return null;
    if (hasResponseAt && !isFreshEnough(latest.last_response_at, maxAgeMs)) return null;

    db.prepare("UPDATE sessions SET last_used = datetime('now') WHERE channel_id = ? AND runtime = ?").run(channelId, latest.runtime);
    return latest.session_id;
  }

  const latest = db.prepare(
    `SELECT ${selectCols} FROM sessions WHERE channel_id = ? ORDER BY last_used DESC LIMIT 1`,
  ).get(channelId) as { session_id: string; last_response_at?: string } | undefined;
  if (!latest) return null;
  if (hasResponseAt && !isFreshEnough(latest.last_response_at, maxAgeMs)) return null;
  db.prepare("UPDATE sessions SET last_used = datetime('now') WHERE channel_id = ?").run(channelId);
  return latest.session_id;
}

function columnExistsSafe(
  db: ReturnType<typeof getDb>,
  table: string,
  column: string,
): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  } catch {
    return false;
  }
}

export function setSession(channelId: string, sessionId: string, runtime: RuntimeTag = "claude"): void {
  const db = getDb();
  const keyShape = getSessionsKeyShape();
  // last_response_at exists only after migration v20. On older schemas the
  // column omission is silent (the SET clause references nothing missing).
  const hasResponseAt = columnExistsSafe(db, "sessions", "last_response_at");
  const insertCols = hasResponseAt
    ? "channel_id, session_id, runtime, created_at, last_used, last_response_at"
    : "channel_id, session_id, runtime, created_at, last_used";
  const insertVals = hasResponseAt
    ? "?, ?, ?, datetime('now'), datetime('now'), datetime('now')"
    : "?, ?, ?, datetime('now'), datetime('now')";
  const updateLastUsed = hasResponseAt
    ? "last_used = datetime('now'), last_response_at = datetime('now')"
    : "last_used = datetime('now')";

  if (keyShape === "channel-runtime") {
    db.prepare(`
      INSERT INTO sessions (${insertCols})
      VALUES (${insertVals})
      ON CONFLICT(channel_id, runtime) DO UPDATE SET
        session_id = excluded.session_id,
        ${updateLastUsed}
    `).run(channelId, sessionId, runtime);
    return;
  }

  if (keyShape === "channel-only") {
    db.prepare(`
      INSERT INTO sessions (${insertCols})
      VALUES (${insertVals})
      ON CONFLICT(channel_id) DO UPDATE SET
        session_id = excluded.session_id,
        runtime = excluded.runtime,
        ${updateLastUsed}
    `).run(channelId, sessionId, runtime);
    return;
  }

  // Last-resort compatibility path for drifted schemas. Prefer preserving
  // task completion over throwing during post-response session persistence.
  const updateByRuntime = db.prepare(`
    UPDATE sessions
    SET session_id = ?, ${updateLastUsed}
    WHERE channel_id = ? AND runtime = ?
  `).run(sessionId, channelId, runtime);

  if (updateByRuntime.changes > 0) {
    return;
  }

  try {
    db.prepare(`
      INSERT INTO sessions (${insertCols})
      VALUES (${insertVals})
    `).run(channelId, sessionId, runtime);
  } catch (err: any) {
    db.prepare(`
      UPDATE sessions
      SET session_id = ?, runtime = ?, ${updateLastUsed}
      WHERE channel_id = ?
    `).run(sessionId, runtime, channelId);
    console.warn(`[SESSION] Fallback session write used for ${channelId}: ${err.message}`);
  }
}

export function clearSession(channelId: string, runtime?: RuntimeTag): boolean {
  const db = getDb();
  const keyShape = getSessionsKeyShape();

  let result;
  if (runtime && keyShape === "channel-runtime") {
    result = db.prepare("DELETE FROM sessions WHERE channel_id = ? AND runtime = ?").run(channelId, runtime);
  } else {
    result = db.prepare("DELETE FROM sessions WHERE channel_id = ?").run(channelId);
  }
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

/**
 * Clear sessions older than their agent.md file's mtime. Targets compound-keyed
 * project sessions (`<channelId>:<agentName>`) — these dominate the bot's
 * session footprint and are the source of the "edited orchestrator.md but
 * change didn't take effect" gotcha. Non-project channels keep their session
 * and can be refreshed via /new.
 *
 * Returns per-agent clear counts for any agent that had at least one stale
 * session removed. Agents whose .md file doesn't exist or has no stale
 * sessions are simply omitted.
 */
export function clearStaleAgentSessions(
  agentMtimesMs: Map<string, number>,
): { agent: string; cleared: number }[] {
  const db = getDb();
  const results: { agent: string; cleared: number }[] = [];

  for (const [agent, mtimeMs] of agentMtimesMs) {
    // SQLite's datetime('now') stores text in 'YYYY-MM-DD HH:MM:SS' UTC format.
    // ISO string is 'YYYY-MM-DDTHH:MM:SS.sssZ' — slice + replace to match.
    const mtimeIso = new Date(mtimeMs).toISOString().replace("T", " ").slice(0, 19);

    const result = db.prepare(
      "DELETE FROM sessions WHERE channel_id LIKE ? AND created_at < ?"
    ).run(`%:${agent}`, mtimeIso);

    if (result.changes > 0) {
      results.push({ agent, cleared: result.changes });
    }
  }

  return results;
}

export function validateSession(channelId: string, runtime?: RuntimeTag): boolean {
  const db = getDb();
  const keyShape = getSessionsKeyShape();

  const row = runtime && keyShape === "channel-runtime"
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
