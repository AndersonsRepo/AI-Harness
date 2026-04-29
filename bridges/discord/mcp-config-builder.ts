import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getChannelConfig } from "./channel-config-store.js";

// Always-on baseline. These MCPs are needed by the context-assembler, chain
// transport, and core agent flow. Channels that don't set allowedMcps get
// this set. Adding more servers here costs file descriptors per spawn, so
// keep it tight — channel-specific MCPs (calendar, linkedin, trading) belong
// in per-channel allowlists, not the baseline.
export const DEFAULT_MCP_BASELINE = ["vault", "harness", "projects", "codex"];

export interface BuildMcpConfigOptions {
  channelId: string;
  taskId?: string;
  // Test seams
  registryPath?: string;
  outputDir?: string;
}

export interface McpConfigResult {
  configPath: string;
  // Names actually included (filtered against the registry — names in the
  // allowlist that aren't registered are silently dropped).
  servers: string[];
}

export function resolveAllowedMcps(channelId: string): string[] {
  const cfg = getChannelConfig(channelId);
  if (cfg?.allowedMcps !== undefined) {
    return cfg.allowedMcps;
  }
  return DEFAULT_MCP_BASELINE;
}

function readRegistry(registryPath: string): Record<string, unknown> {
  if (!existsSync(registryPath)) return {};
  try {
    const data = JSON.parse(readFileSync(registryPath, "utf-8"));
    return (data?.mcpServers && typeof data.mcpServers === "object") ? data.mcpServers : {};
  } catch {
    return {};
  }
}

/**
 * Build an ephemeral `--mcp-config` file containing only the servers allowed
 * for the given channel. The caller passes the returned path to Claude via
 * `--mcp-config <path> --strict-mcp-config`. The OS's tmpdir handles cleanup;
 * we don't unlink explicitly because the file may still be opened by a child
 * process when the parent task completes.
 */
export function buildMcpConfigFile(opts: BuildMcpConfigOptions): McpConfigResult {
  const allowed = resolveAllowedMcps(opts.channelId);
  const registryPath = opts.registryPath ?? join(homedir(), ".claude.json");
  const outputDir = opts.outputDir ?? tmpdir();

  const registry = readRegistry(registryPath);

  const filtered: Record<string, unknown> = {};
  const included: string[] = [];
  for (const name of allowed) {
    if (registry[name]) {
      filtered[name] = registry[name];
      included.push(name);
    }
  }

  const taskId = opts.taskId ?? `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const configPath = join(outputDir, `harness-mcp-${taskId}.json`);
  writeFileSync(configPath, JSON.stringify({ mcpServers: filtered }, null, 2));

  return { configPath, servers: included };
}
