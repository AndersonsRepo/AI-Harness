import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export interface ChannelConfig {
  agent?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  model?: string;
  updatedAt: string;
}

type ConfigMap = Record<string, ChannelConfig>;

function getStorePath(): string {
  return join(
    process.env.HARNESS_ROOT || ".",
    "bridges",
    "discord",
    "channel-config.json"
  );
}

function load(): ConfigMap {
  if (!existsSync(getStorePath())) return {};
  try {
    return JSON.parse(readFileSync(getStorePath(), "utf-8"));
  } catch {
    return {};
  }
}

function save(map: ConfigMap): void {
  writeFileSync(getStorePath(), JSON.stringify(map, null, 2));
}

export function getChannelConfig(channelId: string): ChannelConfig | null {
  const map = load();
  return map[channelId] || null;
}

export function setChannelConfig(
  channelId: string,
  config: Partial<Omit<ChannelConfig, "updatedAt">>
): ChannelConfig {
  const map = load();
  const existing = map[channelId] || {};
  const updated: ChannelConfig = {
    ...existing,
    ...config,
    updatedAt: new Date().toISOString(),
  };
  // Remove undefined fields
  for (const key of Object.keys(updated) as (keyof ChannelConfig)[]) {
    if (updated[key] === undefined) delete updated[key];
  }
  map[channelId] = updated;
  save(map);
  return updated;
}

export function clearChannelConfig(channelId: string): boolean {
  const map = load();
  if (!map[channelId]) return false;
  delete map[channelId];
  save(map);
  return true;
}

export function listConfigs(): ConfigMap {
  return load();
}
