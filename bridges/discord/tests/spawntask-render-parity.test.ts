// Phase F gate: the general-chat path (task-runner.spawnTask) under the
// HARNESS_RENDER_CONTEXT flag.
//
// Two things to lock:
//  1. DISPATCH — resolveSpawnArgs (which spawnTask now delegates to) picks the
//     rendered vs legacy path correctly per flag value. Tested deterministically
//     with a fake adapter returning sentinel SpawnArgs — no DB, no ambient
//     context, no flakiness.
//  2. INTEGRATION — spawnTask under flag=chat drives the REAL rendered path to a
//     valid claude spawn, and continuation reuses the provided stream dir.
//
// NOTE: a full off-vs-chat deep-equal of spawnTask's args is intentionally NOT
// done here. The args include the `--append-system-prompt` ambient context
// (assembleContext), which is time/DB-dependent — two sequential spawns see
// different task history, so a sequential compare is inherently flaky. The
// same-instant args parity (incl. ambient context) is already proven by
// tests/runtime-render-parity.test.ts, which builds both from ONE context.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "child_process";
import { getDb } from "../db.js";
import { clearSession } from "../session-store.js";
import { submitTask, spawnTask, setSpawnProcessForTests } from "../task-runner.js";
import { stopAllWatchers } from "../file-watcher.js";
import { resolveSpawnArgs, type RuntimeInvocationInput } from "../runtime-invocation.js";
import type { RuntimeAdapter, SpawnArgs, RenderSpawnMeta } from "../runtime-adapter.js";

// ─── Dispatch (deterministic, no DB) ────────────────────────────────────────

const LEGACY: SpawnArgs = { pythonArgs: ["LEGACY"], cwd: "/x", env: {}, promptFilePath: null };
const RENDERED: SpawnArgs = { pythonArgs: ["RENDERED"], cwd: "/x", env: {}, promptFilePath: null };

function fakeAdapter(withRenderContext: boolean): RuntimeAdapter {
  const a: any = {
    tag: "claude",
    capabilities: { continuation: true, loopDetection: true, transientErrorRetry: true, sessionResume: true, streamingTelemetry: true },
    buildSpawnArgs: async () => LEGACY,
  };
  if (withRenderContext) a.renderContext = async () => RENDERED;
  return a as RuntimeAdapter;
}

const dispatchInput: RuntimeInvocationInput = {
  channelId: "dispatch-test",
  prompt: "hi",
  agentName: null,
  runtime: "claude",
  sessionKey: "dispatch-test",
  workflowKind: "chat",
};
const dispatchSpawn: RenderSpawnMeta = { outputFile: "/tmp/dispatch-out.json" };

async function dispatch(flag: string | undefined, withRenderContext = true): Promise<string> {
  const prev = process.env.HARNESS_RENDER_CONTEXT;
  if (flag === undefined) delete process.env.HARNESS_RENDER_CONTEXT;
  else process.env.HARNESS_RENDER_CONTEXT = flag;
  try {
    const args = await resolveSpawnArgs(fakeAdapter(withRenderContext), dispatchInput, "dispatch-task", dispatchSpawn);
    return args.pythonArgs[0]!; // "LEGACY" | "RENDERED"
  } finally {
    if (prev === undefined) delete process.env.HARNESS_RENDER_CONTEXT;
    else process.env.HARNESS_RENDER_CONTEXT = prev;
  }
}

describe("resolveSpawnArgs — chat dispatch (the gate spawnTask now flows through)", () => {
  it("off / unset → legacy buildSpawnArgs", async () => {
    assert.equal(await dispatch(undefined), "LEGACY");
    assert.equal(await dispatch("off"), "LEGACY");
  });

  it("chat → rendered path", async () => {
    assert.equal(await dispatch("chat"), "RENDERED");
  });

  it("all → rendered path", async () => {
    assert.equal(await dispatch("all"), "RENDERED");
  });

  it("a non-chat selection (subagent) leaves the chat workflow on legacy", async () => {
    assert.equal(await dispatch("subagent"), "LEGACY");
  });

  it("shadow → spawns on legacy args (observational only)", async () => {
    assert.equal(await dispatch("shadow"), "LEGACY");
  });

  it("chat but adapter has no renderContext → legacy (future runtimes)", async () => {
    assert.equal(await dispatch("chat", /* withRenderContext */ false), "LEGACY");
  });
});

// ─── spawnTask integration (real rendered path) ─────────────────────────────

const CHANNEL = "spawntask-render-parity";

interface CapturedSpawn {
  command: string;
  args: string[];
}

function installCapture(captured: CapturedSpawn[]): void {
  setSpawnProcessForTests(((command: string, args: readonly string[]) => {
    captured.push({ command, args: [...args].map(String) });
    // No output file written → FileWatcher never fires; we only need the args.
    return { pid: 6200, unref() {} } as ChildProcess;
  }) as typeof import("child_process").spawn);
}

function clear(): void {
  getDb().prepare("DELETE FROM task_queue WHERE channel_id = ?").run(CHANNEL);
  clearSession(CHANNEL, "claude");
}

describe("spawnTask under HARNESS_RENDER_CONTEXT=chat", () => {
  let prevFlag: string | undefined;

  beforeEach(() => {
    prevFlag = process.env.HARNESS_RENDER_CONTEXT;
    clear();
  });

  afterEach(() => {
    setSpawnProcessForTests(null);
    stopAllWatchers();
    clear();
    if (prevFlag === undefined) delete process.env.HARNESS_RENDER_CONTEXT;
    else process.env.HARNESS_RENDER_CONTEXT = prevFlag;
  });

  it("drives the real rendered path to a valid claude spawn (no error, claude-runner.py)", async () => {
    process.env.HARNESS_RENDER_CONTEXT = "chat";
    const cap: CapturedSpawn[] = [];
    installCapture(cap);
    const id = submitTask({ channelId: CHANNEL, channelName: "general", prompt: "hello world", runtime: "claude" });
    const handle = await spawnTask(id);
    assert.ok(handle, "spawnTask returned a handle under the chat flag");
    assert.equal(cap.length, 1, "exactly one spawn");
    assert.equal(cap[0]?.args[0]?.endsWith("claude-runner.py"), true, "rendered chat path still spawns claude-runner.py");
    assert.ok(cap[0]!.args.includes("--append-system-prompt"), "ambient context still injected");
  });

  it("continuation reuses the provided stream dir (spawn-meta, unchanged by the flag)", async () => {
    process.env.HARNESS_RENDER_CONTEXT = "chat";
    const cap: CapturedSpawn[] = [];
    installCapture(cap);
    const id = submitTask({ channelId: CHANNEL, prompt: "continue please", runtime: "claude" });
    const reuseDir = "/tmp/spawntask-reuse-streamdir";
    const handle = await spawnTask(id, { reuseStreamDir: reuseDir });
    assert.ok(handle);
    assert.equal(handle!.streamDir, reuseDir, "returned streamDir is the reused dir");
    const i = cap[0]!.args.indexOf("--stream-dir");
    assert.ok(i >= 0, "--stream-dir present in runner args");
    assert.equal(cap[0]!.args[i + 1], reuseDir, "runner told to stream into the reused dir");
  });
});
