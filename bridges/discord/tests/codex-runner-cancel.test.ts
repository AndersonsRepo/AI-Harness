import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const HARNESS_ROOT = "/Users/andersonedmond/Desktop/AI-Harness-private-runtime";
const RUNNER = join(HARNESS_ROOT, "bridges/discord/codex-runner.py");

// Fake codex that emits one event then sleeps. Long enough that the test
// can SIGTERM the runner mid-flight.
function makeSlowFakeCodex(workDir: string): string {
  const fakePath = join(workDir, "fake-codex");
  const script = `#!/usr/bin/env python3
import sys, json, time

# Drain stdin so the runner's stdin.write/close doesn't fight us
try:
    sys.stdin.buffer.read()
except Exception:
    pass

# Emit one harmless event so the runner's read loop has activity
sys.stdout.write(json.dumps({"msg": {"type": "agent_message", "text": "starting"}}) + "\\n")
sys.stdout.flush()

# Sleep long enough that the test can SIGTERM the runner before we exit.
time.sleep(60)
sys.exit(0)
`;
  writeFileSync(fakePath, script);
  chmodSync(fakePath, 0o755);
  return fakePath;
}

function waitForExit(proc: ReturnType<typeof spawn>, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runner did not exit within ${timeoutMs}ms`)), timeoutMs);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("codex-runner SIGTERM cancellation", () => {
  let workDir: string;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "codex-cancel-"));
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // Helper: spawn the runner with detached:true so it gets its own process
  // group, then kill the whole group via negative PID. This mirrors what
  // platform.ts terminate() does post-commit-6b9c3e5 (Stage 1 group kill)
  // — the child fake-codex dies first, the runner's read loop returns,
  // and only THEN does the signal handler fire and write the envelope.
  // Direct PID kill alone doesn't work because Python signal handlers
  // can't interrupt a blocked `for line in proc.stdout` read.
  function spawnRunnerDetached(args: string[], env: NodeJS.ProcessEnv) {
    return spawn("python3", args, {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function killGroup(pid: number, signal: NodeJS.Signals) {
    process.kill(-pid, signal);
  }

  it("writes a cancelled envelope when SIGTERM arrives during an in-flight spawn", async () => {
    const fakePath = makeSlowFakeCodex(workDir);
    const outFile = join(workDir, "out.json");

    const proc = spawnRunnerDetached([
      RUNNER,
      outFile,
      "--prompt-file", "/dev/null",
      "--timeout", "120",
    ], {
      ...process.env,
      HARNESS_ROOT,
      CODEX_CLI_PATH: fakePath,
    });

    await sleep(800);
    killGroup(proc.pid!, "SIGTERM");

    const exitCode = await waitForExit(proc, 5000);
    assert.equal(exitCode, 143, "runner should exit 143 (128+SIGTERM)");

    assert.ok(existsSync(outFile), "output file should exist after cancel");
    const envelope = JSON.parse(readFileSync(outFile, "utf-8"));
    assert.equal(envelope.cancelled, true, "envelope.cancelled should be true");
    assert.equal(envelope.returncode, 143, "envelope.returncode should be 143");
    assert.match(envelope.stderr, /cancelled by signal 15/, "stderr should mention signal 15");
  });

  it("writes a cancelled envelope on SIGINT (ctrl-c) too", async () => {
    const fakePath = makeSlowFakeCodex(workDir);
    const outFile = join(workDir, "out-sigint.json");

    const proc = spawnRunnerDetached([
      RUNNER,
      outFile,
      "--prompt-file", "/dev/null",
      "--timeout", "120",
    ], {
      ...process.env,
      HARNESS_ROOT,
      CODEX_CLI_PATH: fakePath,
    });

    await sleep(800);
    killGroup(proc.pid!, "SIGINT");

    const exitCode = await waitForExit(proc, 5000);
    assert.equal(exitCode, 130, "runner should exit 130 (128+SIGINT)");

    const envelope = JSON.parse(readFileSync(outFile, "utf-8"));
    assert.equal(envelope.cancelled, true);
    assert.equal(envelope.returncode, 130);
  });
});
