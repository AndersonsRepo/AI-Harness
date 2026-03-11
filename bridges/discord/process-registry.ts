import { getDb } from "./db.js";

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

function rowToEntry(row: any): SubagentEntry {
  return {
    id: row.id,
    parentChannelId: row.parent_channel_id,
    description: row.description,
    agent: row.agent || undefined,
    outputFile: row.output_file,
    pid: row.pid,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at || undefined,
    streamMessageId: row.stream_message_id || undefined,
  };
}

export function register(entry: SubagentEntry): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO subagents (id, parent_channel_id, description, agent, output_file, pid, status, started_at, completed_at, stream_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.id,
    entry.parentChannelId,
    entry.description,
    entry.agent || null,
    entry.outputFile,
    entry.pid,
    entry.status,
    entry.startedAt,
    entry.completedAt || null,
    entry.streamMessageId || null
  );
}

export function update(
  id: string,
  updates: Partial<SubagentEntry>
): SubagentEntry | null {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM subagents WHERE id = ?").get(id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
  if (updates.completedAt !== undefined) { fields.push("completed_at = ?"); values.push(updates.completedAt); }
  if (updates.streamMessageId !== undefined) { fields.push("stream_message_id = ?"); values.push(updates.streamMessageId); }
  if (updates.parentChannelId !== undefined) { fields.push("parent_channel_id = ?"); values.push(updates.parentChannelId); }
  if (updates.description !== undefined) { fields.push("description = ?"); values.push(updates.description); }
  if (updates.agent !== undefined) { fields.push("agent = ?"); values.push(updates.agent); }
  if (updates.outputFile !== undefined) { fields.push("output_file = ?"); values.push(updates.outputFile); }
  if (updates.pid !== undefined) { fields.push("pid = ?"); values.push(updates.pid); }

  if (fields.length === 0) return rowToEntry(existing);

  values.push(id);
  db.prepare(`UPDATE subagents SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  const updated = db.prepare("SELECT * FROM subagents WHERE id = ?").get(id);
  return updated ? rowToEntry(updated) : null;
}

export function get(id: string): SubagentEntry | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM subagents WHERE id = ?").get(id);
  return row ? rowToEntry(row) : null;
}

export function getRunning(): SubagentEntry[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM subagents WHERE status = 'running'").all();
  return rows.map(rowToEntry);
}

export function getByChannel(channelId: string): SubagentEntry[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM subagents WHERE parent_channel_id = ?").all(channelId);
  return rows.map(rowToEntry);
}

export function cleanupStale(): number {
  const db = getDb();
  const running = db.prepare("SELECT * FROM subagents WHERE status = 'running'").all() as any[];
  let cleaned = 0;

  for (const row of running) {
    try {
      process.kill(row.pid, 0);
    } catch {
      db.prepare("UPDATE subagents SET status = 'failed', completed_at = datetime('now') WHERE id = ?").run(row.id);
      cleaned++;
    }
  }

  return cleaned;
}
