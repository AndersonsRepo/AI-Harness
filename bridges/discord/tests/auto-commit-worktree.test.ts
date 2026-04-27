import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { commitWorktreeIfDirty } from "../worktree-manager.js";
import { getDb } from "../db.js";

function git(repo: string, args: string): string {
  return execSync(`git ${args}`, { cwd: repo, stdio: "pipe" }).toString();
}

function insertWorktreeRow(args: {
  id: string;
  worktreePath: string;
  projectPath: string;
  branchName: string;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO worktrees (id, project_name, project_path, worktree_path, branch_name, channel_id, status)
     VALUES (?, 'test', ?, ?, ?, 'test-channel', 'active')`,
  ).run(args.id, args.projectPath, args.worktreePath, args.branchName);
}

function cleanupWorktreeRow(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM worktrees WHERE id = ?").run(id);
}

describe("commitWorktreeIfDirty", () => {
  let repo: string;
  let worktree: string;
  let worktreeId: string;
  let branchName: string;

  before(() => {
    // Create a parent repo with one baseline commit, then add a worktree.
    // This mirrors how the chain creates worktrees in production.
    repo = mkdtempSync(join(tmpdir(), "auto-commit-test-parent-"));
    git(repo, "init -q -b main");
    git(repo, "config user.email parent@test.local");
    git(repo, "config user.name Parent");
    writeFileSync(join(repo, "baseline.txt"), "hello\n");
    git(repo, "add baseline.txt");
    git(repo, 'commit -q -m "baseline"');

    worktree = mkdtempSync(join(tmpdir(), "auto-commit-test-wt-"));
    rmSync(worktree, { recursive: true, force: true }); // git worktree add wants a non-existent path
    branchName = `wt/test-${Date.now().toString(36)}`;
    git(repo, `worktree add -b ${branchName} "${worktree}"`);
    git(worktree, "config user.email worktree@test.local");
    git(worktree, "config user.name Worktree");

    worktreeId = `test-wt-${Date.now().toString(36)}`;
    insertWorktreeRow({
      id: worktreeId,
      worktreePath: worktree,
      projectPath: repo,
      branchName,
    });
  });

  after(() => {
    cleanupWorktreeRow(worktreeId);
    if (existsSync(worktree)) {
      try {
        execSync(`git -C "${repo}" worktree remove --force "${worktree}"`, { stdio: "pipe" });
      } catch { /* fallback to direct rm */ }
    }
    if (worktree && existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("returns committed: false on a clean tree (no error)", () => {
    const result = commitWorktreeIfDirty(worktreeId);
    assert.equal(result.committed, false);
    assert.equal(result.error, undefined);
  });

  it("commits new files with a generated message and returns the SHA", () => {
    writeFileSync(join(worktree, "new-file.txt"), "auto-committed by chain\n");

    const result = commitWorktreeIfDirty(worktreeId, {
      message: "chain: builder changes from chain-test-001",
    });

    assert.equal(result.committed, true, result.error);
    assert.equal(result.message, "chain: builder changes from chain-test-001");
    assert.ok(result.sha && /^[0-9a-f]{40}$/.test(result.sha), "expected 40-char SHA");

    // Verify the file is actually in the new commit
    const log = git(worktree, "log -1 --format=%s");
    assert.match(log, /chain: builder changes from chain-test-001/);
    const files = git(worktree, "show --name-only --format= HEAD").trim();
    assert.ok(files.includes("new-file.txt"));
  });

  it("commits modifications to existing tracked files", () => {
    writeFileSync(join(worktree, "baseline.txt"), "hello\nworld\n");

    const result = commitWorktreeIfDirty(worktreeId);
    assert.equal(result.committed, true, result.error);

    const diff = git(worktree, "show HEAD --format= -- baseline.txt");
    assert.match(diff, /\+world/);
  });

  it("returns committed: false again after committing (clean tree)", () => {
    // After the prior test, the tree is clean again
    const result = commitWorktreeIfDirty(worktreeId);
    assert.equal(result.committed, false);
    assert.equal(result.error, undefined);
  });

  it("returns committed: false with an error when worktree id doesn't exist", () => {
    const result = commitWorktreeIfDirty("nonexistent-id-xyz");
    assert.equal(result.committed, false);
    assert.match(result.error || "", /not found/i);
  });

  it("uses chain author identity (not the user's git config) when committing", () => {
    writeFileSync(join(worktree, "another-file.txt"), "by chain\n");
    const result = commitWorktreeIfDirty(worktreeId, {
      message: "chain: identity check",
    });
    assert.equal(result.committed, true, result.error);

    const author = git(worktree, "log -1 --format=%an").trim();
    const email = git(worktree, "log -1 --format=%ae").trim();
    assert.equal(author, "AI Harness Chain");
    assert.equal(email, "chain@ai-harness.local");
  });
});
