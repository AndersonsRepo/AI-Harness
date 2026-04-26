// Mirror of codex-runner-cancel.test.ts for claude-runner.py.
// Verifies SIGTERM/SIGINT during an in-flight non-streaming spawn produces
// a cancellation envelope on disk and exits 143/130.
//
// Streaming-mode (--stream-dir) cancel behavior is not exercised here; the
// signal handler is registered before mode-branching so streaming mode
// should behave identically. If we ever want explicit streaming-mode test
// coverage, mirror this file with a fake claude that emits stream-json.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const HARNESS_ROOT = "/Users/andersonedmond/Desktop/AI-Harness-private-runtime";
const RUNNER = join(HARNESS_ROOT, "bridges/discord/claude-runner.py");

// Fake claude that emits one valid stream-json line then sleeps 60s.
// Shape mirrors what real claude --output-format json produces enough
// for the runner's read loop to make at least one iteration before
// being interrupted.
function makeSlowFakeClaude(workDir: string): string {
  const fakePath = join(workDir, "fake-claude");
  const script = `#!/usr/bin/env python3
import sys, json, time

# Drain any positional args without acting on them — the test's claude_args
# mirror what claude-config.ts produces in production.
try:
    sys.stdin.buffer.read()
except Exception:
    pass

# Emit something so the runner's pipe has activity, then sleep until
# we're killed.
sys.stdout.write(json.dumps({"type": "system", "subtype": "init"}) + "\\n")
sys.stdout.flush()
time.sleep(60)
`;
  writeFileSync(fakePath, script);
  chmodSync(fakePath, 0o755);
  return fakePath;
}

function waitForExit(proc: ReturnType<typeof spawn>, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`runner did not exit within ${timeoutMs}ms`)),
      timeoutMs,
    );
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("claude-runner SIGTERM cancellation (non-streaming)", () => {
  let workDir: string;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "claude-cancel-"));
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // Spawn detached:true (own process group) so we can group-kill via
  // negative PID, mirroring what platform.ts terminate() does in production
  // post-commit-6b9c3e5. See codex-runner-cancel.test.ts for the longer
  // explanation of why direct-pid kill alone doesn't work — Python signal
  // handlers can't interrupt a blocked stdin/stdout read.
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
    const fakePath = makeSlowFakeClaude(workDir);
    const outFile = join(workDir, "out.json");

    // Non-streaming path: no --stream-dir. Pass `-p` so the fake gets
    // realistic args; the fake ignores them.
    const proc = spawnRunnerDetached([
      RUNNER,
      outFile,
      "--timeout", "120",
      "-p",
      "--output-format", "json",
    ], {
      ...process.env,
      HARNESS_ROOT,
      CLAUDE_CLI_PATH: fakePath,
    });

    // 2s startup window — see codex-runner-cancel.test.ts for the rationale.
    await sleep(2000);
    killGroup(proc.pid!, "SIGTERM");

    const exitCode = await waitForExit(proc, 5000);
    assert.equal(exitCode, 143, "runner should exit 143 (128+SIGTERM)");

    assert.ok(existsSync(outFile), "output file should exist after cancel");
    const envelope = JSON.parse(readFileSync(outFile, "utf-8"));
    assert.equal(envelope.cancelled, true, "envelope.cancelled should be true");
    assert.equal(envelope.returncode, 143, "envelope.returncode should be 143");
    assert.match(envelope.stderr, /cancelled by signal 15/);
  });

  it("writes a cancelled envelope on SIGINT (ctrl-c) too", async () => {
    const fakePath = makeSlowFakeClaude(workDir);
    const outFile = join(workDir, "out-sigint.json");

    const proc = spawnRunnerDetached([
      RUNNER,
      outFile,
      "--timeout", "120",
      "-p",
      "--output-format", "json",
    ], {
      ...process.env,
      HARNESS_ROOT,
      CLAUDE_CLI_PATH: fakePath,
    });

    await sleep(2000);
    killGroup(proc.pid!, "SIGINT");

    const exitCode = await waitForExit(proc, 5000);
    assert.equal(exitCode, 130);

    const envelope = JSON.parse(readFileSync(outFile, "utf-8"));
    assert.equal(envelope.cancelled, true);
    assert.equal(envelope.returncode, 130);
  });
});
