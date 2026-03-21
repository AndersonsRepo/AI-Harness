/**
 * Git Worktree Manager
 *
 * Provides isolated git checkouts for parallel agent groups and handoff chains.
 * Each worktree shares the project's .git directory but has its own working tree,
 * enabling concurrent builders without file conflicts.
 *
 * Design:
 * - One worktree per task group (not per agent)
 * - Only created when writer agents are involved (builder, ops, project)
 * - Falls back to project root on any failure (degraded mode)
 * - Self-healing: orphaned worktrees cleaned on startup and periodically
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { getDb } from "./db.js";
import { AGENT_TOOL_RESTRICTIONS } from "./agent-loader.js";

// ─── Types ──────────────────────────────────────────────────────────

// Matches SQLite column names (snake_case)
export interface WorktreeInfo {
  id: string;
  project_name: string;
  project_path: string;
  worktree_path: string;
  branch_name: string;
  group_id: string | null;
  chain_id: string | null;
  channel_id: string;
  status: "active" | "merging" | "merged" | "failed" | "orphaned";
  created_at: string;
  completed_at: string | null;
  merge_result: string | null;
}

export interface MergeResult {
  status: "success" | "conflict" | "no-changes";
  details: string;
}

// Agents that can write code (no allowed whitelist = full access, or explicitly has Edit/Write)
const WRITER_AGENTS = new Set<string>();

// Build writer set from AGENT_TOOL_RESTRICTIONS at load time
(function initWriterAgents() {
  // Known agents: orchestrator, researcher, reviewer, education, builder, ops, project, commands
  const ALL_AGENTS = [
    "orchestrator", "researcher", "reviewer", "education",
    "builder", "ops", "project", "commands",
  ];

  for (const agent of ALL_AGENTS) {
    const restrictions = AGENT_TOOL_RESTRICTIONS[agent];
    if (!restrictions) {
      // No restrictions = full access = writer
      WRITER_AGENTS.add(agent);
    } else if (restrictions.allowed) {
      // Has whitelist — writer only if Edit or Write is in the list
      if (restrictions.allowed.includes("Edit") || restrictions.allowed.includes("Write")) {
        WRITER_AGENTS.add(agent);
      }
    } else if (restrictions.disallowed) {
      // Has blacklist — writer unless Edit/Write are blocked
      if (!restrictions.disallowed.includes("Edit") && !restrictions.disallowed.includes("Write")) {
        WRITER_AGENTS.add(agent);
      }
    }
  }
})();

// ─── Core Functions ─────────────────────────────────────────────────

/**
 * Check if any agent in the list is a writer that needs worktree isolation.
 */
export function needsWorktree(agents: string[]): boolean {
  return agents.some((a) => WRITER_AGENTS.has(a.toLowerCase()));
}

/**
 * Check if a directory is a git repository.
 */
export function isGitRepo(dirPath: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: dirPath,
      stdio: "pipe",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current branch name of a git repo.
 */
function getCurrentBranch(repoPath: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoPath,
      stdio: "pipe",
      timeout: 5000,
    }).toString().trim();
  } catch {
    return "main";
  }
}

/**
 * Ensure .worktrees/ is in the project's .gitignore.
 */
function ensureGitignore(projectPath: string): void {
  const gitignorePath = join(projectPath, ".gitignore");
  try {
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, "utf-8");
      if (content.includes(".worktrees")) return;
      writeFileSync(gitignorePath, content.trimEnd() + "\n.worktrees/\n");
    } else {
      writeFileSync(gitignorePath, ".worktrees/\n");
    }
  } catch (err: any) {
    console.warn(`[WORKTREE] Failed to update .gitignore: ${err.message}`);
  }
}

/**
 * Create a git worktree for a parallel group or handoff chain.
 * Returns WorktreeInfo on success, null on failure (caller should fall back to project root).
 */
export function createWorktree(
  projectPath: string,
  projectName: string,
  identifier: string,
  channelId: string,
  opts?: { groupId?: string; chainId?: string }
): WorktreeInfo | null {
  if (!isGitRepo(projectPath)) {
    console.warn(`[WORKTREE] Not a git repo: ${projectPath}`);
    return null;
  }

  const worktreesDir = join(projectPath, ".worktrees");
  const worktreePath = join(worktreesDir, identifier);
  const branchName = `wt/${identifier}`;
  const id = `wt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  try {
    // Ensure .worktrees/ directory exists and is gitignored
    mkdirSync(worktreesDir, { recursive: true });
    ensureGitignore(projectPath);

    // Create the worktree with a new branch
    execSync(
      `git worktree add "${worktreePath}" -b "${branchName}"`,
      { cwd: projectPath, stdio: "pipe", timeout: 30000 }
    );

    console.log(`[WORKTREE] Created: ${worktreePath} (branch: ${branchName})`);

    // Record in database
    const db = getDb();
    db.prepare(`
      INSERT INTO worktrees (id, project_name, project_path, worktree_path, branch_name, group_id, chain_id, channel_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(id, projectName, projectPath, worktreePath, branchName, opts?.groupId || null, opts?.chainId || null, channelId);

    return {
      id,
      project_name: projectName,
      project_path: projectPath,
      worktree_path: worktreePath,
      branch_name: branchName,
      group_id: opts?.groupId || null,
      chain_id: opts?.chainId || null,
      channel_id: channelId,
      status: "active",
      created_at: new Date().toISOString(),
      completed_at: null,
      merge_result: null,
    };
  } catch (err: any) {
    console.error(`[WORKTREE] Failed to create worktree at ${worktreePath}: ${err.message}`);
    // Attempt cleanup of partial creation
    try {
      execSync(`git worktree remove "${worktreePath}" --force 2>/dev/null; git branch -D "${branchName}" 2>/dev/null`, {
        cwd: projectPath, stdio: "pipe", timeout: 10000,
      });
    } catch { /* best effort */ }
    return null;
  }
}

/**
 * Merge a worktree's branch back into the project's main branch.
 */
export function mergeWorktree(worktreeId: string, targetBranch?: string): MergeResult {
  const db = getDb();
  const row = db.prepare("SELECT * FROM worktrees WHERE id = ?").get(worktreeId) as WorktreeInfo | undefined;
  if (!row) return { status: "no-changes", details: "Worktree not found in database" };

  const projectPath = row.project_path;
  const branchName = row.branch_name;
  const worktreePath = row.worktree_path;
  const target = targetBranch || getCurrentBranch(projectPath);

  try {
    // Update status to merging
    db.prepare("UPDATE worktrees SET status = 'merging' WHERE id = ?").run(worktreeId);

    // Check if the worktree branch has any commits ahead of the target
    const aheadCount = execSync(
      `git rev-list --count "${target}..${branchName}"`,
      { cwd: projectPath, stdio: "pipe", timeout: 10000 }
    ).toString().trim();

    if (aheadCount === "0") {
      db.prepare("UPDATE worktrees SET status = 'merged', merge_result = 'no-changes', completed_at = datetime('now') WHERE id = ?").run(worktreeId);
      return { status: "no-changes", details: "No commits to merge" };
    }

    // Attempt merge
    execSync(
      `git merge --no-ff "${branchName}" -m "Merge worktree ${basename(worktreePath)} into ${target}"`,
      { cwd: projectPath, stdio: "pipe", timeout: 30000 }
    );

    db.prepare("UPDATE worktrees SET status = 'merged', merge_result = 'success', completed_at = datetime('now') WHERE id = ?").run(worktreeId);
    console.log(`[WORKTREE] Merged ${branchName} → ${target} (${aheadCount} commits)`);
    return { status: "success", details: `${aheadCount} commit(s) merged into ${target}` };
  } catch (err: any) {
    // Merge conflict — abort and report
    try {
      execSync("git merge --abort", { cwd: projectPath, stdio: "pipe", timeout: 5000 });
    } catch { /* may not be in merge state */ }

    db.prepare("UPDATE worktrees SET status = 'failed', merge_result = 'conflict', completed_at = datetime('now') WHERE id = ?").run(worktreeId);
    console.error(`[WORKTREE] Merge conflict on ${branchName}: ${err.message}`);
    return { status: "conflict", details: `Merge conflict: ${err.message.slice(0, 200)}` };
  }
}

/**
 * Remove a worktree and clean up its branch.
 */
export function removeWorktree(worktreeId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT * FROM worktrees WHERE id = ?").get(worktreeId) as WorktreeInfo | undefined;
  if (!row) return false;

  const projectPath = row.project_path;
  const worktreePath = row.worktree_path;
  const branchName = row.branch_name;

  try {
    // Remove the worktree
    if (existsSync(worktreePath)) {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: projectPath, stdio: "pipe", timeout: 15000,
      });
    }

    // Prune any stale worktree references
    execSync("git worktree prune", {
      cwd: projectPath, stdio: "pipe", timeout: 10000,
    });

    // Delete the branch (only if merged or we're force-cleaning)
    try {
      execSync(`git branch -D "${branchName}"`, {
        cwd: projectPath, stdio: "pipe", timeout: 5000,
      });
    } catch { /* branch may already be gone */ }

    // Remove from database
    db.prepare("DELETE FROM worktrees WHERE id = ?").run(worktreeId);
    console.log(`[WORKTREE] Removed: ${worktreePath}`);
    return true;
  } catch (err: any) {
    console.error(`[WORKTREE] Failed to remove ${worktreePath}: ${err.message}`);
    db.prepare("UPDATE worktrees SET status = 'orphaned' WHERE id = ?").run(worktreeId);
    return false;
  }
}

// ─── Lookup Functions ───────────────────────────────────────────────

export function getWorktreeForGroup(groupId: string): WorktreeInfo | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM worktrees WHERE group_id = ? AND status = 'active'").get(groupId) as WorktreeInfo) || null;
}

export function getWorktreeForChain(chainId: string): WorktreeInfo | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM worktrees WHERE chain_id = ? AND status = 'active'").get(chainId) as WorktreeInfo) || null;
}

export function getActiveWorktrees(): WorktreeInfo[] {
  const db = getDb();
  return db.prepare("SELECT * FROM worktrees WHERE status = 'active'").all() as WorktreeInfo[];
}

export function getWorktreeById(id: string): WorktreeInfo | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM worktrees WHERE id = ?").get(id) as WorktreeInfo) || null;
}

// ─── Cleanup ────────────────────────────────────────────────────────

const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Clean up orphaned worktrees:
 * - Active worktrees older than 24h
 * - Worktrees whose directory no longer exists on disk
 * - Worktrees in failed/orphaned status
 */
export function cleanupOrphanedWorktrees(): number {
  const db = getDb();
  let cleaned = 0;

  const all = db.prepare(
    "SELECT * FROM worktrees WHERE status IN ('active', 'failed', 'orphaned')"
  ).all() as WorktreeInfo[];

  for (const wt of all) {
    const age = Date.now() - new Date(wt.created_at).getTime();
    const dirExists = existsSync(wt.worktree_path);
    const isStale = age > ORPHAN_TTL_MS;
    const isBroken = !dirExists;
    const isTerminal = wt.status === "failed" || wt.status === "orphaned";

    if (isStale || isBroken || isTerminal) {
      console.log(`[WORKTREE] Cleaning orphan: ${wt.worktree_path} (status=${wt.status}, age=${Math.round(age / 3600000)}h, exists=${dirExists})`);
      if (removeWorktree(wt.id)) {
        cleaned++;
      } else {
        // Force-delete from DB if removal failed
        db.prepare("DELETE FROM worktrees WHERE id = ?").run(wt.id);
        cleaned++;
      }
    }
  }

  // Also prune git worktree references across all known project paths
  const projectPaths = new Set(all.map((w) => w.project_path));
  for (const pp of projectPaths) {
    try {
      execSync("git worktree prune", { cwd: pp, stdio: "pipe", timeout: 10000 });
    } catch { /* best effort */ }
  }

  if (cleaned > 0) {
    console.log(`[WORKTREE] Cleaned ${cleaned} orphaned worktree(s)`);
  }
  return cleaned;
}
