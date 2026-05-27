/**
 * Skill Catalog
 *
 * Shadow-mode catalog helpers for comparing Claude project-skill discovery,
 * harness_skills output, and vault skill-index metadata. These helpers do not
 * render prompts or change runtime execution.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SkillCatalogEntry {
  name: string;
  description: string;
  userInvocable: boolean;
  canonicalPath: string;
  context?: string;
  agent?: string;
  model?: string;
  argumentHint?: string;
  source: "project";
}

export interface VaultSkillIndexMetadata {
  canonicalPath: string;
  exists: true;
}

export interface SkillCatalogShadow {
  skills: SkillCatalogEntry[];
  vaultIndex: VaultSkillIndexMetadata | null;
  changedExecution: false;
}

export interface SkillCatalogShadowSummary {
  projectSkillCount: number;
  userInvocableCount: number;
  autoTriggeredCount: number;
  vaultIndexPath: string | null;
  changedExecution: false;
}

export interface BuildSkillCatalogShadowOptions {
  harnessRoot: string;
}

function parseFrontmatter(content: string): Record<string, string | boolean> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fields: Record<string, string | boolean> = {};
  for (const line of match[1].split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const raw = line.slice(colonIndex + 1).trim();
    if (!key) continue;
    if (raw === "true") {
      fields[key] = true;
    } else if (raw === "false") {
      fields[key] = false;
    } else {
      fields[key] = raw.replace(/^["']|["']$/g, "");
    }
  }
  return fields;
}

function stringField(
  frontmatter: Record<string, string | boolean>,
  key: string,
): string | undefined {
  const value = frontmatter[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function boolField(
  frontmatter: Record<string, string | boolean>,
  key: string,
): boolean {
  const value = frontmatter[key];
  return value === true || value === "true";
}

function findVaultSkillIndex(harnessRoot: string): VaultSkillIndexMetadata | null {
  const candidates = [
    join(harnessRoot, "vault", "topics", "skills.md"),
    join(harnessRoot, "vault", "shared", "project-knowledge", "skills.md"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ? { canonicalPath: found, exists: true } : null;
}

export function buildSkillCatalogShadow(
  options: BuildSkillCatalogShadowOptions,
): SkillCatalogShadow {
  const skillsDir = join(options.harnessRoot, ".claude", "skills");
  if (!existsSync(skillsDir)) {
    return {
      skills: [],
      vaultIndex: findVaultSkillIndex(options.harnessRoot),
      changedExecution: false,
    };
  }

  const skills: SkillCatalogEntry[] = [];
  for (const dir of readdirSync(skillsDir)) {
    const canonicalPath = join(skillsDir, dir, "SKILL.md");
    if (!existsSync(canonicalPath)) continue;

    const content = readFileSync(canonicalPath, "utf-8");
    const frontmatter = parseFrontmatter(content);
    if (!frontmatter) continue;

    const entry: SkillCatalogEntry = {
      name: stringField(frontmatter, "name") ?? dir,
      description: stringField(frontmatter, "description") ?? "(no description)",
      userInvocable: boolField(frontmatter, "user-invocable"),
      canonicalPath,
      source: "project",
    };
    const context = stringField(frontmatter, "context");
    const agent = stringField(frontmatter, "agent");
    const model = stringField(frontmatter, "model");
    const argumentHint = stringField(frontmatter, "argument-hint");
    if (context) entry.context = context;
    if (agent) entry.agent = agent;
    if (model) entry.model = model;
    if (argumentHint) entry.argumentHint = argumentHint;
    skills.push(entry);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  return {
    skills,
    vaultIndex: findVaultSkillIndex(options.harnessRoot),
    changedExecution: false,
  };
}

function formatSkillLine(skill: SkillCatalogEntry, includeSlash: boolean): string {
  const meta: string[] = [];
  if (skill.context) meta.push(`context: ${skill.context}`);
  if (skill.agent) meta.push(`agent: ${skill.agent}`);
  if (skill.model && skill.model !== "default") meta.push(`model: ${skill.model}`);
  const metaText = meta.length > 0 ? ` (${meta.join(", ")})` : "";
  const displayName = includeSlash ? `/${skill.name}` : skill.name;
  const argumentHint = skill.argumentHint ? ` \`${skill.argumentHint}\`` : "";
  return `- **${displayName}**${argumentHint} — ${skill.description}${metaText}`;
}

export function formatHarnessSkillsCatalog(catalog: SkillCatalogShadow): string {
  const invocable = catalog.skills.filter((skill) => skill.userInvocable);
  const auto = catalog.skills.filter((skill) => !skill.userInvocable);
  const lines = ["# Available Skills", ""];

  lines.push("## User-Invocable", "");
  lines.push(...(invocable.length > 0
    ? invocable.map((skill) => formatSkillLine(skill, true))
    : ["(none)"]));
  lines.push("", "## Auto-Triggered", "");
  lines.push(...(auto.length > 0
    ? auto.map((skill) => formatSkillLine(skill, false))
    : ["(none)"]));

  return lines.join("\n");
}

export function summarizeSkillCatalogShadow(
  catalog: SkillCatalogShadow,
): SkillCatalogShadowSummary {
  const userInvocableCount = catalog.skills.filter((skill) => skill.userInvocable).length;
  return {
    projectSkillCount: catalog.skills.length,
    userInvocableCount,
    autoTriggeredCount: catalog.skills.length - userInvocableCount,
    vaultIndexPath: catalog.vaultIndex?.canonicalPath ?? null,
    changedExecution: false,
  };
}
