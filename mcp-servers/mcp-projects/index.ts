#!/usr/bin/env node
/**
 * MCP Projects Server
 *
 * Centralized project registry, scanning, context injection, and security
 * checks. Reads/writes heartbeat-tasks/projects.json and generates
 * vault/shared/project-knowledge/<name>.md files.
 *
 * IMPORTANT: Never use console.log in stdio MCP servers — it corrupts the
 * JSON-RPC stream. Use console.error for debug logging.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  statSync,
  renameSync,
} from "fs";
import { join } from "path";
import { execSync, execFileSync } from "child_process";

// ─── Configuration ───────────────────────────────────────────────────

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const PROJECTS_FILE = join(HARNESS_ROOT, "heartbeat-tasks", "projects.json");
const KNOWLEDGE_DIR = join(HARNESS_ROOT, "vault", "shared", "project-knowledge");
const SCRIPTS_DIR = join(HARNESS_ROOT, "heartbeat-tasks", "scripts");

// ─── Helpers ─────────────────────────────────────────────────────────

function resolvePath(p: string): string {
  return p
    .replace(/\$HOME/g, process.env.HOME || "")
    .replace(/~\//g, (process.env.HOME || "") + "/")
    .replace(/\$HARNESS_ROOT/g, HARNESS_ROOT);
}

interface ProjectsData {
  projects: Record<string, ProjectEntry>;
}

interface ProjectEntry {
  path: string;
  description: string;
  repo?: string;
  discord_channel?: string;
  vercel_project?: boolean;
}

function loadProjects(): ProjectsData {
  if (!existsSync(PROJECTS_FILE)) {
    return { projects: {} };
  }
  try {
    return JSON.parse(readFileSync(PROJECTS_FILE, "utf-8"));
  } catch {
    return { projects: {} };
  }
}

function saveProjects(data: ProjectsData): void {
  const tmp = PROJECTS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, PROJECTS_FILE);
}

function parseFrontmatter(content: string): Record<string, any> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const result: Record<string, any> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: any = line.slice(colonIdx + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((s: string) => s.trim().replace(/^["']|["']$/g, ""));
    } else if (/^\d+$/.test(value)) {
      value = parseInt(value, 10);
    }
    result[key] = value;
  }
  return result;
}

function safeExec(cmd: string, opts?: { timeout?: number; cwd?: string }): string {
  try {
    return execSync(cmd, {
      timeout: opts?.timeout || 10000,
      encoding: "utf-8",
      cwd: opts?.cwd,
    }).trim();
  } catch {
    return "";
  }
}

function readFileIfExists(filePath: string, maxChars?: number): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    return maxChars ? content.slice(0, maxChars) : content;
  } catch {
    return null;
  }
}

// ─── Server Setup ────────────────────────────────────────────────────

const server = new McpServer({
  name: "mcp-projects",
  version: "1.0.0",
});

// ─── Tool: project_list ──────────────────────────────────────────────

server.tool(
  "project_list",
  "List all registered projects with metadata. Optionally check for existing knowledge files.",
  {
    include_knowledge: z.boolean().optional().default(false)
      .describe("Check if each project has a knowledge file in vault"),
  },
  async ({ include_knowledge }) => {
    const data = loadProjects();
    const names = Object.keys(data.projects);

    if (names.length === 0) {
      return { content: [{ type: "text" as const, text: "No projects registered. Use project_register to add one." }] };
    }

    const lines = [`# Registered Projects (${names.length})`, ""];
    for (const name of names) {
      const proj = data.projects[name];
      const resolvedPath = resolvePath(proj.path);
      const pathExists = existsSync(resolvedPath);

      lines.push(`## ${name}`);
      lines.push(`Description: ${proj.description}`);
      lines.push(`Path: ${proj.path}${pathExists ? "" : " [NOT FOUND]"}`);
      if (proj.repo) lines.push(`Repo: ${proj.repo}`);
      if (proj.discord_channel) lines.push(`Discord: #${proj.discord_channel}`);
      if (proj.vercel_project) lines.push(`Vercel: yes`);

      if (include_knowledge) {
        const knowledgeFile = join(KNOWLEDGE_DIR, `${name}.md`);
        if (existsSync(knowledgeFile)) {
          const stat = statSync(knowledgeFile);
          const age = Math.round((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24));
          lines.push(`Knowledge: exists (${age}d old)`);
        } else {
          lines.push(`Knowledge: not scanned yet`);
        }
      }
      lines.push("");
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Tool: project_register ──────────────────────────────────────────

server.tool(
  "project_register",
  "Add or update a project in the registry (projects.json).",
  {
    name: z.string().describe("Project name (kebab-case, e.g., 'client-project')"),
    path: z.string().describe("Path to project directory (supports $HOME, $HARNESS_ROOT)"),
    description: z.string().describe("One-line project description"),
    repo: z.string().optional().describe("GitHub repo (owner/name)"),
    discord_channel: z.string().optional().describe("Discord channel name"),
    vercel_project: z.boolean().optional().default(false).describe("Whether this project deploys via Vercel"),
  },
  async ({ name, path, description, repo, discord_channel, vercel_project }) => {
    const data = loadProjects();
    const isUpdate = name in data.projects;

    data.projects[name] = {
      path,
      description,
      ...(repo && { repo }),
      ...(discord_channel && { discord_channel }),
      ...(vercel_project && { vercel_project }),
    };

    saveProjects(data);
    return {
      content: [{
        type: "text" as const,
        text: `Project "${name}" ${isUpdate ? "updated" : "registered"}.\nPath: ${path}\nDescription: ${description}`,
      }],
    };
  }
);

// ─── Tool: project_scan ──────────────────────────────────────────────

server.tool(
  "project_scan",
  "Scan a project directory and generate/update its knowledge file in vault/shared/project-knowledge/.",
  {
    name: z.string().describe("Project name (must be registered)"),
    force: z.boolean().optional().default(false).describe("Re-scan even if knowledge file exists"),
  },
  async ({ name, force }) => {
    const data = loadProjects();
    const proj = data.projects[name];
    if (!proj) {
      return { content: [{ type: "text" as const, text: `Project "${name}" not found in registry.` }] };
    }

    const projectPath = resolvePath(proj.path);
    if (!existsSync(projectPath)) {
      return { content: [{ type: "text" as const, text: `Project path not found: ${projectPath}` }] };
    }

    const knowledgeFile = join(KNOWLEDGE_DIR, `${name}.md`);
    if (existsSync(knowledgeFile) && !force) {
      return { content: [{ type: "text" as const, text: `Knowledge file already exists for "${name}". Use force=true to re-scan.` }] };
    }

    mkdirSync(KNOWLEDGE_DIR, { recursive: true });

    // ── Read key files ──
    const packageJson = readFileIfExists(join(projectPath, "package.json"));
    const pyprojectToml = readFileIfExists(join(projectPath, "pyproject.toml"));
    const cargoToml = readFileIfExists(join(projectPath, "Cargo.toml"));
    const goMod = readFileIfExists(join(projectPath, "go.mod"));
    const readme = readFileIfExists(join(projectPath, "README.md"), 500);
    const claudeMd = readFileIfExists(join(projectPath, "CLAUDE.md"));
    const tsconfigJson = readFileIfExists(join(projectPath, "tsconfig.json"));
    const envExample = readFileIfExists(join(projectPath, ".env.example"));

    // ── Detect stack ──
    const stacks: string[] = [];
    const stackDetection: [string, string][] = [
      ["next.config.*", "Next.js"],
      ["vite.config.*", "Vite"],
      ["angular.json", "Angular"],
      ["manage.py", "Django"],
      ["Cargo.toml", "Rust"],
      ["go.mod", "Go"],
      ["docker-compose.yml", "Docker"],
      ["vercel.json", "Vercel"],
    ];

    for (const [pattern, stack] of stackDetection) {
      if (pattern.includes("*")) {
        const prefix = pattern.replace("*", "");
        try {
          const files = readdirSync(projectPath);
          if (files.some(f => f.startsWith(prefix))) stacks.push(stack);
        } catch {}
      } else {
        if (existsSync(join(projectPath, pattern))) stacks.push(stack);
      }
    }

    if (existsSync(join(projectPath, "supabase"))) stacks.push("Supabase");

    // ── Detect language ──
    let language = "unknown";
    if (packageJson) language = "TypeScript/JavaScript";
    if (tsconfigJson) language = "TypeScript";
    if (pyprojectToml) language = "Python";
    if (cargoToml) language = "Rust";
    if (goMod) language = "Go";

    // ── Parse package.json for deps ──
    let deps = "";
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const allDeps = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
        };
        const depNames = Object.keys(allDeps || {});
        if (depNames.length > 0) {
          deps = depNames.slice(0, 30).join(", ");
          if (depNames.length > 30) deps += ` (+${depNames.length - 30} more)`;
        }
      } catch {}
    }

    // ── Directory structure ──
    let dirStructure = "";
    try {
      const entries = readdirSync(projectPath).filter(e => !e.startsWith(".") && e !== "node_modules" && e !== "dist" && e !== "__pycache__");
      dirStructure = entries.slice(0, 25).join(", ");
      if (entries.length > 25) dirStructure += ` (+${entries.length - 25} more)`;
    } catch {}

    // ── Git info ──
    const gitRemote = safeExec("git remote -v", { cwd: projectPath });
    const gitLog = safeExec("git log --oneline -5", { cwd: projectPath });

    // ── Build knowledge file ──
    const today = new Date().toISOString().slice(0, 10);
    const sections: string[] = [];

    sections.push([
      "---",
      `title: ${name} Project Knowledge`,
      `updated: ${today}`,
      `scope: shared`,
      `project: ${name}`,
      `stack: ${stacks.length > 0 ? stacks.join(", ") : "unknown"}`,
      `language: ${language}`,
      "---",
    ].join("\n"));

    sections.push(`# ${name}\n\n${proj.description}`);

    if (stacks.length > 0) {
      sections.push(`## Stack\n${stacks.join(", ")}`);
    }

    if (dirStructure) {
      sections.push(`## Directory Structure\n\`\`\`\n${dirStructure}\n\`\`\``);
    }

    if (deps) {
      sections.push(`## Dependencies\n${deps}`);
    }

    if (readme) {
      sections.push(`## README (excerpt)\n${readme}`);
    }

    if (claudeMd) {
      sections.push(`## CLAUDE.md\n${claudeMd.slice(0, 1000)}`);
    }

    if (envExample) {
      sections.push(`## Environment Variables\n\`\`\`\n${envExample.slice(0, 500)}\n\`\`\``);
    }

    if (gitRemote) {
      sections.push(`## Git Remote\n\`\`\`\n${gitRemote}\n\`\`\``);
    }

    if (gitLog) {
      sections.push(`## Recent Commits\n\`\`\`\n${gitLog}\n\`\`\``);
    }

    if (proj.repo) sections.push(`## GitHub\nRepo: ${proj.repo}`);
    if (proj.discord_channel) sections.push(`## Discord\nChannel: #${proj.discord_channel}`);
    if (proj.vercel_project) sections.push(`## Deployment\nVercel: enabled`);

    // Seed conventions section — session-debrief and promotion-check will append to this
    sections.push(`## Conventions\n\n*No conventions yet. These are populated automatically as project-specific patterns are discovered across sessions.*`);

    const content = sections.join("\n\n") + "\n";
    writeFileSync(knowledgeFile, content);

    return {
      content: [{
        type: "text" as const,
        text: `Scanned "${name}" → ${knowledgeFile}\nStack: ${stacks.join(", ") || "unknown"}\nLanguage: ${language}\nDeps: ${deps ? deps.split(",").length + " packages" : "none detected"}`,
      }],
    };
  }
);

// ─── Tool: project_context ───────────────────────────────────────────

server.tool(
  "project_context",
  "Return combined registry metadata + knowledge file content for a project. Use this for context injection.",
  {
    name: z.string().describe("Project name"),
  },
  async ({ name }) => {
    const data = loadProjects();
    const proj = data.projects[name];
    if (!proj) {
      return { content: [{ type: "text" as const, text: `Project "${name}" not found in registry.` }] };
    }

    const lines: string[] = [];

    // Registry metadata
    lines.push(`# Project: ${name}`);
    lines.push(`Description: ${proj.description}`);
    lines.push(`Path: ${proj.path}`);
    if (proj.repo) lines.push(`Repo: ${proj.repo}`);
    if (proj.discord_channel) lines.push(`Discord: #${proj.discord_channel}`);
    if (proj.vercel_project) lines.push(`Vercel: yes`);

    // Knowledge file content
    const knowledgeFile = join(KNOWLEDGE_DIR, `${name}.md`);
    if (existsSync(knowledgeFile)) {
      const content = readFileSync(knowledgeFile, "utf-8");
      // Strip frontmatter for context injection
      const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
      lines.push("", "---", "", body);
    } else {
      lines.push("", "*No knowledge file yet. Run project_scan to generate one.*");
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Tool: project_remove ────────────────────────────────────────────

server.tool(
  "project_remove",
  "Remove a project from the registry. Knowledge file is kept for reference.",
  {
    name: z.string().describe("Project name to remove"),
  },
  async ({ name }) => {
    const data = loadProjects();
    if (!(name in data.projects)) {
      return { content: [{ type: "text" as const, text: `Project "${name}" not found in registry.` }] };
    }

    delete data.projects[name];
    saveProjects(data);

    const knowledgeFile = join(KNOWLEDGE_DIR, `${name}.md`);
    const knowledgeExists = existsSync(knowledgeFile);

    return {
      content: [{
        type: "text" as const,
        text: `Project "${name}" removed from registry.${knowledgeExists ? `\nKnowledge file preserved at: ${knowledgeFile}` : ""}`,
      }],
    };
  }
);

// ─── Tool: project_scan_security ─────────────────────────────────────

server.tool(
  "project_scan_security",
  "Run the repo security scanner on a project and return findings. Checks for secrets, debug artifacts, committed .env files, large files, and more.",
  {
    name: z.string().describe("Project name (must be registered)"),
    checks: z.array(z.string()).optional()
      .describe("Specific checks to run: secrets, debug, env, large_files, npm_audit, todos, dependabot. Defaults to all."),
  },
  async ({ name, checks }) => {
    const data = loadProjects();
    const proj = data.projects[name];
    if (!proj) {
      return { content: [{ type: "text" as const, text: `Project "${name}" not found in registry.` }] };
    }

    const scannerScript = join(SCRIPTS_DIR, "repo-scanner.py");
    if (!existsSync(scannerScript)) {
      return { content: [{ type: "text" as const, text: "repo-scanner.py not found in heartbeat-tasks/scripts/" }] };
    }

    const args = [scannerScript, "--project", name, "--json"];
    if (checks && checks.length > 0) {
      args.push("--checks", checks.join(","));
    }

    let output: string;
    try {
      output = execFileSync("python3", args, {
        timeout: 60000,
        encoding: "utf-8",
        env: { ...process.env, HARNESS_ROOT },
      }).trim();
    } catch {
      output = "";
    }
    if (!output) {
      return { content: [{ type: "text" as const, text: `Security scan failed or timed out for "${name}".` }] };
    }

    // Parse JSON output and format
    try {
      const result = JSON.parse(output);
      const findings = result.findings || [];
      const summary = result.summary || {};

      const lines = [`# Security Scan: ${name}`, ""];

      if (findings.length === 0) {
        lines.push("No findings. Project looks clean.");
      } else {
        lines.push(`**${findings.length} finding(s)**`);
        lines.push(`Critical: ${summary.critical || 0} | High: ${summary.high || 0} | Medium: ${summary.medium || 0} | Info: ${summary.info || 0}`);
        lines.push("");

        for (const f of findings) {
          const icon = f.severity === "critical" ? "🔴" : f.severity === "high" ? "🟠" : f.severity === "medium" ? "🟡" : "ℹ️";
          lines.push(`${icon} **[${f.severity.toUpperCase()}]** ${f.check}: ${f.message}`);
          if (f.file) lines.push(`  File: ${f.file}${f.line ? `:${f.line}` : ""}`);
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch {
      // If JSON parsing fails, return raw output
      return { content: [{ type: "text" as const, text: `# Security Scan: ${name}\n\n\`\`\`\n${output}\n\`\`\`` }] };
    }
  }
);

// ─── Start Server ────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-projects] Server started");
}

main().catch((err) => {
  console.error("[mcp-projects] Fatal:", err);
  process.exit(1);
});
