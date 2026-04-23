import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { captureArtifacts } from "../worktree-manager.js";
import { buildPostChainGateRequests, type ChainEntry } from "../handoff-router.js";

function git(repo: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd: repo,
    stdio: "pipe",
  }).toString();
}

describe("captureArtifacts", () => {
  let repo: string;

  before(() => {
    repo = mkdtempSync(join(tmpdir(), "harness-artifact-test-"));
    git(repo, "init -q -b main");
    git(repo, "config user.email test@example.com");
    git(repo, "config user.name Test");
    writeFileSync(join(repo, "baseline.txt"), "hello\n");
    git(repo, "add baseline.txt");
    git(repo, 'commit -q -m "baseline"');
  });

  after(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("returns undefined for a non-path", () => {
    assert.equal(captureArtifacts(null), undefined);
    assert.equal(captureArtifacts(undefined), undefined);
    assert.equal(captureArtifacts("/definitely/not/a/real/path/xxxxx"), undefined);
  });

  it("returns undefined when the repo has no changes", () => {
    assert.equal(captureArtifacts(repo), undefined);
  });

  it("captures a modified tracked file in the diff", () => {
    writeFileSync(join(repo, "baseline.txt"), "hello\nworld\n");
    const artifacts = captureArtifacts(repo);
    assert.ok(artifacts, "expected artifacts to be populated");
    assert.deepEqual(artifacts.changedFiles, ["baseline.txt"]);
    assert.match(artifacts.diff || "", /\+world/);
    assert.match(artifacts.diff || "", /baseline\.txt/);
    // Cleanup for next test
    git(repo, "checkout -- baseline.txt");
  });

  it("captures an untracked file in changedFiles but not the diff", () => {
    writeFileSync(join(repo, "new-file.ts"), "export const x = 1;\n");
    const artifacts = captureArtifacts(repo);
    assert.ok(artifacts);
    assert.ok(artifacts.changedFiles?.includes("new-file.ts"));
    // `git diff HEAD` doesn't include untracked files
    assert.equal(artifacts.diff, undefined);
    // Cleanup
    rmSync(join(repo, "new-file.ts"));
  });
});

describe("buildPostChainGateRequests carries artifacts into gate prompt", () => {
  it("reviewer prompt contains diff when builder entry has artifacts", () => {
    const entries: ChainEntry[] = [
      {
        agent: "builder",
        response: "Made the change.",
        timestamp: Date.now(),
        artifacts: {
          diff: "diff --git a/foo.ts b/foo.ts\n+export const bar = 1;\n",
          changedFiles: ["foo.ts"],
          worktreePath: "/tmp/fake",
        },
      },
    ];
    const requests = buildPostChainGateRequests(entries, ["builder", "reviewer", "tester"]);
    const reviewer = requests.find((r) => r.gateAgent === "reviewer");
    assert.ok(reviewer, "expected a reviewer gate request");
    assert.match(reviewer.prompt, /Changed Files/);
    assert.match(reviewer.prompt, /foo\.ts/);
    assert.match(reviewer.prompt, /```diff/);
    assert.match(reviewer.prompt, /\+export const bar/);
    assert.equal(reviewer.artifact.diff, "diff --git a/foo.ts b/foo.ts\n+export const bar = 1;\n");
    assert.deepEqual(reviewer.artifact.changedFiles, ["foo.ts"]);
  });

  it("tester prompt contains diff when builder entry has artifacts", () => {
    const entries: ChainEntry[] = [
      {
        agent: "builder",
        response: "Made the change.",
        timestamp: Date.now(),
        artifacts: {
          diff: "diff --git a/x b/x\n+change\n",
          changedFiles: ["x"],
        },
      },
    ];
    const requests = buildPostChainGateRequests(entries, ["builder", "reviewer", "tester"]);
    const tester = requests.find((r) => r.gateAgent === "tester");
    assert.ok(tester, "expected a tester gate request");
    assert.match(tester.prompt, /```diff/);
    assert.match(tester.prompt, /\+change/);
  });

  it("falls back to prose-only prompt when no artifacts captured", () => {
    const entries: ChainEntry[] = [
      {
        agent: "builder",
        response: "Made the change (no worktree so no diff).",
        timestamp: Date.now(),
      },
    ];
    const requests = buildPostChainGateRequests(entries, ["builder", "reviewer"]);
    const reviewer = requests.find((r) => r.gateAgent === "reviewer");
    assert.ok(reviewer);
    assert.doesNotMatch(reviewer.prompt, /Changed Files/);
    assert.doesNotMatch(reviewer.prompt, /```diff/);
    assert.match(reviewer.prompt, /Made the change/);
    assert.equal(reviewer.artifact.diff, undefined);
    assert.equal(reviewer.artifact.changedFiles, undefined);
    assert.equal(reviewer.artifact.summary, "Made the change (no worktree so no diff).");
  });

  it("marks truncated diffs in the prompt", () => {
    const entries: ChainEntry[] = [
      {
        agent: "builder",
        response: "Big diff.",
        timestamp: Date.now(),
        artifacts: {
          diff: "a".repeat(100),
          changedFiles: ["big.ts"],
          truncated: true,
        },
      },
    ];
    const requests = buildPostChainGateRequests(entries, ["builder", "reviewer"]);
    const reviewer = requests.find((r) => r.gateAgent === "reviewer");
    assert.ok(reviewer);
    assert.match(reviewer.prompt, /truncated to 50KB/);
    assert.equal(reviewer.artifact.truncated, true);
  });
});
