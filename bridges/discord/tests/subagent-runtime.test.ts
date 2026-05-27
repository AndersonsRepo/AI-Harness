import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ChildProcess } from "child_process";
import { getDb } from "../db.js";
import { clearChannelConfig, setChannelConfig } from "../channel-config-store.js";
import { clearSession } from "../session-store.js";
import { deleteProject } from "../project-manager.js";
import { get } from "../process-registry.js";
import { setSubagentSpawnProcessForTests, spawnSubagent } from "../subagent-manager.js";
import {
  runRuntimeInvocation,
  setRuntimeInvocationSpawnProcessForTests,
  setRuntimeKillForTests,
  startRuntimeInvocation,
  type RuntimeInvocationInput,
} from "../runtime-invocation.js";
import type { AgentRuntime } from "../agent-loader.js";
import { setAutorunMode, setAutorunModeFileForTests } from "../autorun-mode.js";

// SAFETY: the autonomous-pause test sets the autorun mode; redirect it to a temp
// file so it never freezes the live bot via the real .autorun-mode flag.
before(() => {
  setAutorunModeFileForTests(join(mkdtempSync(join(tmpdir(), "sa-test-")), ".autorun-mode"));
});
after(() => setAutorunModeFileForTests(null));

interface SpawnCall {
  command: string;
  args: string[];
}

function cleanupChannel(channelId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM channel_configs WHERE channel_id = ?").run(channelId);
  db.prepare("DELETE FROM subagents WHERE parent_channel_id = ?").run(channelId);
}

async function waitForSubagentStatus(id: string, status: string, timeoutMs: number = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const stored = get(id);
    if (stored?.status === status) return stored;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for subagent ${id} to reach ${status}`);
}

describe("Subagent Manager — Mixed Runtime Dispatch", () => {
  const channelId = "subagent-runtime-codex";
  const spawnCalls: SpawnCall[] = [];

  beforeEach(() => {
    spawnCalls.length = 0;
    setSubagentSpawnProcessForTests(((command: string, args: readonly string[]) => {
      const callArgs = [...args].map(String);
      spawnCalls.push({ command, args: callArgs });

      const outputFile = callArgs[1];
      setTimeout(() => {
        writeFileSync(outputFile, JSON.stringify({
          stdout: '{"type":"thread","thread_id":"subagent-thread-123"}\n{"type":"message","content":"Codex subagent complete"}\n',
          stderr: "",
          returncode: 0,
          threadId: "subagent-thread-123",
          lastMessage: "Codex subagent complete",
        }));
      }, 25);

      return {
        pid: 4401,
        unref() {},
      } as ChildProcess;
    }) as typeof import("child_process").spawn);
  });

  afterEach(() => {
    setSubagentSpawnProcessForTests(null);
    cleanupChannel(channelId);
  });

  it("routes subagents through the explicit channel runtime and persists runtime metadata", async () => {
    setChannelConfig(channelId, { runtime: "codex", agent: "reviewer" });

    const entry = await spawnSubagent({
      channelId,
      description: "Verify the builder output",
    });

    assert.ok(entry);
    assert.equal(spawnCalls[0]?.args[0].endsWith("codex-runner.py"), true);
    assert.ok(spawnCalls[0]?.args.includes("--prompt-file"));
    assert.equal(entry?.runtime, "codex");

    await new Promise((resolve) => setTimeout(resolve, 75));
    const stored = entry ? get(entry.id) : null;
    assert.equal(stored?.runtime, "codex");
  });

  it("reroutes Claude usage-limit failures to the next subagent runtime", async () => {
    spawnCalls.length = 0;
    setChannelConfig(channelId, { runtime: "claude", agent: "ops" });
    setSubagentSpawnProcessForTests(((command: string, args: readonly string[]) => {
      const callArgs = [...args].map(String);
      spawnCalls.push({ command, args: callArgs });

      const outputFile = callArgs[1];
      const isCodex = callArgs[0]?.endsWith("codex-runner.py");
      const payload = isCodex
        ? {
            stdout: '{"type":"thread","thread_id":"subagent-fallback-thread"}\n{"type":"message","content":"Codex subagent fallback complete"}\n',
            stderr: "",
            returncode: 0,
            threadId: "subagent-fallback-thread",
            lastMessage: "Codex subagent fallback complete",
          }
        : {
            stdout: JSON.stringify({
              type: "result",
              is_error: true,
              api_error_status: 403,
              result: "API Error: monthly usage limit reached",
            }),
            stderr: "",
            returncode: 1,
          };

      setTimeout(() => {
        writeFileSync(outputFile, JSON.stringify(payload));
      }, 25);

      return {
        pid: isCodex ? 4403 : 4402,
        unref() {},
      } as ChildProcess;
    }) as typeof import("child_process").spawn);

    const entry = await spawnSubagent({
      channelId,
      description: "Verify fallback handling",
    });

    assert.ok(entry);
    const stored = await waitForSubagentStatus(entry!.id, "completed");
    assert.equal(spawnCalls.length, 2);
    assert.equal(spawnCalls[0]?.args[0].endsWith("claude-runner.py"), true);
    assert.equal(spawnCalls[1]?.args[0].endsWith("codex-runner.py"), true);
    assert.equal(stored?.runtime, "codex");
  });
});

/**
 * Phase D — the first live flip behind HARNESS_RENDER_CONTEXT.
 *
 * Proves the subagent workflow drives the rendered path (renderContext) end-to-
 * end when the flag selects it, and — the load-bearing assertion — that the
 * rendered SpawnArgs are byte-identical to the legacy (flag off) path for the
 * same input. Because the spawn args match, every downstream behavior (runner,
 * output parsing, session, telemetry from the same envelope) is unchanged; the
 * flip is reversible by env alone.
 *
 * Two per-spawn nondeterminism sources are normalized before comparison: the
 * random output/stream/prompt paths (read back from the returned handle) and
 * the taskId (distinct per run, normalized out — it only seeds the MCP config
 * filename). The toggled HARNESS_RENDER_CONTEXT itself leaks into the child env
 * via buildClaudeConfig's `...process.env`, so it is stripped from the compare.
 */
describe("Phase D — subagent rendered path (HARNESS_RENDER_CONTEXT)", () => {
  const channelId = "phase-d-render-subagent";
  let prevFlag: string | undefined;

  interface CapturedSpawn {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  }

  function installSpawnCapture(captured: CapturedSpawn[], envelope: unknown): void {
    setRuntimeInvocationSpawnProcessForTests(((command: string, args: readonly string[], opts: any) => {
      const callArgs = [...args].map(String);
      captured.push({
        command,
        args: callArgs,
        cwd: opts?.cwd,
        env: (opts?.env ?? {}) as Record<string, string>,
      });
      const outputFile = callArgs[1];
      setTimeout(() => writeFileSync(outputFile, JSON.stringify(envelope)), 10);
      return { pid: 5500, unref() {} } as ChildProcess;
    }) as typeof import("child_process").spawn);
  }

  function normalize(
    spawn: CapturedSpawn,
    handle: { outputFile: string; streamDir: string; promptFile: string | null },
    taskId: string,
  ): CapturedSpawn {
    const replace = (s: string): string =>
      s
        .split(handle.outputFile).join("<OUT>")
        .split(handle.streamDir).join("<STREAM>")
        .split(handle.promptFile ?? "__no_prompt_file__").join("<PROMPT>")
        .split(taskId).join("<TASK>");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(spawn.env)) {
      if (k === "HARNESS_RENDER_CONTEXT") continue; // test-control var, not part of the contract
      env[k] = replace(String(v));
    }
    return { command: spawn.command, args: spawn.args.map(replace), cwd: spawn.cwd, env };
  }

  const claudeEnvelope = {
    stdout:
      '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}\n' +
      '{"type":"result","is_error":false,"result":"subagent done","session_id":"sess-phase-d"}\n',
    stderr: "",
    returncode: 0,
  };

  const codexEnvelope = {
    stdout:
      '{"type":"thread","thread_id":"thread-phase-d"}\n' +
      '{"type":"message","content":"codex subagent done"}\n',
    stderr: "",
    returncode: 0,
    threadId: "thread-phase-d",
    lastMessage: "codex subagent done",
  };

  function subagentInput(runtime: AgentRuntime, taskId: string): RuntimeInvocationInput {
    return {
      channelId,
      prompt: "Verify the builder output",
      agentName: "reviewer", // explicit agent → profile.name == legacy agentName (no divergence)
      runtime,
      sessionKey: channelId,
      taskId,
      outputPrefix: `phase-d-${runtime}`,
      skipSessionResume: true,
      workflowKind: "subagent",
      requireResponse: true,
    };
  }

  beforeEach(() => {
    prevFlag = process.env.HARNESS_RENDER_CONTEXT;
  });

  afterEach(() => {
    setRuntimeInvocationSpawnProcessForTests(null);
    clearChannelConfig(channelId);
    deleteProject(channelId);
    clearSession(channelId, "claude");
    clearSession(channelId, "codex");
    if (prevFlag === undefined) delete process.env.HARNESS_RENDER_CONTEXT;
    else process.env.HARNESS_RENDER_CONTEXT = prevFlag;
  });

  it("flag=subagent renders the claude path end-to-end (response + session)", async () => {
    process.env.HARNESS_RENDER_CONTEXT = "subagent";
    const captured: CapturedSpawn[] = [];
    installSpawnCapture(captured, claudeEnvelope);

    const handle = await startRuntimeInvocation(subagentInput("claude", "phase-d-claude-live"));
    const result = await handle.result;

    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.command, "python3");
    assert.equal(captured[0]?.args[0]?.endsWith("claude-runner.py"), true);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.responseText, "subagent done");
    assert.equal(result.ok && result.sessionId, "sess-phase-d");
  });

  it("flag=subagent produces SpawnArgs identical to legacy (off) for the same input", async () => {
    // Legacy baseline (flag off).
    delete process.env.HARNESS_RENDER_CONTEXT;
    const legacyCap: CapturedSpawn[] = [];
    installSpawnCapture(legacyCap, claudeEnvelope);
    const legacyHandle = await startRuntimeInvocation(subagentInput("claude", "phase-d-off"));
    await legacyHandle.result;

    // Rendered (flag subagent).
    process.env.HARNESS_RENDER_CONTEXT = "subagent";
    const renderCap: CapturedSpawn[] = [];
    installSpawnCapture(renderCap, claudeEnvelope);
    const renderHandle = await startRuntimeInvocation(subagentInput("claude", "phase-d-rendered"));
    await renderHandle.result;

    assert.deepEqual(
      normalize(renderCap[0]!, renderHandle, "phase-d-rendered"),
      normalize(legacyCap[0]!, legacyHandle, "phase-d-off"),
    );
  });

  it("flag=subagent renders the codex path (codex-runner.py + --prompt-file)", async () => {
    process.env.HARNESS_RENDER_CONTEXT = "subagent";
    const captured: CapturedSpawn[] = [];
    installSpawnCapture(captured, codexEnvelope);

    const handle = await startRuntimeInvocation(subagentInput("codex", "phase-d-codex-live"));
    const result = await handle.result;

    assert.equal(captured[0]?.args[0]?.endsWith("codex-runner.py"), true);
    assert.ok(captured[0]?.args.includes("--prompt-file"));
    assert.equal(result.ok, true);
  });

  it("shadow mode leaves the actual spawn on the legacy args (observational only)", async () => {
    // Off baseline.
    delete process.env.HARNESS_RENDER_CONTEXT;
    const offCap: CapturedSpawn[] = [];
    installSpawnCapture(offCap, claudeEnvelope);
    const offHandle = await startRuntimeInvocation(subagentInput("claude", "phase-d-shadow-off"));
    await offHandle.result;

    // Shadow: builds both, diff-logs, but must spawn with the legacy args.
    process.env.HARNESS_RENDER_CONTEXT = "shadow";
    const shadowCap: CapturedSpawn[] = [];
    installSpawnCapture(shadowCap, claudeEnvelope);
    const shadowHandle = await startRuntimeInvocation(subagentInput("claude", "phase-d-shadow-on"));
    await shadowHandle.result;

    assert.deepEqual(
      normalize(shadowCap[0]!, shadowHandle, "phase-d-shadow-on"),
      normalize(offCap[0]!, offHandle, "phase-d-shadow-off"),
    );
  });
});

/**
 * Orphan-reaper forward-fix: a spawn that hangs past its timeout must have its
 * process group killed (ERR-orphaned-agent-spawns-survive-timeout), not just
 * abandoned. Verifies onTimeout calls the (injected) killer with the child pid.
 */
describe("runtime-invocation — timeout kills the wedged spawn's process group", () => {
  const channelId = "phase-d-timeout-kill";

  afterEach(() => {
    setRuntimeInvocationSpawnProcessForTests(null);
    setRuntimeKillForTests(null);
  });

  it("kills the spawned pid on timeout (SIGTERM) and resolves as timeout", async () => {
    const killed: { pid: number; signal: string }[] = [];
    setRuntimeKillForTests((pid, signal) => killed.push({ pid, signal: String(signal) }));

    // A child that NEVER writes its output file → forces the watcher to time out.
    setRuntimeInvocationSpawnProcessForTests(((() => {
      return { pid: 7777, unref() {} } as ChildProcess;
    }) as unknown) as typeof import("child_process").spawn);

    const result = await runRuntimeInvocation({
      channelId,
      prompt: "hang forever",
      agentName: "reviewer",
      runtime: "claude",
      sessionKey: channelId,
      taskId: "phase-d-timeout-kill-task",
      timeoutMs: 150,
      skipSessionResume: true,
      workflowKind: "subagent",
    });

    assert.equal(result.ok, false);
    assert.equal((result as any).reason, "timeout");
    assert.deepEqual(killed, [{ pid: 7777, signal: "SIGTERM" }]);
  });
});

/**
 * Autorun kill-switch: when autonomous AI is paused (control panel), the
 * autonomous-chain chokepoint must refuse to spawn — without ever launching a
 * process — and resolve as a terminal failure so callers stop cleanly.
 */
describe("runtime-invocation — autonomous pause gates the spawn", () => {
  afterEach(() => {
    setRuntimeInvocationSpawnProcessForTests(null);
    setAutorunMode("normal");
  });

  it("refuses to spawn while autonomous is paused", async () => {
    let spawned = false;
    setRuntimeInvocationSpawnProcessForTests(((() => {
      spawned = true;
      return { pid: 4242, unref() {} } as ChildProcess;
    }) as unknown) as typeof import("child_process").spawn);

    setAutorunMode("autonomous");

    const result = await runRuntimeInvocation({
      channelId: "phase-d-paused",
      prompt: "should not run",
      agentName: "reviewer",
      runtime: "claude",
      sessionKey: "phase-d-paused",
      taskId: "phase-d-paused-task",
      skipSessionResume: true,
      workflowKind: "subagent",
    });

    assert.equal(result.ok, false);
    assert.equal(spawned, false, "must not spawn a process while paused");
  });
});
