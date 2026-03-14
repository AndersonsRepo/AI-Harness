import {
  Guild,
  TextChannel,
  ChannelType,
  CategoryChannel,
} from "discord.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { setChannelConfig } from "./channel-config-store.js";
import { getDb } from "./db.js";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";

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

const PROJECTS_CATEGORY_NAME = "Projects";
const DEFAULT_AGENTS = ["orchestrator", "researcher", "reviewer", "builder", "ops"];
const DEFAULT_MAX_DEPTH = 5;

function rowToProject(row: any): ProjectConfig {
  return {
    channelId: row.channel_id,
    categoryId: row.category_id,
    guildId: row.guild_id,
    name: row.name,
    description: row.description,
    agents: JSON.parse(row.agents),
    activeAgent: row.active_agent || undefined,
    handoffDepth: row.handoff_depth,
    maxHandoffDepth: row.max_handoff_depth,
    createdAt: row.created_at,
  };
}

export function getProject(channelId: string): ProjectConfig | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM projects WHERE channel_id = ?").get(channelId);
  return row ? rowToProject(row) : null;
}

export function getProjectByName(name: string): ProjectConfig | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM projects WHERE name = ?").get(name);
  return row ? rowToProject(row) : null;
}

export function listProjects(): ProjectConfig[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM projects").all();
  return rows.map(rowToProject);
}

export function updateProject(
  channelId: string,
  updates: Partial<ProjectConfig>
): ProjectConfig | null {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM projects WHERE channel_id = ?").get(channelId);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (updates.categoryId !== undefined) { fields.push("category_id = ?"); values.push(updates.categoryId); }
  if (updates.guildId !== undefined) { fields.push("guild_id = ?"); values.push(updates.guildId); }
  if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
  if (updates.description !== undefined) { fields.push("description = ?"); values.push(updates.description); }
  if (updates.agents !== undefined) { fields.push("agents = ?"); values.push(JSON.stringify(updates.agents)); }
  if (updates.activeAgent !== undefined) { fields.push("active_agent = ?"); values.push(updates.activeAgent); }
  if (updates.handoffDepth !== undefined) { fields.push("handoff_depth = ?"); values.push(updates.handoffDepth); }
  if (updates.maxHandoffDepth !== undefined) { fields.push("max_handoff_depth = ?"); values.push(updates.maxHandoffDepth); }

  if (fields.length === 0) return rowToProject(existing);

  values.push(channelId);
  db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE channel_id = ?`).run(...values);

  const updated = db.prepare("SELECT * FROM projects WHERE channel_id = ?").get(channelId);
  return updated ? rowToProject(updated) : null;
}

export function deleteProject(channelId: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM projects WHERE channel_id = ?").run(channelId);
  return result.changes > 0;
}

async function findOrCreateCategory(guild: Guild): Promise<CategoryChannel> {
  const existing = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildCategory &&
      c.name.toLowerCase() === PROJECTS_CATEGORY_NAME.toLowerCase()
  );
  if (existing) return existing as CategoryChannel;

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

  const db = getDb();
  db.prepare(`
    INSERT INTO projects (channel_id, category_id, guild_id, name, description, agents, handoff_depth, max_handoff_depth, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project.channelId,
    project.categoryId,
    project.guildId,
    project.name,
    project.description,
    JSON.stringify(project.agents),
    project.handoffDepth,
    project.maxHandoffDepth,
    project.createdAt
  );

  setChannelConfig(channel.id, { agent: projectAgents[0] });

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
      await channel.edit({
        name: `archived-${project.name}`,
        parent: null,
        reason: "Project closed",
      });
    }
  } catch {}

  deleteProject(channelId);
  return true;
}

export function resetHandoffDepth(channelId: string): void {
  const db = getDb();
  db.prepare("UPDATE projects SET handoff_depth = 0 WHERE channel_id = ?").run(channelId);
}

export function incrementHandoffDepth(channelId: string): number {
  const db = getDb();
  db.prepare("UPDATE projects SET handoff_depth = handoff_depth + 1 WHERE channel_id = ?").run(channelId);
  const row = db.prepare("SELECT handoff_depth FROM projects WHERE channel_id = ?").get(channelId) as { handoff_depth: number } | undefined;
  return row?.handoff_depth ?? 0;
}

export function isProjectChannel(channelId: string): boolean {
  return getProject(channelId) !== null;
}

export function autoAdoptIfInCategory(
  channelId: string,
  channelName: string,
  parentId: string | null,
  guildId: string
): ProjectConfig | null {
  if (getProject(channelId)) return null;
  if (!parentId) return null;

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

  const db = getDb();
  db.prepare(`
    INSERT INTO projects (channel_id, category_id, guild_id, name, description, agents, handoff_depth, max_handoff_depth, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project.channelId,
    project.categoryId,
    project.guildId,
    project.name,
    project.description,
    JSON.stringify(project.agents),
    project.handoffDepth,
    project.maxHandoffDepth,
    project.createdAt
  );

  setChannelConfig(channelId, { agent: DEFAULT_AGENTS[0] });

  return project;
}

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

  const db = getDb();
  db.prepare(`
    INSERT INTO projects (channel_id, category_id, guild_id, name, description, agents, handoff_depth, max_handoff_depth, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project.channelId,
    project.categoryId,
    project.guildId,
    project.name,
    project.description,
    JSON.stringify(project.agents),
    project.handoffDepth,
    project.maxHandoffDepth,
    project.createdAt
  );

  setChannelConfig(channelId, { agent: projectAgents[0] });

  return project;
}

export function getProjectsCategoryName(): string {
  return PROJECTS_CATEGORY_NAME;
}

/**
 * Resolve the filesystem working directory for a project.
 * Looks up the project name in heartbeat-tasks/projects.json and resolves
 * env vars ($HOME, $HARNESS_ROOT) in the path. Returns null if not found
 * or path doesn't exist.
 */
export function resolveProjectWorkdir(projectName: string): string | null {
  try {
    const projectsFile = join(HARNESS_ROOT, "heartbeat-tasks", "projects.json");
    if (!existsSync(projectsFile)) return null;

    const data = JSON.parse(readFileSync(projectsFile, "utf-8"));
    // Case-insensitive lookup: Discord channel names may differ in case from projects.json keys
    const projectKey = Object.keys(data.projects || {}).find(
      (k) => k.toLowerCase() === projectName.toLowerCase()
    );
    const entry = projectKey ? data.projects[projectKey] : null;
    if (!entry?.path) return null;

    // Resolve environment variables in path
    const resolved = entry.path
      .replace(/\$HOME/g, process.env.HOME || "")
      .replace(/\$HARNESS_ROOT/g, HARNESS_ROOT);

    if (!existsSync(resolved)) {
      console.warn(`[project-manager] Project path not found: ${resolved} (project: ${projectName})`);
      return null;
    }

    return resolved;
  } catch (err: any) {
    console.error(`[project-manager] Error resolving workdir for ${projectName}: ${err.message}`);
    return null;
  }
}
