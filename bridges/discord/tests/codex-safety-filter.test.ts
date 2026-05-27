import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DESTRUCTIVE_BASH_PATTERNS, safetyPatternsJson, claudeDisallowedToolArgs } from "../safety.js";

const HARNESS_ROOT = process.env.HARNESS_ROOT || process.cwd();
const RUNNER = join(HARNESS_ROOT, "bridges/discord/codex-runner.py");

describe("safety pattern definitions", () => {
  it("exposes a non-empty destructive pattern list", () => {
    assert.ok(DESTRUCTIVE_BASH_PATTERNS.length >= 5);
  });

  it("every pattern has id, regex, description", () => {
    for (const p of DESTRUCTIVE_BASH_PATTERNS) {
      assert.ok(p.id);
      assert.ok(p.regex);
      assert.ok(p.description);
      assert.doesNotThrow(() => new RegExp(p.regex, p.caseInsensitive ? "i" : ""));
    }
  });

  it("regexes actually match the destructive strings they describe", () => {
    const checks: [string, string][] = [
      ["rm-rf", "rm -rf /"],
      ["rm-rf", "rm -fr /tmp/x"],
      ["rm-rf", "rm --recursive /home"],
      ["git-push-force", "git push --force origin main"],
      ["git-push-force", "git push -f"],
      ["git-reset-hard", "git reset --hard HEAD~1"],
      ["kill-9", "kill -9 1234"],
      ["pkill-9", "pkill -9 node"],
      ["drop-table", "DROP TABLE users"],
      ["drop-table", "drop table foo"],
      ["delete-from", "DELETE FROM sessions WHERE id = 1"],
    ];
    for (const [id, command] of checks) {
      const p = DESTRUCTIVE_BASH_PATTERNS.find((x) => x.id === id);
      assert.ok(p, `missing pattern ${id}`);
      const regex = new RegExp(p.regex, p.caseInsensitive ? "i" : "");
      assert.match(command, regex, `pattern ${id} should match ${command}`);
    }
  });

  it("does not match benign similar-looking strings", () => {
    const benign = [
      "rm file.txt", // no -r/-f flags
      "git push origin main", // no --force
      "git reset HEAD~1", // no --hard
      "kill 1234", // no -9
    ];
    for (const line of benign) {
      const hit = DESTRUCTIVE_BASH_PATTERNS.find((p) =>
        new RegExp(p.regex, p.caseInsensitive ? "i" : "").test(line),
      );
      assert.equal(hit, undefined, `expected benign "${line}" to not match, got ${hit?.id}`);
    }
  });

  it("safetyPatternsJson() round-trips", () => {
    const parsed = JSON.parse(safetyPatternsJson());
    assert.equal(parsed.length, DESTRUCTIVE_BASH_PATTERNS.length);
  });

  it("claudeDisallowedToolArgs returns the expected Claude flag syntax", () => {
    const args = claudeDisallowedToolArgs();
    assert.ok(args.includes("Bash(rm -rf:*)"));
    assert.ok(args.includes("Bash(git push --force:*)"));
  });
});

// Integration: spawn codex-runner.py with a fake "codex" binary that emits a
// destructive command event on stdout. Verifies the runner kills the subprocess
// and writes a safetyViolation marker.
describe("codex-runner destructive-command filter", () => {
  let workDir: string;
  let fakeCodex: string;
  let outputFile: string;
  let promptFile: string;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "harness-codex-safety-"));
    fakeCodex = join(workDir, "fake-codex");
    outputFile = join(workDir, "out.json");
    promptFile = join(workDir, "prompt.txt");
    writeFileSync(promptFile, "test prompt");

    // Fake codex: emits a JSONL event claiming to run `rm -rf /tmp/harness-sentinel`,
    // then sleeps. If the runner does NOT kill it, it would "complete" after 5s.
    // The runner should kill it on the first event.
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env python3
import sys, json, time
# Consume the prompt from stdin.
sys.stdin.read()
# Emit a destructive exec event.
sys.stdout.write(json.dumps({"msg": {"type": "exec_command", "command": "rm -rf /tmp/harness-sentinel"}}) + "\\n")
sys.stdout.flush()
# If we weren't killed, the test would see this "benign" event next.
time.sleep(5)
sys.stdout.write(json.dumps({"msg": {"type": "message", "text": "should not be seen"}}) + "\\n")
sys.stdout.flush()
sys.exit(0)
`,
    );
    chmodSync(fakeCodex, 0o755);
  });

  after(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("kills the subprocess on a destructive command event", () => {
    const result = spawnSync(
      "python3",
      [RUNNER, outputFile, "--timeout", "20", "--prompt-file", promptFile],
      {
        env: {
          ...process.env,
          CODEX_CLI_PATH: fakeCodex,
          CODEX_SAFETY_PATTERNS: safetyPatternsJson(),
          HARNESS_ROOT,
        },
        timeout: 15000,
      },
    );

    assert.equal(result.status, 0, `runner exited ${result.status}: ${result.stderr?.toString()}`);
    const output = JSON.parse(readFileSync(outputFile, "utf-8"));
    assert.ok(output.safetyViolation, `expected safetyViolation in output: ${JSON.stringify(output)}`);
    assert.equal(output.safetyViolation.id, "rm-rf");
    assert.match(output.safetyViolation.command, /rm -rf \/tmp\/harness-sentinel/);
    assert.equal(output.returncode, 1);
    assert.match(output.stderr, /SAFETY VIOLATION/);
    // The "should not be seen" event should not appear in captured stdout.
    assert.doesNotMatch(output.stdout, /should not be seen/);
  });

  it("mirrors Codex stdout JSONL events into stream-dir chunks", () => {
    const streamWorkDir = mkdtempSync(join(tmpdir(), "harness-codex-stream-"));
    const streamFakeCodex = join(streamWorkDir, "fake-codex");
    const streamOutput = join(streamWorkDir, "out.json");
    const streamPrompt = join(streamWorkDir, "prompt.txt");
    const streamDir = join(streamWorkDir, "stream");
    writeFileSync(streamPrompt, "test prompt");
    writeFileSync(
      streamFakeCodex,
      `#!/usr/bin/env python3
import sys, json
sys.stdin.read()
events = [
  {"type": "item.completed", "item": {"type": "command_execution", "command": "echo hi", "output": "hi"}},
  {"type": "item.completed", "item": {"type": "agent_message", "text": "done"}},
  {"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 2, "cached_input_tokens": 1}},
]
for event in events:
    sys.stdout.write(json.dumps(event) + "\\n")
    sys.stdout.flush()
`,
    );
    chmodSync(streamFakeCodex, 0o755);

    try {
      const result = spawnSync(
        "python3",
        [RUNNER, streamOutput, "--timeout", "20", "--stream-dir", streamDir, "--prompt-file", streamPrompt],
        {
          env: {
            ...process.env,
            CODEX_CLI_PATH: streamFakeCodex,
            HARNESS_ROOT,
          },
          timeout: 15000,
        },
      );

      assert.equal(result.status, 0, `runner exited ${result.status}: ${result.stderr?.toString()}`);
      const output = JSON.parse(readFileSync(streamOutput, "utf-8"));
      assert.equal(output.returncode, 0);
      const chunk1 = JSON.parse(readFileSync(join(streamDir, "chunk-1.json"), "utf-8"));
      const chunk2 = JSON.parse(readFileSync(join(streamDir, "chunk-2.json"), "utf-8"));
      const chunk3 = JSON.parse(readFileSync(join(streamDir, "chunk-3.json"), "utf-8"));
      assert.equal(chunk1.item.type, "command_execution");
      assert.equal(chunk2.item.type, "agent_message");
      assert.equal(chunk3.type, "turn.completed");
    } finally {
      rmSync(streamWorkDir, { recursive: true, force: true });
    }
  });
});
