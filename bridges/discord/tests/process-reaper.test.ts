import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRunner,
  killProcessGroup,
  reapOrphanedRunners,
  setReaperKillForTests,
  setReaperPsForTests,
} from "../process-reaper.js";

describe("process-reaper: classifyRunner", () => {
  it("matches a harness codex agent (codex exec + harness MCP env)", () => {
    const cmd =
      "/path/codex exec resume 019dea50-2bcc --json --skip-git-repo-check " +
      '-c approval_policy="never" -c mcp_servers.harness.env.HARNESS_CHANNEL_ID="1499"';
    assert.equal(classifyRunner(cmd), "codex");
  });

  it("matches a harness headless claude (-p + skip-permissions)", () => {
    const cmd =
      "/Users/x/.local/bin/claude --verbose -p --output-format stream-json " +
      "--dangerously-skip-permissions --append-system-prompt ...";
    assert.equal(classifyRunner(cmd), "claude");
  });

  it("matches the python runner wrappers", () => {
    assert.equal(classifyRunner("python3 /x/bridges/discord/claude-runner.py /x/out.json --stream-dir /x/s"), "claude");
    assert.equal(classifyRunner("python3 /x/bridges/discord/codex-runner.py /x/out.json --prompt-file /x/p.txt"), "codex");
  });

  it("does NOT match interactive Claude Code (no -p)", () => {
    assert.equal(classifyRunner("/Users/x/.local/bin/claude"), null);
  });

  it("does NOT match the --bg-spare pool", () => {
    assert.equal(classifyRunner("/Users/x/.local/share/claude/versions/2.1.143 --bg-spare /tmp/cc-abc"), null);
  });

  it("does NOT match unrelated processes (Cursor, plain codex)", () => {
    assert.equal(classifyRunner("Cursor Helper (Plugin): extension-host (user) prompt-to-app"), null);
    assert.equal(classifyRunner("codex exec --json -C /somewhere"), null); // no harness MCP env
  });
});

describe("process-reaper: reapOrphanedRunners", () => {
  const kills: { pid: number; signal: string }[] = [];

  afterEach(() => {
    setReaperPsForTests(null);
    setReaperKillForTests(null);
    kills.length = 0;
  });

  // pid | etimes(secs) | command
  const PS = [
    `  100 2000 /x/codex exec resume aaa -c mcp_servers.harness.env.HARNESS_CHANNEL_ID="1"`,
    `  101 2000 /x/.local/bin/claude --verbose -p --output-format stream-json --dangerously-skip-permissions --append-system-prompt z`,
    `  102 60 /x/.local/bin/claude --verbose -p --output-format stream-json --dangerously-skip-permissions --append-system-prompt z`,
    `  103 99999 /x/.local/bin/claude`,
    `  104 99999 /x/.local/share/claude/versions/2.1.143 --bg-spare /tmp/cc-x`,
    `  105 88888 Cursor Helper (Plugin): extension-host`,
    `  106 2000 python3 /x/bridges/discord/claude-runner.py /x/out.json --stream-dir /x/s`,
  ].join("\n");

  function install(): void {
    setReaperPsForTests(() => PS);
    setReaperKillForTests((pid, signal) => kills.push({ pid, signal }));
  }

  it("reaps only harness runners older than maxAgeSecs", () => {
    install();
    const report = reapOrphanedRunners({ maxAgeSecs: 1800 });

    // scanned = the 4 harness runners (100,101,102,106); 103/104/105 aren't runners.
    assert.equal(report.scannedRunners, 4);
    assert.equal(report.skippedYoung, 1); // pid 102 (60s)
    const reapedPids = report.reaped.map((r) => r.pid).sort();
    assert.deepEqual(reapedPids, [100, 101, 106]);

    // each reaped via process-GROUP kill (negated pid), SIGTERM
    const killedPids = kills.map((k) => k.pid).sort((a, b) => a - b);
    assert.deepEqual(killedPids, [-106, -101, -100].sort((a, b) => a - b));
    assert.ok(kills.every((k) => k.signal === "SIGTERM"));
  });

  it("dry-run reports the same targets but kills nothing", () => {
    install();
    const report = reapOrphanedRunners({ maxAgeSecs: 1800, dryRun: true });
    assert.deepEqual(report.reaped.map((r) => r.pid).sort(), [100, 101, 106]);
    assert.equal(kills.length, 0);
    assert.equal(report.dryRun, true);
  });

  it("reaps nothing when every runner is younger than the floor", () => {
    install();
    const report = reapOrphanedRunners({ maxAgeSecs: 100000 });
    assert.equal(report.reaped.length, 0);
    assert.equal(kills.length, 0);
  });
});

describe("process-reaper: killProcessGroup", () => {
  afterEach(() => setReaperKillForTests(null));

  it("kills the group (negated pid) first", () => {
    const calls: number[] = [];
    setReaperKillForTests((pid) => calls.push(pid));
    killProcessGroup(1234, "SIGTERM");
    assert.deepEqual(calls, [-1234]);
  });

  it("falls back to the bare pid if the group kill throws", () => {
    const calls: number[] = [];
    setReaperKillForTests((pid) => {
      if (pid < 0) throw new Error("ESRCH on group");
      calls.push(pid);
    });
    killProcessGroup(1234, "SIGTERM");
    assert.deepEqual(calls, [1234]);
  });

  it("is a no-op for invalid pids", () => {
    const calls: number[] = [];
    setReaperKillForTests((pid) => calls.push(pid));
    killProcessGroup(0);
    killProcessGroup(-1);
    assert.equal(calls.length, 0);
  });
});
