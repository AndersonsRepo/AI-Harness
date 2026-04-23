import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { safetyPatternsJson } from "../safety.js";

const HARNESS_ROOT = "/Users/andersonedmond/Desktop/AI-Harness-private-runtime";
const RUNNER = join(HARNESS_ROOT, "bridges/discord/codex-runner.py");

// Fake codex that increments a counter file alongside itself, then either
// emits a transient HTTP 429 (attempts 1..N-1) or a success message (final).
// `MODE` arg switches between "transient-then-success" and "always-destructive".
function makeFakeCodex(workDir: string, mode: "transient-then-success" | "always-destructive"): string {
  const fakePath = join(workDir, "fake-codex");
  const counterPath = join(workDir, "_attempt");
  const script = `#!/usr/bin/env python3
import sys, os, json, time

counter_path = ${JSON.stringify(counterPath)}
n = 0
try:
    with open(counter_path) as f:
        n = int(f.read().strip() or "0")
except Exception:
    pass
with open(counter_path, "w") as f:
    f.write(str(n + 1))

# Drain stdin so the runner's stdin.write/close doesn't fight us
try:
    sys.stdin.buffer.read()
except Exception:
    pass

mode = ${JSON.stringify(mode)}
if mode == "transient-then-success":
    if n == 0:
        sys.stderr.write("Error: HTTP 429 Too Many Requests — rate limit exceeded\\n")
        sys.stderr.flush()
        sys.exit(1)
    # Success on retry. Emit a final agent message event.
    sys.stdout.write(json.dumps({"msg": {"type": "agent_message", "text": "ok-after-retry"}}) + "\\n")
    sys.stdout.flush()
    sys.exit(0)
elif mode == "always-destructive":
    # Always emit a destructive command on first event. Should never be retried.
    sys.stdout.write(json.dumps({"msg": {"type": "exec_command", "command": "rm -rf /tmp/should-be-blocked"}}) + "\\n")
    sys.stdout.flush()
    time.sleep(2)
    sys.exit(0)
`;
  writeFileSync(fakePath, script);
  chmodSync(fakePath, 0o755);
  return fakePath;
}

describe("codex-runner retry-with-backoff", () => {
  let workDir: string;
  let promptFile: string;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "harness-codex-retry-"));
    promptFile = join(workDir, "prompt.txt");
    writeFileSync(promptFile, "test prompt");
  });

  after(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("retries a transient 429 then reports success on the second attempt", () => {
    const subDir = mkdtempSync(join(tmpdir(), "harness-codex-retry-ok-"));
    const fakeCodex = makeFakeCodex(subDir, "transient-then-success");
    const counterPath = join(subDir, "_attempt");
    const outputFile = join(subDir, "out.json");

    try {
      const result = spawnSync(
        "python3",
        [RUNNER, outputFile, "--timeout", "20", "--prompt-file", promptFile],
        {
          env: {
            ...process.env,
            CODEX_CLI_PATH: fakeCodex,
            CODEX_SAFETY_PATTERNS: safetyPatternsJson(),
            CODEX_RETRY_DELAYS: JSON.stringify([0, 0, 0]),
            HARNESS_ROOT,
          },
          timeout: 15000,
        },
      );

      assert.equal(result.status, 0, `runner exited ${result.status}: ${result.stderr?.toString()}`);
      const output = JSON.parse(readFileSync(outputFile, "utf-8"));
      assert.equal(output.returncode, 0, `expected returncode 0 after retry, got ${output.returncode}`);
      assert.equal(output.safetyViolation, undefined, "no safetyViolation should be set on a transient retry");
      assert.equal(output.lastMessage, "ok-after-retry", `expected retry success message, got ${output.lastMessage}`);

      // Confirm the runner actually ran codex twice (1 transient fail + 1 success).
      assert.ok(existsSync(counterPath), "counter file should exist");
      const attempts = parseInt(readFileSync(counterPath, "utf-8").trim(), 10);
      assert.equal(attempts, 2, `expected 2 codex invocations (1 transient + 1 retry success), got ${attempts}`);

      // Stderr from the runner should mention the retry path.
      assert.match(
        result.stderr?.toString() || "",
        /Transient error \(attempt 1\/4\)/,
        "runner stderr should log the retry decision",
      );
    } finally {
      rmSync(subDir, { recursive: true, force: true });
    }
  });

  it("does not retry safety violations — kills + reports on first attempt", () => {
    const subDir = mkdtempSync(join(tmpdir(), "harness-codex-retry-safety-"));
    const fakeCodex = makeFakeCodex(subDir, "always-destructive");
    const counterPath = join(subDir, "_attempt");
    const outputFile = join(subDir, "out.json");

    try {
      const result = spawnSync(
        "python3",
        [RUNNER, outputFile, "--timeout", "20", "--prompt-file", promptFile],
        {
          env: {
            ...process.env,
            CODEX_CLI_PATH: fakeCodex,
            CODEX_SAFETY_PATTERNS: safetyPatternsJson(),
            CODEX_RETRY_DELAYS: JSON.stringify([0, 0, 0]),
            HARNESS_ROOT,
          },
          timeout: 15000,
        },
      );

      assert.equal(result.status, 0, `runner exited ${result.status}: ${result.stderr?.toString()}`);
      const output = JSON.parse(readFileSync(outputFile, "utf-8"));
      assert.ok(output.safetyViolation, `expected safetyViolation: ${JSON.stringify(output)}`);
      assert.equal(output.safetyViolation.id, "rm-rf");
      assert.equal(output.returncode, 1);

      // The retry loop must NOT spawn a second codex on a safety hit.
      const attempts = parseInt(readFileSync(counterPath, "utf-8").trim(), 10);
      assert.equal(attempts, 1, `safety violation must be terminal — expected 1 invocation, got ${attempts}`);
    } finally {
      rmSync(subDir, { recursive: true, force: true });
    }
  });
});
