import { getDb } from "./db.js";

export interface ChannelConfig {
  agent?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  model?: string;
  updatedAt: string;
}

type ConfigMap = Record<string, ChannelConfig>;

function rowToConfig(row: any): ChannelConfig {
  return {
    agent: row.agent || undefined,
    permissionMode: row.permission_mode || undefined,
    allowedTools: row.allowed_tools ? JSON.parse(row.allowed_tools) : undefined,
    disallowedTools: row.disallowed_tools ? JSON.parse(row.disallowed_tools) : undefined,
    model: row.model || undefined,
    updatedAt: row.updated_at,
  };
}

export function getChannelConfig(channelId: string): ChannelConfig | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM channel_configs WHERE channel_id = ?").get(channelId);
  if (!row) return null;
  return rowToConfig(row);
}

export function setChannelConfig(
  channelId: string,
  config: Partial<Omit<ChannelConfig, "updatedAt">>
): ChannelConfig {
  const db = getDb();
  const existing = getChannelConfig(channelId);

  const merged = {
    agent: config.agent !== undefined ? config.agent : existing?.agent,
    permissionMode: config.permissionMode !== undefined ? config.permissionMode : existing?.permissionMode,
    allowedTools: config.allowedTools !== undefined ? config.allowedTools : existing?.allowedTools,
    disallowedTools: config.disallowedTools !== undefined ? config.disallowedTools : existing?.disallowedTools,
    model: config.model !== undefined ? config.model : existing?.model,
  };

  db.prepare(`
    INSERT INTO channel_configs (channel_id, agent, permission_mode, allowed_tools, disallowed_tools, model, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET
      agent = excluded.agent,
      permission_mode = excluded.permission_mode,
      allowed_tools = excluded.allowed_tools,
      disallowed_tools = excluded.disallowed_tools,
      model = excluded.model,
      updated_at = datetime('now')
  `).run(
    channelId,
    merged.agent || null,
    merged.permissionMode || null,
    merged.allowedTools ? JSON.stringify(merged.allowedTools) : null,
    merged.disallowedTools ? JSON.stringify(merged.disallowedTools) : null,
    merged.model || null
  );

  return {
    ...merged,
    updatedAt: new Date().toISOString(),
  } as ChannelConfig;
}

export function clearChannelConfig(channelId: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM channel_configs WHERE channel_id = ?").run(channelId);
  return result.changes > 0;
}

export function listConfigs(): ConfigMap {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM channel_configs").all() as any[];
  const map: ConfigMap = {};
  for (const row of rows) {
    map[row.channel_id] = rowToConfig(row);
  }
  return map;
}
