import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import {
  Guild,
  TextChannel,
  ChannelType,
  CategoryChannel,
} from "discord.js";
import { setChannelConfig } from "./channel-config-store.js";

export interface ProjectConfig {
  channelId: string;
  categoryId: string;
  guildId: string;
  name: string;
  description: string;
  agents: string[];
  activeAgent?: string;
  handoffDepth: number;
  maxHandoffDepth: number;
  createdAt: string;
}

type ProjectMap = Record<string, ProjectConfig>;

const PROJECTS_CATEGORY_NAME = "Projects";
const DEFAULT_AGENTS = ["researcher", "reviewer", "builder", "ops"];
const DEFAULT_MAX_DEPTH = 5;

function getStorePath(): string {
  return join(
    process.env.HARNESS_ROOT || ".",
    "bridges",
    "discord",
    "projects.json"
  );
}

function load(): ProjectMap {
  if (!existsSync(getStorePath())) return {};
  try {
    return JSON.parse(readFileSync(getStorePath(), "utf-8"));
  } catch {
    return {};
  }
}

function save(map: ProjectMap): void {
  writeFileSync(getStorePath(), JSON.stringify(map, null, 2));
}

export function getProject(channelId: string): ProjectConfig | null {
  const map = load();
  return map[channelId] || null;
}

export function getProjectByName(name: string): ProjectConfig | null {
  const map = load();
  return Object.values(map).find((p) => p.name === name) || null;
}

export function listProjects(): ProjectConfig[] {
  return Object.values(load());
}

export function updateProject(
  channelId: string,
  updates: Partial<ProjectConfig>
): ProjectConfig | null {
  const map = load();
  if (!map[channelId]) return null;
  Object.assign(map[channelId], updates);
  save(map);
  return map[channelId];
}

export function deleteProject(channelId: string): boolean {
  const map = load();
  if (!map[channelId]) return false;
  delete map[channelId];
  save(map);
  return true;
}

async function findOrCreateCategory(guild: Guild): Promise<CategoryChannel> {
  // Look for existing "Projects" category
  const existing = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildCategory &&
      c.name.toLowerCase() === PROJECTS_CATEGORY_NAME.toLowerCase()
  );
  if (existing) return existing as CategoryChannel;

  // Create the category
  return guild.channels.create({
    name: PROJECTS_CATEGORY_NAME,
    type: ChannelType.GuildCategory,
    reason: "AI Harness project channels",
  });
}

export async function createProject(
  guild: Guild,
  name: string,
  description: string,
  agents?: string[]
): Promise<ProjectConfig> {
  const category = await findOrCreateCategory(guild);

  // Create the channel under the Projects category
  const channel = await guild.channels.create({
    name: `proj-${name}`,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: description,
    reason: `AI Harness project: ${name}`,
  });

  const projectAgents = agents || DEFAULT_AGENTS;

  const project: ProjectConfig = {
    channelId: channel.id,
    categoryId: category.id,
    guildId: guild.id,
    name,
    description,
    agents: projectAgents,
    handoffDepth: 0,
    maxHandoffDepth: DEFAULT_MAX_DEPTH,
    createdAt: new Date().toISOString(),
  };

  // Save to store
  const map = load();
  map[channel.id] = project;
  save(map);

  // Also set channel config so the bot recognizes this as a project channel
  setChannelConfig(channel.id, {
    agent: projectAgents[0], // Default to first agent
  });

  return project;
}

export async function closeProject(
  guild: Guild,
  channelId: string
): Promise<boolean> {
  const project = getProject(channelId);
  if (!project) return false;

  try {
    const channel = guild.channels.cache.get(channelId);
    if (channel) {
      // Move to an "Archived" prefix rather than deleting
      await channel.edit({
        name: `archived-${project.name}`,
        parent: null, // Remove from category
        reason: "Project closed",
      });
    }
  } catch {}

  deleteProject(channelId);
  return true;
}

export function resetHandoffDepth(channelId: string): void {
  const map = load();
  if (map[channelId]) {
    map[channelId].handoffDepth = 0;
    save(map);
  }
}

export function incrementHandoffDepth(channelId: string): number {
  const map = load();
  if (!map[channelId]) return 0;
  map[channelId].handoffDepth++;
  save(map);
  return map[channelId].handoffDepth;
}

export function isProjectChannel(channelId: string): boolean {
  return getProject(channelId) !== null;
}

/**
 * Auto-adopt a channel as a project if it's under the Projects category
 * but not yet registered. Returns the new project config or null.
 */
export function autoAdoptIfInCategory(
  channelId: string,
  channelName: string,
  parentId: string | null,
  guildId: string
): ProjectConfig | null {
  // Already registered
  if (getProject(channelId)) return null;
  // No parent category
  if (!parentId) return null;

  // Check if the parent category is "Projects" by looking at existing projects
  // or by matching the parentId against known category IDs
  const existing = listProjects();
  const knownCategoryIds = new Set(existing.map((p) => p.categoryId));

  // If we have no projects yet, we can't match by ID — caller must check category name
  // This function is called with verified category info from bot.ts
  const name = channelName.replace(/^proj-/, "");

  const project: ProjectConfig = {
    channelId,
    categoryId: parentId,
    guildId,
    name,
    description: `Auto-adopted from #${channelName}`,
    agents: DEFAULT_AGENTS,
    handoffDepth: 0,
    maxHandoffDepth: DEFAULT_MAX_DEPTH,
    createdAt: new Date().toISOString(),
  };

  const map = load();
  map[channelId] = project;
  save(map);

  setChannelConfig(channelId, { agent: DEFAULT_AGENTS[0] });

  return project;
}

/**
 * Adopt an existing channel as a project (for /project adopt command).
 */
export function adoptChannel(
  channelId: string,
  channelName: string,
  parentId: string | null,
  guildId: string,
  description?: string,
  agents?: string[]
): ProjectConfig {
  const name = channelName.replace(/^proj-/, "");
  const projectAgents = agents || DEFAULT_AGENTS;

  const project: ProjectConfig = {
    channelId,
    categoryId: parentId || "",
    guildId,
    name,
    description: description || `Project channel #${channelName}`,
    agents: projectAgents,
    handoffDepth: 0,
    maxHandoffDepth: DEFAULT_MAX_DEPTH,
    createdAt: new Date().toISOString(),
  };

  const map = load();
  map[channelId] = project;
  save(map);

  setChannelConfig(channelId, { agent: projectAgents[0] });

  return project;
}

/**
 * Get the category ID for "Projects" in a guild, if it exists.
 */
export function getProjectsCategoryName(): string {
  return PROJECTS_CATEGORY_NAME;
}
